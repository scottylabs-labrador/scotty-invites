import { initServer } from "@ts-rest/fastify";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  contract,
  MAX_CUSTOM_QUESTIONS,
  type QuestionControls,
  type BrowseEvent,
  type EventDetail,
  type TicketView,
  type Stub,
  type GuestRow,
  type PendingItem,
  type Dashboard,
  type AdminRow,
  type OrgEventQuestion,
} from "@scottylabs-invites/contract";
import { db, schema } from "../db/client";
import { env, isCmuEmail } from "../env";
import { answerText, loadAnswers } from "../lib/answers";
import { initialsOf, safeEqual } from "../lib/crypto";
import { fmtStubDate } from "../lib/format";
import { sendMail } from "../lib/mail";
import { adminInviteEmail, plusOneInviteEmail } from "../lib/emails";
import { startAuth, verifyByCode, meFor, revokeSession, type AuthContext } from "../auth/service";
import {
  createRegistration,
  approveRegistration,
  declineRegistration,
  cancelRegistration,
  claimTransfer,
  checkinBySerial,
  approvedCount,
  promoteWaitlist,
  waitlistToPending,
  lockEvent,
} from "../services/registrations";
import { ensureTransfer, revokeTransfer, parseTransferToken, transferUrl } from "../services/transfers";
import { getQuestionControls, setQuestionControl } from "../services/settings";
import { newShortCode, newToken, newInviteCode } from "../lib/crypto";

const s = initServer();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ctxOf(request: FastifyRequest): AuthContext | null {
  return (request as FastifyRequest & { authCtx: AuthContext | null }).authCtx ?? null;
}

const SESSION_COOKIE = "sl_invites_session";

export function setSessionCookie(reply: FastifyReply, token: string, persistent: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    domain: env.cookieDomain,
    ...(persistent ? { maxAge: 30 * 86400 } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/", domain: env.cookieDomain });
}

function committeeDto(c: typeof schema.committees.$inferSelect) {
  return { id: c.id, slug: c.slug, name: c.name, color: c.color, isAllClub: c.isAllClub };
}

export function deriveLocationShort(location: string, explicit?: string | null): string {
  if (explicit?.trim()) return explicit.trim();
  const cleaned = location.split(",")[0].trim();
  const m = cleaned.match(/([A-Za-z.]+)\s+(\w*\d[\w-]*)\s*$/);
  if (m) return `${m[1]} ${m[2]}`;
  return cleaned.slice(0, 22);
}

const unauthorized = { status: 401 as const, body: { error: "unauthorized", message: "Sign in to do that." } };
const forbidden = { status: 403 as const, body: { error: "forbidden", message: "You don't have access to that." } };

// --- invite-code gate ---------------------------------------------------
// Normalized (trim/lowercase), constant-time, fail-closed when the event has
// no code, and wrong guesses are rate limited per IP+event.

/** True when the supplied code unlocks the event. */
export function inviteCodeMatches(event: { inviteCode: string | null }, supplied: string | undefined | null): boolean {
  if (!event.inviteCode) return false; // fail closed — a code-less invite event admits nobody by code
  const a = (supplied ?? "").trim().toLowerCase();
  if (!a) return false;
  return safeEqual(a, event.inviteCode.trim().toLowerCase());
}

const inviteFails = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of inviteFails) if (v.resetAt < now) inviteFails.delete(k);
}, 60_000).unref();

/** Sliding gate: 20 wrong codes per IP+event per 10 minutes. */
export function inviteAttemptsExceeded(ip: string, eventId: string): boolean {
  const b = inviteFails.get(`${ip}:${eventId}`);
  return !!b && b.resetAt > Date.now() && b.count >= 20;
}

export function recordInviteFail(ip: string, eventId: string): void {
  const key = `${ip}:${eventId}`;
  const now = Date.now();
  const b = inviteFails.get(key);
  if (!b || b.resetAt < now) inviteFails.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
  else b.count += 1;
}

/** An admin of the event's own committee, or any super admin. */
export function isScopedAdminFor(ctx: AuthContext | null, committeeId: string): boolean {
  if (!ctx?.admin) return false;
  return ctx.admin.row.role === "super_admin" || ctx.admin.row.committeeId === committeeId;
}

/**
 * A live pass for this event. A claimed +1 has no registration row of its own —
 * the child ticket carries registrationId: null — so the gate has to look at
 * tickets, or the person holding the pass can't open the event it's for.
 */
export async function userHoldsTicket(eventId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.eventId, eventId), eq(schema.tickets.userId, userId), isNull(schema.tickets.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Admin scope filter: super admins see everything; committee admins see their committee. */
function scopedCommitteeIds(ctx: AuthContext): string[] | "all" {
  if (!ctx.admin) return [];
  if (ctx.admin.row.role === "super_admin") return "all";
  return [ctx.admin.row.committeeId];
}

/** Path ids arrive as raw strings; a non-uuid reaches Postgres as a cast error
 *  and surfaces as a 500. Callers treat this as "not found". */
export function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

async function loadScopedEvent(ctx: AuthContext, eventId: string) {
  if (!isUuid(eventId)) return null;
  const rows = await db
    .select({ event: schema.events, committee: schema.committees })
    .from(schema.events)
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(eq(schema.events.id, eventId));
  const row = rows[0];
  if (!row) return null;
  const scope = scopedCommitteeIds(ctx);
  if (scope !== "all" && !scope.includes(row.event.committeeId)) return "forbidden" as const;
  return row;
}

function nyDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function buildGuestRows(eventId: string): Promise<{ guests: GuestRow[]; regs: (typeof schema.registrations.$inferSelect)[] }> {
  const rows = await db
    .select({ registration: schema.registrations, user: schema.users })
    .from(schema.registrations)
    .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
    .where(eq(schema.registrations.eventId, eventId))
    .orderBy(desc(schema.registrations.createdAt));

  const regIds = rows.map((r) => r.registration.id);
  const ticketRows = regIds.length
    ? await db.select().from(schema.tickets).where(inArray(schema.tickets.registrationId, regIds))
    : [];
  const ticketByReg = new Map(ticketRows.filter((t) => !t.revokedAt).map((t) => [t.registrationId, t]));

  const primaryIds = ticketRows.map((t) => t.id);
  const claimedPlusOnes = primaryIds.length
    ? await db
        .select()
        .from(schema.tickets)
        .where(and(inArray(schema.tickets.parentTicketId, primaryIds), isNull(schema.tickets.revokedAt)))
    : [];
  const plusOneByParent = new Set(claimedPlusOnes.map((t) => t.parentTicketId));

  const fileIds = rows.map((r) => r.registration.resumeFileId).filter((x): x is string => !!x);
  const fileRows = fileIds.length
    ? await db
        .select({ id: schema.files.id, filename: schema.files.filename })
        .from(schema.files)
        .where(inArray(schema.files.id, fileIds))
    : [];
  const fileById = new Map(fileRows.map((f) => [f.id, f]));

  const answersByReg = await loadAnswers(regIds);

  /**
   * The dashboard re-fetches every 30 s and ships every guest's answers to every
   * committee admin, uncompressed. Cap what the UI needs; the CSV export carries
   * the full text.
   */
  const DASHBOARD_ANSWER_MAX = 500;

  const guests: GuestRow[] = rows.map(({ registration: r, user: u }) => {
    const ticket = ticketByReg.get(r.id);
    const file = r.resumeFileId ? fileById.get(r.resumeFileId) : undefined;
    return {
      registrationId: r.id,
      name: r.fullName,
      initials: initialsOf(r.fullName || u.email),
      andrewId: u.andrewId,
      email: u.email,
      plusOne: r.plusOne,
      plusOneClaimed: ticket ? plusOneByParent.has(ticket.id) : false,
      major: r.major,
      classYear: r.classYear,
      dietary: (r.dietary as string[]) ?? [],
      resumeUrl: file ? `${env.apiUrl}/api/files/${file.id}` : null,
      resumeFilename: file?.filename ?? null,
      source: r.source,
      status: r.status,
      serial: ticket?.serial ?? null,
      createdAt: r.createdAt.toISOString(),
      answers: (answersByReg.get(r.id) ?? []).map((a) => ({
        questionId: a.questionId,
        value: a.value.length > DASHBOARD_ANSWER_MAX ? `${a.value.slice(0, DASHBOARD_ANSWER_MAX)}…` : a.value,
        fileUrl: a.fileUrl,
        fileName: a.fileName,
      })),
    };
  });
  return { guests, regs: rows.map((r) => r.registration) };
}

/** Every question on an event, in sort order, with the answer count that locks it. */
async function orgQuestions(eventId: string): Promise<OrgEventQuestion[]> {
  const rows = await db
    .select()
    .from(schema.eventQuestions)
    .where(eq(schema.eventQuestions.eventId, eventId))
    .orderBy(asc(schema.eventQuestions.sort));
  if (rows.length === 0) return [];

  const counts = await db
    .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
    .from(schema.answers)
    .where(
      inArray(
        schema.answers.questionId,
        rows.map((q) => q.id),
      ),
    )
    .groupBy(schema.answers.questionId);
  const countById = new Map(counts.map((c) => [c.questionId, c.count]));

  return rows.map((q) => ({
    id: q.id,
    kind: q.kind,
    key: (q.key as OrgEventQuestion["key"]) ?? null,
    label: q.label,
    type: q.type,
    options: q.options ?? null,
    required: q.required,
    visible: q.visible,
    sort: q.sort,
    answerCount: countById.get(q.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export const router = s.router(contract, {
  // ------------------------------------------------------------- auth
  auth: {
    start: async ({ body, request }) => {
      const result = await startAuth({
        email: body.email,
        keepSignedIn: body.keepSignedIn ?? false,
        transferToken: body.transferToken,
        ip: request.ip,
      });
      if (result.ok) return { status: 200, body: { ok: true } };
      if (result.error === "rate_limited") return { status: 429, body: { error: result.error, message: result.message } };
      if (result.error === "mail_failed") return { status: 502, body: { error: result.error, message: result.message } };
      return { status: 400, body: { error: result.error, message: result.message } };
    },

    verify: async ({ body, reply }) => {
      const result = await verifyByCode(body.email, body.code);
      if ("error" in result) return { status: 400, body: { error: result.error, message: result.message } };
      setSessionCookie(reply, result.sessionToken, result.persistent);
      const adminRow = await import("../auth/service").then((m) => m.findAdminByEmail(result.user.email));
      return {
        status: 200,
        body: meFor({
          user: result.user,
          session: null as never,
          admin: adminRow ? { row: adminRow.admin, committee: adminRow.committee } : null,
        }),
      };
    },

    me: async ({ request }) => ({ status: 200, body: meFor(ctxOf(request)) }),

    signOut: async ({ request, reply }) => {
      await revokeSession(request.cookies?.[SESSION_COOKIE]);
      clearSessionCookie(reply);
      return { status: 200, body: { ok: true } };
    },
  },

  // ------------------------------------------------------------- events
  events: {
    list: async ({ request }) => {
      const ctx = ctxOf(request);
      const now = new Date();
      const rows = await db
        .select({ event: schema.events, committee: schema.committees })
        .from(schema.events)
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        .where(and(eq(schema.events.status, "published"), eq(schema.events.listed, true), gte(schema.events.endAt, now)))
        .orderBy(asc(schema.events.startAt));

      const eventIds = rows.map((r) => r.event.id);
      const counts = eventIds.length
        ? await db
            .select({ eventId: schema.registrations.eventId, count: sql<number>`count(*)::int` })
            .from(schema.registrations)
            .where(and(inArray(schema.registrations.eventId, eventIds), eq(schema.registrations.status, "approved")))
            .groupBy(schema.registrations.eventId)
        : [];
      const countByEvent = new Map(counts.map((c) => [c.eventId, c.count]));

      const myStatuses = new Map<string, string>();
      if (ctx && eventIds.length) {
        const mine = await db
          .select({ eventId: schema.registrations.eventId, status: schema.registrations.status })
          .from(schema.registrations)
          .where(and(inArray(schema.registrations.eventId, eventIds), eq(schema.registrations.userId, ctx.user.id)));
        for (const m of mine) myStatuses.set(m.eventId, m.status);
      }

      const events: BrowseEvent[] = rows.map(({ event: e, committee: c }) => {
        const approved = countByEvent.get(e.id) ?? 0;
        return {
          shortCode: e.shortCode,
          title: e.title,
          number: e.number,
          startAt: e.startAt.toISOString(),
          endAt: e.endAt.toISOString(),
          location: e.location,
          category: e.category as BrowseEvent["category"],
          audience: e.audience,
          model: e.model,
          capacity: e.capacity,
          approvedCount: approved,
          full: e.capacity !== null && approved >= e.capacity,
          flagship: e.flagship,
          artwork: e.artwork as BrowseEvent["artwork"],
          committee: committeeDto(c),
          description: e.description,
          myStatus: (myStatuses.get(e.id) as BrowseEvent["myStatus"]) ?? null,
        };
      });
      return { status: 200, body: { events } };
    },

    get: async ({ params, query, request }) => {
      const ctx = ctxOf(request);
      const rows = await db
        .select({ event: schema.events, committee: schema.committees })
        .from(schema.events)
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        .where(eq(schema.events.shortCode, params.code));
      const row = rows[0];
      if (!row || row.event.status === "draft") return { status: 404, body: { error: "not_found", message: "Event not found" } };
      const e = row.event;

      let myRegistration: EventDetail["myRegistration"] = null;
      if (ctx) {
        const regs = await db
          .select()
          .from(schema.registrations)
          .where(and(eq(schema.registrations.eventId, e.id), eq(schema.registrations.userId, ctx.user.id)));
        if (regs[0] && !["cancelled", "declined"].includes(regs[0].status)) {
          const tix = await db.select().from(schema.tickets).where(eq(schema.tickets.registrationId, regs[0].id));
          myRegistration = {
            id: regs[0].id,
            status: regs[0].status,
            ticketNumber: tix[0] && !tix[0].revokedAt ? tix[0].number : null,
          };
        }
      }

      // Invite-only gate: needs the code unless registered or a scoped admin.
      if (e.model === "invite" && !myRegistration) {
        // A claimed +1 holds a pass but no registration, so check tickets too.
        const entitled = isScopedAdminFor(ctx, e.committeeId) || (ctx ? await userHoldsTicket(e.id, ctx.user.id) : false);
        if (!entitled) {
          if (inviteAttemptsExceeded(request.ip, e.id)) {
            return { status: 401, body: { error: "invite_code_required", message: "Too many code attempts — wait a few minutes and try again." } };
          }
          if (!inviteCodeMatches(e, query.inviteCode)) {
            if (query.inviteCode) recordInviteFail(request.ip, e.id);
            return { status: 401, body: { error: "invite_code_required", message: "This event is invite only — enter your invite code." } };
          }
        }
      }

      const questions = await db
        .select()
        .from(schema.eventQuestions)
        .where(and(eq(schema.eventQuestions.eventId, e.id), eq(schema.eventQuestions.visible, true)))
        .orderBy(asc(schema.eventQuestions.sort));

      const controls = await getQuestionControls();
      const visibleQuestions = questions.filter((q) => q.kind === "custom" || (q.key && controls[q.key as keyof QuestionControls]));

      const approved = await approvedCount(e.id);
      const detail: EventDetail = {
        id: e.id,
        shortCode: e.shortCode,
        title: e.title,
        description: e.description,
        status: e.status === "cancelled" ? "cancelled" : "published",
        // Organizers only, so their "Copy invite link" works from the public
        // page. Guests share the URL they arrived on.
        inviteCode: isScopedAdminFor(ctx, e.committeeId) ? e.inviteCode : null,
        number: e.number,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt.toISOString(),
        location: e.location,
        locationShort: deriveLocationShort(e.location, e.locationShort),
        category: e.category as EventDetail["category"],
        audience: e.audience,
        model: e.model,
        capacity: e.capacity,
        approvedCount: approved,
        full: e.capacity !== null && approved >= e.capacity,
        flagship: e.flagship,
        artwork: e.artwork as EventDetail["artwork"],
        passStyle: e.passStyle,
        stampCommittee: e.stampCommittee,
        allowPlusOne: e.allowPlusOne,
        contactEmail: e.contactEmail,
        committee: committeeDto(row.committee),
        questions: visibleQuestions.map((q) => ({
          id: q.id,
          kind: q.kind,
          key: (q.key as EventDetail["questions"][number]["key"]) ?? null,
          label: q.label,
          type: q.type,
          options: q.options ?? null,
          required: q.required,
        })),
        myRegistration,
      };
      return { status: 200, body: detail };
    },

    register: async ({ params, body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;

      const rows = await db.select().from(schema.events).where(eq(schema.events.shortCode, params.code));
      const event = rows[0];
      if (!event || event.status !== "published") return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (event.endAt < new Date()) return { status: 400, body: { error: "ended", message: "This event already ended." } };
      if (event.model === "invite") {
        if (!isScopedAdminFor(ctx, event.committeeId)) {
          if (inviteAttemptsExceeded(request.ip, event.id)) {
            return { status: 400, body: { error: "invite_code", message: "Too many code attempts — wait a few minutes and try again." } };
          }
          if (!inviteCodeMatches(event, body.inviteCode)) {
            recordInviteFail(request.ip, event.id);
            return { status: 400, body: { error: "invite_code", message: "That invite code isn't right." } };
          }
        }
      }
      if (event.audience === "cmu" && !isCmuEmail(ctx.user.email) && !ctx.admin) {
        return { status: 400, body: { error: "audience", message: "This event is CMU only." } };
      }

      const existing = await db
        .select()
        .from(schema.registrations)
        .where(and(eq(schema.registrations.eventId, event.id), eq(schema.registrations.userId, ctx.user.id)));
      if (existing[0] && !["cancelled", "declined"].includes(existing[0].status)) {
        return { status: 409, body: { error: "already_registered", message: "You already signed up for this one." } };
      }

      // The global question controls gate the public form (see the events.get
      // handler), so they gate what we accept too — otherwise an organizer could
      // restore collection of a field a super admin switched off club-wide. This
      // read used to happen further down, AFTER the destructive block; it has to
      // be here, because required-enforcement needs it.
      const controls = await getQuestionControls();

      // Everything from here to the destructive block below is validation. A 400
      // returned after that block deletes a returning guest's prior registration
      // and unlinks their ticket with nothing recreated, so nothing below may fail.
      const questions = await db
        .select()
        .from(schema.eventQuestions)
        .where(and(eq(schema.eventQuestions.eventId, event.id), eq(schema.eventQuestions.visible, true)))
        .orderBy(asc(schema.eventQuestions.sort));

      // Fold the payload down first: blanks never occupy a slot, last non-blank
      // wins, and one entry per question satisfies the answers unique index.
      const submitted = new Map<string, string>();
      for (const a of body.custom ?? []) {
        const trimmed = a.value.trim();
        if (trimmed.length > 0) submitted.set(a.questionId, trimmed);
      }

      // Iterate the questions, not the payload: an id that is no longer answerable
      // (hidden, deleted, or another event's) is ignored rather than rejected, so a
      // form left open while the organizer edits the questions still submits.
      const customAnswers: { questionId: string; value: string }[] = [];
      const fileAnswerIds: string[] = [];
      for (const q of questions) {
        if (q.kind !== "custom" && !(q.key && controls[q.key as keyof QuestionControls])) continue;
        // major_year / dietary / resume / source arrive in their own body fields.
        if (q.kind === "standard" && q.key !== "phone" && q.key !== "tshirt") continue;

        const value = submitted.get(q.id);
        if (!value) {
          if (q.required) {
            return { status: 400, body: { error: "answer_required", message: `“${q.label}” is required.` } };
          }
          continue;
        }
        if (q.type === "select" && (q.options ?? []).length > 0 && !(q.options ?? []).includes(value)) {
          return { status: 400, body: { error: "answer_option", message: `Pick one of the listed options for “${q.label}”.` } };
        }
        if (q.type === "file") {
          if (!isUuid(value)) {
            return { status: 400, body: { error: "answer_file", message: `Upload a file for “${q.label}” before submitting.` } };
          }
          // Lower-cased at write time: GET /api/files/:id matches lower-case only,
          // so an upper-case answer would produce an organizer link that 404s.
          const fileId = value.toLowerCase();
          fileAnswerIds.push(fileId);
          customAnswers.push({ questionId: q.id, value: fileId });
          continue;
        }
        customAnswers.push({ questionId: q.id, value });
      }

      // Validate every referenced upload BEFORE any destructive mutation. One
      // projected query covers the resume and all file answers; the old check
      // selected the whole row and dragged a 5 MB bytea into memory to read one
      // column.
      const referenced = [
        ...new Set([...(body.resumeFileId ? [body.resumeFileId.toLowerCase()] : []), ...fileAnswerIds]),
      ];
      if (referenced.length > 0) {
        const owned = await db
          .select({ id: schema.files.id })
          .from(schema.files)
          .where(and(inArray(schema.files.id, referenced), eq(schema.files.ownerUserId, ctx.user.id)));
        if (owned.length !== referenced.length) {
          return { status: 400, body: { error: "bad_file", message: "That upload doesn't belong to you." } };
        }
      }

      // Only now, after all validation passes, clear a prior cancelled/declined row.
      if (existing[0]) {
        await db.delete(schema.answers).where(eq(schema.answers.registrationId, existing[0].id));
        await db.update(schema.tickets).set({ registrationId: null }).where(eq(schema.tickets.registrationId, existing[0].id));
        await db.delete(schema.registrations).where(eq(schema.registrations.id, existing[0].id));
      }

      await db.update(schema.users).set({ name: body.fullName }).where(eq(schema.users.id, ctx.user.id));

      /**
       * The global controls say what the club collects at all; the event's own
       * question rows say what THIS event collects. A value has to clear both, or
       * an organizer's "hide Resume upload" toggle would stop the field rendering
       * while the server carried on storing resume_file_id — a switch labelled
       * hide that keeps collecting. `questions` is already filtered to visible
       * rows, so presence is the test.
       */
      const asks = (key: keyof QuestionControls) => controls[key] && questions.some((q) => q.key === key);

      const outcome = await createRegistration({
        event,
        user: ctx.user,
        fullName: body.fullName,
        major: asks("major_year") ? (body.major ?? null) : null,
        classYear: asks("major_year") ? (body.classYear ?? null) : null,
        dietary: asks("dietary") ? (body.dietary ?? []) : [],
        // Lower-cased for the same reason file answers are: the organizer's
        // download link has to match a route that only accepts lower-case ids.
        resumeFileId: asks("resume") ? (body.resumeFileId?.toLowerCase() ?? null) : null,
        source: asks("source") ? (body.source ?? null) : null,
        plusOne: body.plusOne ?? false,
        customAnswers,
      });

      return {
        status: 200,
        body: {
          registrationId: outcome.registration.id,
          status: outcome.registration.status,
          ticketNumber: outcome.ticket?.number ?? null,
        },
      };
    },

    cancel: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      const result = await cancelRegistration(params.id, ctx.user.id);
      if (!result.ok) return { status: 404, body: { error: "not_found", message: result.message ?? "Not found" } };
      return { status: 200, body: { ok: true } };
    },
  },

  // ------------------------------------------------------------- tickets
  tickets: {
    mine: async ({ request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;

      const regs = await db
        .select({ registration: schema.registrations, event: schema.events, committee: schema.committees })
        .from(schema.registrations)
        .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        .where(and(eq(schema.registrations.userId, ctx.user.id), inArray(schema.registrations.status, ["pending", "approved", "waitlisted"])));

      const myTickets = await db
        .select({ ticket: schema.tickets, event: schema.events, committee: schema.committees })
        .from(schema.tickets)
        .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        .where(and(eq(schema.tickets.userId, ctx.user.id), isNull(schema.tickets.revokedAt)));

      const ticketIds = myTickets.map((t) => t.ticket.id);
      const okCheckins = ticketIds.length
        ? await db
            .select()
            .from(schema.checkins)
            .where(and(inArray(schema.checkins.ticketId, ticketIds), eq(schema.checkins.result, "ok")))
        : [];
      const checkinByTicket = new Map(okCheckins.map((c) => [c.ticketId, c]));

      const transfers = ticketIds.length
        ? await db.select().from(schema.ticketTransfers).where(inArray(schema.ticketTransfers.ticketId, ticketIds))
        : [];
      const transferByTicket = new Map(transfers.map((t) => [t.ticketId, t]));
      const claimerIds = transfers.map((t) => t.claimedByUserId).filter((x): x is string => !!x);
      const claimers = claimerIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, claimerIds)) : [];
      const claimerById = new Map(claimers.map((u) => [u.id, u]));

      const guestName = ctx.user.name ?? ctx.user.email.split("@")[0];
      const now = new Date();
      const views: TicketView[] = [];
      const stubs: Stub[] = [];

      const regByTicket = new Map(regs.map((r) => [r.registration.id, r.registration]));

      for (const { ticket: t, event: e, committee: c } of myTickets) {
        const checkin = checkinByTicket.get(t.id);
        const isPast = e.endAt < now;
        const reg = t.registrationId ? regByTicket.get(t.registrationId) : undefined;
        const hasPlusOne = t.kind === "primary" && !!reg?.plusOne;

        if (isPast) {
          stubs.push({
            serial: t.serial,
            number: t.number,
            title: e.title,
            date: fmtStubDate(e.startAt),
            artwork: e.artwork as Stub["artwork"],
            checkedIn: !!checkin,
          });
          continue;
        }

        let transfer: TicketView["transfer"] = null;
        if (hasPlusOne) {
          const tr = transferByTicket.get(t.id);
          if (!tr) transfer = { status: "none", url: null, claimedByName: null };
          else {
            const claimer = tr.claimedByUserId ? claimerById.get(tr.claimedByUserId) : undefined;
            transfer = {
              status: tr.status,
              url: tr.status === "active" ? transferUrl(tr.id, tr.rotation) : null,
              claimedByName: claimer ? (claimer.name ?? claimer.email.split("@")[0]) : null,
            };
          }
        }

        views.push({
          id: t.id,
          registrationId: t.registrationId ?? t.id,
          serial: t.serial,
          number: t.number,
          kind: t.kind,
          status: checkin ? "checked_in" : "approved",
          checkedInAt: checkin?.createdAt.toISOString() ?? null,
          guestName,
          plusOneOnPass: hasPlusOne,
          event: {
            shortCode: e.shortCode,
            title: e.title,
            committeeName: c.name,
            committeeColor: c.color,
            startAt: e.startAt.toISOString(),
            endAt: e.endAt.toISOString(),
            location: e.location,
            locationShort: deriveLocationShort(e.location, e.locationShort),
            artwork: e.artwork as TicketView["event"]["artwork"],
            passStyle: e.passStyle,
            stampCommittee: e.stampCommittee,
            contactEmail: e.contactEmail,
          },
          transfer,
        });
      }

      // Pending/waitlisted registrations appear as locked passes.
      for (const { registration: r, event: e, committee: c } of regs) {
        if (r.status === "approved") continue;
        if (e.endAt < now) continue;
        views.push({
          id: null,
          registrationId: r.id,
          serial: null,
          number: null,
          kind: "primary",
          status: "pending",
          checkedInAt: null,
          guestName: r.fullName,
          plusOneOnPass: r.plusOne,
          event: {
            shortCode: e.shortCode,
            title: e.title,
            committeeName: c.name,
            committeeColor: c.color,
            startAt: e.startAt.toISOString(),
            endAt: e.endAt.toISOString(),
            location: e.location,
            locationShort: deriveLocationShort(e.location, e.locationShort),
            artwork: e.artwork as TicketView["event"]["artwork"],
            passStyle: e.passStyle,
            stampCommittee: e.stampCommittee,
            contactEmail: e.contactEmail,
          },
          transfer: null,
        });
      }

      views.sort((a, b) => a.event.startAt.localeCompare(b.event.startAt));
      stubs.sort((a, b) => b.date.localeCompare(a.date));
      return { status: 200, body: { tickets: views, stubs } };
    },

    createTransfer: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      const result = await ensureTransfer(params.id, ctx.user.id);
      if (!result.ok) return { status: 400, body: { error: "transfer", message: result.message } };
      return { status: 200, body: { url: result.url, status: "active" as const } };
    },

    revokeTransfer: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      const result = await revokeTransfer(params.id, ctx.user.id);
      if (!result.ok) return { status: 404, body: { error: "not_found", message: result.message } };
      return { status: 200, body: { ok: true } };
    },

    transferPreview: async ({ params }) => {
      const transfer = await parseTransferToken(params.token);
      if (!transfer) return { status: 200, body: { status: "invalid" as const, event: null, hostName: null } };
      const rows = await db
        .select({ ticket: schema.tickets, event: schema.events, committee: schema.committees, host: schema.users })
        .from(schema.tickets)
        .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
        .where(eq(schema.tickets.id, transfer.ticketId));
      const row = rows[0];
      if (!row) return { status: 200, body: { status: "invalid" as const, event: null, hostName: null } };
      return {
        status: 200,
        body: {
          status: transfer.status === "active" ? ("active" as const) : transfer.status === "claimed" ? ("claimed" as const) : ("revoked" as const),
          event: {
            title: row.event.title,
            startAt: row.event.startAt.toISOString(),
            endAt: row.event.endAt.toISOString(),
            location: row.event.location,
            committeeName: row.committee.name,
            committeeColor: row.committee.color,
            artwork: row.event.artwork as "brand" | "cool" | "warm" | "sunset",
            contactEmail: row.event.contactEmail,
          },
          hostName: row.host.name ?? row.host.email.split("@")[0],
        },
      };
    },

    claimTransfer: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      const result = await claimTransfer({ token: params.token, claimer: ctx.user });
      if (!result.ok) return { status: 400, body: { error: "claim", message: result.message } };
      return { status: 200, body: { ticketId: result.ticket.id, serial: result.ticket.serial } };
    },

    googleWallet: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      const { googleWalletSaveUrl } = await import("../lib/wallet/google");
      const result = await googleWalletSaveUrl(params.id, ctx.user.id);
      if (!result.ok) return { status: result.status, body: { error: "wallet", message: result.message } };
      return { status: 200, body: { saveUrl: result.url } };
    },
  },

  // ------------------------------------------------------------- org
  org: {
    myEvents: async ({ request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scope = scopedCommitteeIds(ctx);

      const rows = await db
        .select({ event: schema.events, committee: schema.committees })
        .from(schema.events)
        .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
        // Cancelled events stay listed here: the organizer still needs to reach
        // them to un-cancel, export the guest list, or delete them for good.
        .where(scope === "all" ? undefined : inArray(schema.events.committeeId, scope))
        .orderBy(desc(schema.events.startAt));

      const ids = rows.map((r) => r.event.id);
      const statusCounts = ids.length
        ? await db
            .select({ eventId: schema.registrations.eventId, status: schema.registrations.status, count: sql<number>`count(*)::int` })
            .from(schema.registrations)
            .where(inArray(schema.registrations.eventId, ids))
            .groupBy(schema.registrations.eventId, schema.registrations.status)
        : [];
      const byEvent = new Map<string, Record<string, number>>();
      for (const c of statusCounts) {
        const m = byEvent.get(c.eventId) ?? {};
        m[c.status] = c.count;
        byEvent.set(c.eventId, m);
      }

      return {
        status: 200,
        body: {
          events: rows.map(({ event: e, committee: c }) => ({
            id: e.id,
            shortCode: e.shortCode,
            title: e.title,
            startAt: e.startAt.toISOString(),
            endAt: e.endAt.toISOString(),
            committeeName: c.name,
            committeeColor: c.color,
            pendingCount: byEvent.get(e.id)?.pending ?? 0,
            approvedCount: byEvent.get(e.id)?.approved ?? 0,
            capacity: e.capacity,
            model: e.model,
            status: e.status,
          })),
        },
      };
    },

    committees: async ({ request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const all = await db.select().from(schema.committees).orderBy(asc(schema.committees.sort));
      const scope = scopedCommitteeIds(ctx);
      const visible = scope === "all" ? all : all.filter((c) => scope.includes(c.id));
      return { status: 200, body: { committees: visible.map(committeeDto), questionControls: await getQuestionControls() } };
    },

    dashboard: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;
      const { event: e, committee: c } = scoped;

      const { guests, regs } = await buildGuestRows(e.id);

      const today = nyDay(new Date());
      const active = regs.filter((r) => !["cancelled"].includes(r.status));
      const kpis = {
        requests: active.length,
        requestsToday: active.filter((r) => nyDay(r.createdAt) === today).length,
        approved: regs.filter((r) => r.status === "approved").length,
        capacity: e.capacity,
        waitlist: regs.filter((r) => r.status === "waitlisted").length,
        plusOnesClaimed: guests.filter((g) => g.plusOneClaimed).length,
        plusOnesInvited: regs.filter((r) => r.plusOne && r.status === "approved").length,
      };

      const pendingRegs = regs.filter((r) => r.status === "pending").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const guestByReg = new Map(guests.map((g) => [g.registrationId, g]));
      const pending: PendingItem[] = pendingRegs.map((r) => ({
        registrationId: r.id,
        name: r.fullName,
        initials: initialsOf(r.fullName),
        andrewId: guestByReg.get(r.id)?.andrewId ?? null,
        createdAt: r.createdAt.toISOString(),
      }));

      const sourceCounts = new Map<string, number>();
      for (const r of active) {
        const label = r.source?.trim() || "Not answered";
        sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
      }
      const sources = [...sourceCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

      const controls = await getQuestionControls();
      const body: Dashboard = {
        event: {
          id: e.id,
          shortCode: e.shortCode,
          title: e.title,
          startAt: e.startAt.toISOString(),
          endAt: e.endAt.toISOString(),
          location: e.location,
          committeeName: c.name,
          committeeColor: c.color,
          model: e.model,
          capacity: e.capacity,
          inviteCode: e.inviteCode,
          url: `${env.appUrl}/e/${e.shortCode}`,
          questionControls: controls,
          questions: (await orgQuestions(e.id)).map((q) => ({
            id: q.id,
            kind: q.kind,
            key: q.key,
            label: q.label,
            type: q.type,
            options: q.options,
            required: q.required,
          })),
        },
        kpis,
        guests,
        pending,
        sources,
      };
      return { status: 200, body };
    },

    getEvent: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;
      const { event: e, committee: c } = scoped;

      const questions = await orgQuestions(e.id);
      const questionControls = await getQuestionControls();

      const statusCounts = await db
        .select({ status: schema.registrations.status, count: sql<number>`count(*)::int` })
        .from(schema.registrations)
        .where(eq(schema.registrations.eventId, e.id))
        .groupBy(schema.registrations.status);
      const registrationCount = statusCounts.reduce((n, r) => n + r.count, 0);
      const waitlistCount = statusCounts.find((r) => r.status === "waitlisted")?.count ?? 0;

      const shareUrl =
        e.model === "invite" && e.inviteCode
          ? `${env.appUrl}/e/${e.shortCode}?code=${encodeURIComponent(e.inviteCode)}`
          : `${env.appUrl}/e/${e.shortCode}`;

      return {
        status: 200,
        body: {
          id: e.id,
          shortCode: e.shortCode,
          number: e.number,
          title: e.title,
          description: e.description,
          category: e.category as EventDetail["category"],
          audience: e.audience,
          model: e.model,
          capacity: e.capacity,
          startAt: e.startAt.toISOString(),
          endAt: e.endAt.toISOString(),
          location: e.location,
          locationShort: e.locationShort,
          artwork: e.artwork as EventDetail["artwork"],
          passStyle: e.passStyle,
          stampCommittee: e.stampCommittee,
          allowPlusOne: e.allowPlusOne,
          flagship: e.flagship,
          updatesEmail: e.updatesEmail,
          contactEmail: e.contactEmail,
          digest: e.digest,
          status: e.status,
          listed: e.listed,
          inviteCode: e.inviteCode,
          shareUrl,
          committee: committeeDto(c),
          questions,
          questionControls,
          registrationCount,
          waitlistCount,
          deletable: registrationCount === 0,
        },
      };
    },

    approve: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const regs = await db.select().from(schema.registrations).where(eq(schema.registrations.id, params.id));
      if (!regs[0]) return { status: 404, body: { error: "not_found", message: "Registration not found" } };
      const scoped = await loadScopedEvent(ctx, regs[0].eventId);
      if (scoped === "forbidden" || scoped === null) return forbidden;
      const result = await approveRegistration(params.id);
      if (!result.ok) return { status: 404, body: { error: "approve", message: result.message ?? "Couldn't approve" } };
      return { status: 200, body: { ok: true } };
    },

    decline: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const regs = await db.select().from(schema.registrations).where(eq(schema.registrations.id, params.id));
      if (!regs[0]) return { status: 404, body: { error: "not_found", message: "Registration not found" } };
      const scoped = await loadScopedEvent(ctx, regs[0].eventId);
      if (scoped === "forbidden" || scoped === null) return forbidden;
      const result = await declineRegistration(params.id);
      if (!result.ok) return { status: 404, body: { error: "decline", message: result.message ?? "Couldn't decline" } };
      return { status: 200, body: { ok: true, promoted: result.promoted } };
    },

    deleteEvent: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;

      // Deleting destroys registrations, tickets people are holding, and the
      // check-in record. An event with signups is never a one-click delete:
      // cancel it first (which keeps the data and hides it from browse), and
      // only then can a super admin remove it for good.
      const regCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.registrations)
        .where(eq(schema.registrations.eventId, params.id));
      const signups = regCount[0]?.count ?? 0;
      if (signups > 0) {
        if (ctx.admin.row.role !== "super_admin") {
          return {
            status: 400,
            body: {
              error: "has_signups",
              message: `This event has ${signups} signup${signups === 1 ? "" : "s"} — cancel it instead, or ask a super admin to delete it.`,
            },
          };
        }
        if (scoped.event.status !== "cancelled") {
          return {
            status: 400,
            body: {
              error: "cancel_first",
              message: `This event has ${signups} signup${signups === 1 ? "" : "s"}. Cancel it first — then it can be deleted permanently.`,
            },
          };
        }
      }

      await db.transaction(async (tx) => {
        const regIds = (
          await tx.select({ id: schema.registrations.id }).from(schema.registrations).where(eq(schema.registrations.eventId, params.id))
        ).map((r) => r.id);
        const ticketIds = (
          await tx.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.eventId, params.id))
        ).map((t) => t.id);
        if (regIds.length) await tx.delete(schema.answers).where(inArray(schema.answers.registrationId, regIds));
        if (ticketIds.length) await tx.delete(schema.ticketTransfers).where(inArray(schema.ticketTransfers.ticketId, ticketIds));
        await tx.delete(schema.checkins).where(eq(schema.checkins.eventId, params.id));
        await tx.delete(schema.tickets).where(eq(schema.tickets.eventId, params.id));
        await tx.delete(schema.registrations).where(eq(schema.registrations.eventId, params.id));
        await tx.delete(schema.eventQuestions).where(eq(schema.eventQuestions.eventId, params.id));
        await tx.delete(schema.events).where(eq(schema.events.id, params.id));
      });
      return { status: 200, body: { ok: true } };
    },

    updateEvent: async ({ params, body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;

      const patch: Partial<typeof schema.events.$inferInsert> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.category !== undefined) patch.category = body.category;
      if (body.audience !== undefined) patch.audience = body.audience;
      if (body.model !== undefined) patch.model = body.model;
      if (body.capacity !== undefined) patch.capacity = body.capacity;
      // Dates: reject unparseable input, and check start/end against whatever
      // the event will actually hold after the patch — a one-sided edit still
      // has to land on a valid range. createEvent enforces the same rule.
      if (body.startAt !== undefined) {
        const startAt = new Date(body.startAt);
        if (Number.isNaN(startAt.getTime())) return { status: 400, body: { error: "dates", message: "That start time isn't a valid date." } };
        patch.startAt = startAt;
      }
      if (body.endAt !== undefined) {
        const endAt = new Date(body.endAt);
        if (Number.isNaN(endAt.getTime())) return { status: 400, body: { error: "dates", message: "That end time isn't a valid date." } };
        patch.endAt = endAt;
      }
      const effectiveStart = patch.startAt ?? scoped.event.startAt;
      const effectiveEnd = patch.endAt ?? scoped.event.endAt;
      if (effectiveEnd <= effectiveStart) {
        return { status: 400, body: { error: "dates", message: "The end time has to come after the start." } };
      }

      if (body.location !== undefined) patch.location = body.location;
      if (body.locationShort !== undefined) patch.locationShort = body.locationShort;
      if (body.artwork !== undefined) patch.artwork = body.artwork;
      if (body.passStyle !== undefined) patch.passStyle = body.passStyle;
      if (body.stampCommittee !== undefined) patch.stampCommittee = body.stampCommittee;
      if (body.allowPlusOne !== undefined) patch.allowPlusOne = body.allowPlusOne;
      if (body.flagship !== undefined) patch.flagship = body.flagship;
      if (body.updatesEmail !== undefined) patch.updatesEmail = body.updatesEmail;
      if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail;
      if (body.digest !== undefined) patch.digest = body.digest;
      if (body.status !== undefined) patch.status = body.status;

      // Switching the signup model carries its own side effects, or the event
      // lands in a state createEvent would never produce. Becoming invite-only
      // without a code leaves the gate open; leaving invite-only while still
      // unlisted hides the event from browse forever.
      if (body.model !== undefined) {
        patch.listed = body.model !== "invite";
        if (body.model === "invite") {
          if (!scoped.event.inviteCode?.trim()) patch.inviteCode = newInviteCode();
        } else if (scoped.event.model === "invite") {
          patch.inviteCode = null;
        }
      }

      // Instant events never hold a cap — mirror createEvent so a caller sending
      // only {model:"instant"} can't leave a live capacity behind.
      if (patch.model === "instant") patch.capacity = null;

      if (Object.keys(patch).length === 0) return { status: 400, body: { error: "empty", message: "Nothing to update." } };
      await db.update(schema.events).set(patch).where(eq(schema.events.id, params.id));

      // Anyone still waitlisted has to land somewhere the new model can drain:
      // approval sends them back to the review queue, everything else promotes
      // them as far as the (possibly now absent) capacity allows. Without this,
      // dropping the cap strands them in a queue that can never move again.
      if (patch.capacity !== undefined || patch.model !== undefined) {
        const nextModel = patch.model ?? scoped.event.model;
        if (nextModel === "approval") await waitlistToPending(params.id);
        else await promoteWaitlist(params.id);
      }
      return { status: 200, body: { ok: true } };
    },

    updateQuestions: async ({ params, body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;

      const existing = await db
        .select()
        .from(schema.eventQuestions)
        .where(eq(schema.eventQuestions.eventId, params.id))
        .orderBy(asc(schema.eventQuestions.sort));
      const existingById = new Map(existing.map((q) => [q.id, q]));

      const counts = existing.length
        ? await db
            .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
            .from(schema.answers)
            .where(
              inArray(
                schema.answers.questionId,
                existing.map((q) => q.id),
              ),
            )
            .groupBy(schema.answers.questionId)
        : [];
      // Every answer counts, including a cancelled registration's — those rows
      // survive until the guest re-registers. This snapshot is good enough to
      // REJECT with (a stale 409 just asks the organizer to reload); it is NOT
      // good enough to DELETE with. The apply phase re-reads it under the lock.
      const answered = new Map(counts.map((c) => [c.questionId, c.count]));
      const controls = await getQuestionControls();
      const trim = (options: string[] | null | undefined) => (options ?? []).map((o) => o.trim()).filter(Boolean);

      // ---- validate the whole payload before mutating anything ----------------
      const seen = new Set<string>();
      for (const draft of body.questions) {
        if (!draft.id) continue;
        if (!existingById.has(draft.id) || seen.has(draft.id)) {
          return {
            status: 400,
            body: { error: "unknown_question", message: "That list doesn't match this event's questions any more — reload the page and try again." },
          };
        }
        seen.add(draft.id);
      }
      for (const row of existing) {
        // A payload of custom rows only would otherwise hide or delete all six
        // standard rows and cascade away every phone and t-shirt answer.
        if (row.kind === "standard" && !seen.has(row.id)) {
          return {
            status: 400,
            body: { error: "missing_standard", message: "The standard fields can be switched off but not removed — reload the page and try again." },
          };
        }
      }
      const customCount = body.questions.filter((d) => !d.id || existingById.get(d.id)?.kind === "custom").length;
      if (customCount > MAX_CUSTOM_QUESTIONS) {
        return {
          status: 400,
          body: { error: "too_many", message: `That's ${customCount} questions — a signup form carries at most ${MAX_CUSTOM_QUESTIONS}.` },
        };
      }
      for (const draft of body.questions) {
        const row = draft.id ? existingById.get(draft.id)! : null;
        if (row?.kind === "standard") {
          // A standard field's label, type and options are ours, not the
          // organizer's — only `visible` and position come from the payload. And a
          // key the super admin disabled club-wide cannot be visible here, whether
          // this payload is the one switching it on or it was already visible from
          // before the control was disabled — "off everywhere" would mean nothing
          // otherwise. (The register handler already consults the global controls
          // directly, so this isn't the only thing stopping an answer from being
          // collected for a globally-off field — it's defense in depth, and it also
          // keeps the organizer's own view of `visible` honest.)
          if (draft.visible && row.key && !controls[row.key as keyof QuestionControls]) {
            return {
              status: 400,
              body: { error: "globally_off", message: `“${row.label}” is switched off for the whole club — a super admin has to turn it back on first.` },
            };
          }
          continue;
        }
        const options = trim(draft.options);
        if (draft.type === "select" && options.length === 0) {
          return { status: 400, body: { error: "options", message: `Add at least one option to “${draft.label}”, or change it to short text.` } };
        }
        const n = row ? (answered.get(row.id) ?? 0) : 0;
        if (n > 0 && (row!.type !== draft.type || JSON.stringify(trim(row!.options)) !== JSON.stringify(options))) {
          return {
            status: 409,
            body: {
              error: "locked",
              message: `“${row!.label}” already has ${n} answer${n === 1 ? "" : "s"} — you can't change its type or options once people have answered.`,
            },
          };
        }
      }

      // ---- apply --------------------------------------------------------------
      await db.transaction(async (tx) => {
        // The same lock registrations take (createRegistration calls this inside
        // its own transaction). Everything the apply phase decides is re-read HERE,
        // inside the lock: the reads above happened before it, and a signup that
        // commits in between is invisible to them. Delete on a stale zero-answer
        // count and answers.question_id's ON DELETE CASCADE destroys that guest's
        // answer with no trace. Rejections may run on the stale snapshot; deletes
        // may not.
        await lockEvent(tx, params.id);

        const live = await tx
          .select()
          .from(schema.eventQuestions)
          .where(eq(schema.eventQuestions.eventId, params.id))
          .orderBy(asc(schema.eventQuestions.sort));
        const liveById = new Map(live.map((q) => [q.id, q]));
        const liveCounts = live.length
          ? await tx
              .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
              .from(schema.answers)
              .where(
                inArray(
                  schema.answers.questionId,
                  live.map((q) => q.id),
                ),
              )
              .groupBy(schema.answers.questionId)
          : [];
        const liveAnswered = new Map(liveCounts.map((c) => [c.questionId, c.count]));

        for (const [i, draft] of body.questions.entries()) {
          const row = draft.id ? (liveById.get(draft.id) ?? null) : null;
          // The row was deleted by a concurrent save between the validation read
          // and this lock. Do not resurrect it — an id we no longer have is not
          // ours to re-create.
          if (draft.id && !row) continue;
          if (!row) {
            await tx.insert(schema.eventQuestions).values({
              eventId: params.id,
              kind: "custom",
              key: null,
              label: draft.label,
              type: draft.type,
              options: draft.type === "select" ? trim(draft.options) : null,
              required: draft.required,
              visible: draft.visible,
              sort: i,
            });
            continue;
          }
          if (row.kind === "standard") {
            await tx.update(schema.eventQuestions).set({ visible: draft.visible, sort: i }).where(eq(schema.eventQuestions.id, row.id));
            continue;
          }
          await tx
            .update(schema.eventQuestions)
            .set({
              label: draft.label,
              type: draft.type,
              options: draft.type === "select" ? trim(draft.options) : null,
              required: draft.required,
              visible: draft.visible,
              sort: i,
            })
            .where(eq(schema.eventQuestions.id, row.id));
        }

        // A custom question the organizer dropped. Deleting cascades its answers,
        // so that is only safe at zero; otherwise hide it, which keeps the answers
        // and keeps its CSV column. Retired rows sort after everything live.
        //
        // `live` and `liveAnswered`, not `existing` and `answered`: this is the
        // decision the lock exists to protect, so it reads the state the lock is
        // holding. `seen` is derived from the payload, so it needs no re-read.
        let tail = body.questions.length;
        for (const row of live) {
          if (row.kind !== "custom" || seen.has(row.id)) continue;
          if ((liveAnswered.get(row.id) ?? 0) > 0) {
            await tx.update(schema.eventQuestions).set({ visible: false, sort: tail++ }).where(eq(schema.eventQuestions.id, row.id));
          } else {
            await tx.delete(schema.eventQuestions).where(eq(schema.eventQuestions.id, row.id));
          }
        }
      });

      // Hand the refreshed list back so the builder can write the new rows' server
      // ids into its own state — without them a second save re-creates them.
      return { status: 200, body: { ok: true, questions: await orgQuestions(params.id) } };
    },

    createEvent: async ({ body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;

      // Committee stamping: admins create under their committee; supers pick any.
      let committeeId = ctx.admin.row.committeeId;
      if (body.committeeId && body.committeeId !== committeeId) {
        if (ctx.admin.row.role !== "super_admin") {
          return { status: 403, body: { error: "committee", message: "Events are stamped with your committee — only super admins can pick another." } };
        }
        committeeId = body.committeeId;
      }
      const committee = (await db.select().from(schema.committees).where(eq(schema.committees.id, committeeId)))[0];
      if (!committee) return { status: 400, body: { error: "committee", message: "Unknown committee" } };

      const startAt = new Date(body.startAt);
      const endAt = new Date(body.endAt);
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
        return { status: 400, body: { error: "dates", message: "The end time has to come after the start." } };
      }

      const controls = await getQuestionControls();
      const shortCode = newShortCode();
      const inviteCode = body.model === "invite" ? newInviteCode() : null;

      const inserted = await db
        .insert(schema.events)
        .values({
          shortCode,
          title: body.title,
          description: body.description,
          committeeId,
          category: body.category,
          audience: body.audience,
          model: body.model,
          capacity: body.model === "capacity" || body.model === "invite" ? body.capacity : body.model === "approval" ? body.capacity : null,
          startAt,
          endAt,
          location: body.location,
          locationShort: body.locationShort ?? null,
          artwork: body.artwork,
          passStyle: body.passStyle,
          stampCommittee: body.stampCommittee,
          allowPlusOne: body.allowPlusOne,
          flagship: body.flagship ?? false,
          listed: body.model !== "invite",
          inviteCode,
          updatesEmail: body.updatesEmail,
          contactEmail: body.contactEmail,
          digest: body.digest,
          status: "published",
          createdByEmail: ctx.user.email,
        })
        .returning();
      const event = inserted[0];

      const questionRows: (typeof schema.eventQuestions.$inferInsert)[] = [];
      let sort = 0;
      const standard: { key: keyof QuestionControls; label: string; type: "short" | "select"; options?: string[] }[] = [
        { key: "major_year", label: "Major + class year", type: "select" },
        { key: "dietary", label: "Dietary restrictions", type: "select" },
        { key: "resume", label: "Resume upload", type: "short" },
        { key: "source", label: "How did you hear about this?", type: "select" },
        { key: "phone", label: "Phone number", type: "short" },
        { key: "tshirt", label: "T-shirt size", type: "select", options: ["S", "M", "L", "XL", "XXL"] },
      ];
      for (const q of standard) {
        questionRows.push({
          eventId: event.id,
          kind: "standard",
          key: q.key,
          label: q.label,
          type: q.type,
          options: q.options ?? null,
          visible: controls[q.key] && body.captures[q.key],
          sort: sort++,
        });
      }
      for (const q of body.hostQuestions) {
        questionRows.push({
          eventId: event.id,
          kind: "custom",
          key: null,
          label: q.label,
          type: q.type,
          options: q.options ?? null,
          required: q.required ?? false,
          visible: true,
          sort: sort++,
        });
      }
      if (questionRows.length) await db.insert(schema.eventQuestions).values(questionRows);

      return {
        status: 200,
        body: { id: event.id, shortCode, url: `${env.appUrl}/e/${shortCode}`, inviteCode },
      };
    },

    checkin: async ({ params, body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;

      let serial = body.serial?.trim();
      let method: "qr" | "manual" = body.method ?? (body.andrewId ? "manual" : "qr");

      if (!serial && body.andrewId) {
        const andrewId = body.andrewId.trim().toLowerCase().replace(/@.*$/, "");
        const found = await db
          .select({ ticket: schema.tickets })
          .from(schema.tickets)
          .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
          .where(
            and(
              eq(schema.tickets.eventId, params.id),
              isNull(schema.tickets.revokedAt),
              sql`(${schema.users.andrewId} = ${andrewId} OR lower(split_part(${schema.users.email}::text, '@', 1)) = ${andrewId})`,
            ),
          )
          .orderBy(asc(schema.tickets.kind));
        if (!found[0]) {
          return {
            status: 200,
            body: {
              result: "denied" as const,
              guestName: null,
              serial: null,
              plusOne: false,
              hostName: null,
              originalAt: null,
              message: `No approved pass for “${andrewId}” — send them to registration.`,
            },
          };
        }
        serial = found[0].ticket.serial;
        method = "manual";
      }

      if (!serial) return { status: 400, body: { error: "input", message: "Scan a QR or enter an andrew ID." } };

      const outcome = await checkinBySerial({ eventId: params.id, serial, method, byEmail: ctx.user.email });
      return {
        status: 200,
        body: {
          result: outcome.result,
          guestName: outcome.guestName,
          serial: outcome.serial,
          plusOne: outcome.plusOne,
          hostName: outcome.hostName,
          originalAt: outcome.originalAt?.toISOString() ?? null,
          message: outcome.message,
        },
      };
    },

    checkinState: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;
      const { event: e, committee: c } = scoped;

      const all = await db
        .select()
        .from(schema.checkins)
        .where(eq(schema.checkins.eventId, e.id))
        .orderBy(desc(schema.checkins.createdAt));

      const ok = all.filter((x) => x.result === "ok");
      const stats = {
        checkedIn: ok.length,
        plusOnes: ok.filter((x) => x.plusOne).length,
        walkIns: ok.filter((x) => x.method === "manual").length,
        turnedAway: all.filter((x) => x.result === "denied").length,
      };

      const ticketIds = all.map((x) => x.ticketId).filter((x): x is string => !!x);
      const ticketRows = ticketIds.length
        ? await db
            .select({ ticket: schema.tickets, user: schema.users })
            .from(schema.tickets)
            .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
            .where(inArray(schema.tickets.id, ticketIds))
        : [];
      const nameByTicket = new Map(ticketRows.map((t) => [t.ticket.id, t.user.name ?? t.user.email.split("@")[0]]));

      const recent = all.slice(0, 12).map((x) => ({
        id: x.id,
        name: x.ticketId ? (nameByTicket.get(x.ticketId) ?? "Unknown") : "Unknown pass",
        serial: x.serialAttempted,
        result: (x.result === "ok" && x.plusOne ? "plus_one" : x.result) as "ok" | "plus_one" | "duplicate" | "denied",
        at: x.createdAt.toISOString(),
      }));

      return {
        status: 200,
        body: {
          event: {
            id: e.id,
            title: e.title,
            startAt: e.startAt.toISOString(),
            committeeName: c.name,
            capacity: e.capacity,
            approvedCount: await approvedCount(e.id),
          },
          stats,
          recent,
        },
      };
    },
  },

  // ------------------------------------------------------------- admin portal
  admin: {
    overview: async ({ request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;

      const adminRows = await db
        .select({ admin: schema.admins, committee: schema.committees, user: schema.users })
        .from(schema.admins)
        .innerJoin(schema.committees, eq(schema.admins.committeeId, schema.committees.id))
        .leftJoin(schema.users, eq(schema.users.email, schema.admins.email))
        .orderBy(asc(schema.admins.invitedAt));

      const admins: AdminRow[] = adminRows.map(({ admin: a, committee: c, user: u }) => ({
        id: a.id,
        email: a.email,
        name: u?.name ?? null,
        initials: initialsOf(u?.name || a.email),
        committee: committeeDto(c),
        role: a.role,
        domainExempt: a.domainExempt,
        status: a.acceptedAt ? "active" : "invited",
      }));

      const committeesAll = await db.select().from(schema.committees).orderBy(asc(schema.committees.sort));
      const counts = await db
        .select({ committeeId: schema.admins.committeeId, count: sql<number>`count(*)::int` })
        .from(schema.admins)
        .groupBy(schema.admins.committeeId);
      const countByCommittee = new Map(counts.map((c) => [c.committeeId, c.count]));
      const upcoming = await db
        .select({ committeeId: schema.events.committeeId, count: sql<number>`count(*)::int` })
        .from(schema.events)
        .where(and(eq(schema.events.status, "published"), gte(schema.events.endAt, new Date())))
        .groupBy(schema.events.committeeId);
      const upcomingByCommittee = new Map(upcoming.map((c) => [c.committeeId, c.count]));

      const tokens = await db
        .select()
        .from(schema.mcpTokens)
        .where(isNull(schema.mcpTokens.revokedAt))
        .orderBy(desc(schema.mcpTokens.createdAt));
      const committeeById = new Map(committeesAll.map((c) => [c.id, c]));

      return {
        status: 200,
        body: {
          admins,
          questionControls: await getQuestionControls(),
          committees: committeesAll.map((c) => ({
            ...committeeDto(c),
            adminCount: countByCommittee.get(c.id) ?? 0,
            upcomingCount: upcomingByCommittee.get(c.id) ?? 0,
          })),
          mcp: {
            url: env.mcpUrl,
            tokens: tokens.map((t) => ({
              id: t.id,
              label: t.label,
              email: t.email,
              scope: t.scope === "all" ? "All committees" : (committeeById.get(t.scope)?.name ?? t.scope),
              createdAt: t.createdAt.toISOString(),
              lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            })),
          },
        },
      };
    },

    inviteAdmin: async ({ body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;

      const email = body.email.trim().toLowerCase();
      const committee = (await db.select().from(schema.committees).where(eq(schema.committees.id, body.committeeId)))[0];
      if (!committee) return { status: 400, body: { error: "committee", message: "Unknown committee" } };

      const existing = await db.select().from(schema.admins).where(eq(schema.admins.email, email));
      if (existing[0]) return { status: 409, body: { error: "exists", message: "That email is already an admin." } };

      const domainExempt = !isCmuEmail(email);
      const inserted = await db
        .insert(schema.admins)
        .values({ email, committeeId: committee.id, role: body.role, domainExempt, invitedByEmail: ctx.user.email })
        .returning();
      const a = inserted[0];

      const mail = adminInviteEmail({
        committeeName: committee.name,
        role: body.role,
        invitedBy: ctx.user.name ?? ctx.user.email,
      });
      void sendMail({ to: email, ...mail });

      const user = (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
      return {
        status: 200,
        body: {
          id: a.id,
          email: a.email,
          name: user?.name ?? null,
          initials: initialsOf(user?.name || a.email),
          committee: committeeDto(committee),
          role: a.role,
          domainExempt: a.domainExempt,
          status: user ? "active" : "invited",
        },
      };
    },

    resendInvite: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;
      const rows = await db
        .select({ admin: schema.admins, committee: schema.committees })
        .from(schema.admins)
        .innerJoin(schema.committees, eq(schema.admins.committeeId, schema.committees.id))
        .where(eq(schema.admins.id, params.id));
      if (!rows[0]) return { status: 404, body: { error: "not_found", message: "Admin not found" } };
      const mail = adminInviteEmail({
        committeeName: rows[0].committee.name,
        role: rows[0].admin.role,
        invitedBy: ctx.user.name ?? ctx.user.email,
      });
      void sendMail({ to: rows[0].admin.email, ...mail });
      return { status: 200, body: { ok: true } };
    },

    revokeAdmin: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;
      const rows = await db.select().from(schema.admins).where(eq(schema.admins.id, params.id));
      if (!rows[0]) return { status: 404, body: { error: "not_found", message: "Admin not found" } };
      if (rows[0].email.toLowerCase() === ctx.user.email.toLowerCase()) {
        return { status: 400, body: { error: "self", message: "You can't revoke your own access." } };
      }
      await db.delete(schema.admins).where(eq(schema.admins.id, params.id));
      // Revoking event tools must also cut this person's MCP data access —
      // otherwise a stale token keeps working until it expires.
      await db
        .update(schema.mcpTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.mcpTokens.email, rows[0].email), isNull(schema.mcpTokens.revokedAt)));
      return { status: 200, body: { ok: true } };
    },

    setQuestionControl: async ({ body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;
      const next = await setQuestionControl(body.key, body.enabled);
      return { status: 200, body: next };
    },

    revokeMcpToken: async ({ params, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (ctx.admin?.row.role !== "super_admin") return forbidden;
      const updated = await db
        .update(schema.mcpTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.mcpTokens.id, params.id))
        .returning();
      if (!updated[0]) return { status: 404, body: { error: "not_found", message: "Token not found" } };
      return { status: 200, body: { ok: true } };
    },
  },
});

export { contract };

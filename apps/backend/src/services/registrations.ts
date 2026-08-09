import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { sendMail } from "../lib/mail";
import { ticketEmail, waitlistedEmail, requestReceivedEmail, declinedEmail, type EventEmailInfo } from "../lib/emails";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EventRow = typeof schema.events.$inferSelect;
type RegistrationRow = typeof schema.registrations.$inferSelect;
type TicketRow = typeof schema.tickets.$inferSelect;

export function serialTagFor(email: string, andrewId: string | null): string {
  const base = (andrewId ?? email.split("@")[0])
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return base || "GUEST";
}

export function eventEmailInfo(ev: EventRow, committeeName: string): EventEmailInfo {
  return {
    title: ev.title,
    startAt: ev.startAt,
    endAt: ev.endAt,
    location: ev.location,
    contactEmail: ev.contactEmail,
    committeeName,
    shortCode: ev.shortCode,
  };
}

async function committeeName(committeeId: string): Promise<string> {
  const rows = await db.select().from(schema.committees).where(eq(schema.committees.id, committeeId));
  return rows[0]?.name ?? "ScottyLabs";
}

/** Serializes capacity/numbering decisions per event. Must be called inside a transaction. */
async function lockEvent(tx: Tx, eventId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"event:" + eventId}))`);
}

async function approvedCountTx(tx: Tx, eventId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.registrations)
    .where(and(eq(schema.registrations.eventId, eventId), eq(schema.registrations.status, "approved")));
  return rows[0]?.count ?? 0;
}

export async function approvedCount(eventId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.registrations)
    .where(and(eq(schema.registrations.eventId, eventId), eq(schema.registrations.status, "approved")));
  return rows[0]?.count ?? 0;
}

async function issueTicketTx(
  tx: Tx,
  opts: {
    event: EventRow;
    registration: RegistrationRow;
    userEmail: string;
    userAndrewId: string | null;
  },
): Promise<TicketRow> {
  const nextNumberRows = await tx
    .select({ max: sql<number>`coalesce(max(${schema.tickets.number}), 0)::int` })
    .from(schema.tickets)
    .where(eq(schema.tickets.eventId, opts.event.id));
  const number = (nextNumberRows[0]?.max ?? 0) + 1;
  const serial = `SIT-${String(number).padStart(3, "0")}-${serialTagFor(opts.userEmail, opts.userAndrewId)}`;
  const inserted = await tx
    .insert(schema.tickets)
    .values({
      eventId: opts.event.id,
      registrationId: opts.registration.id,
      userId: opts.registration.userId,
      kind: "primary",
      number,
      serial,
    })
    .returning();
  return inserted[0];
}

export interface RegisterOutcome {
  registration: RegistrationRow;
  ticket: TicketRow | null;
  waitlistPosition: number | null;
}

/**
 * Creates a registration under the event's signup model and, when the model
 * grants immediate entry, issues the numbered ticket in the same transaction.
 */
export async function createRegistration(opts: {
  event: EventRow;
  user: typeof schema.users.$inferSelect;
  fullName: string;
  major: string | null;
  classYear: string | null;
  dietary: string[];
  resumeFileId: string | null;
  source: string | null;
  plusOne: boolean;
  customAnswers: { questionId: string; value: string }[];
}): Promise<RegisterOutcome> {
  const { event, user } = opts;

  const outcome = await db.transaction(async (tx) => {
    await lockEvent(tx, event.id);

    const status: "approved" | "pending" | "waitlisted" = await (async () => {
      if (event.model === "approval") return "pending";
      if (event.capacity !== null) {
        const approved = await approvedCountTx(tx, event.id);
        if (approved >= event.capacity) return "waitlisted";
      }
      return "approved";
    })();

    const inserted = await tx
      .insert(schema.registrations)
      .values({
        eventId: event.id,
        userId: user.id,
        status,
        fullName: opts.fullName,
        major: opts.major,
        classYear: opts.classYear,
        dietary: opts.dietary,
        resumeFileId: opts.resumeFileId,
        source: opts.source,
        plusOne: opts.plusOne && event.allowPlusOne,
        decidedAt: status === "approved" ? new Date() : null,
      })
      .returning();
    const registration = inserted[0];

    if (opts.customAnswers.length > 0) {
      await tx.insert(schema.answers).values(
        opts.customAnswers.map((a) => ({
          registrationId: registration.id,
          questionId: a.questionId,
          value: a.value as unknown,
        })),
      );
    }

    let ticket: TicketRow | null = null;
    if (status === "approved") {
      ticket = await issueTicketTx(tx, { event, registration, userEmail: user.email, userAndrewId: user.andrewId });
    }

    let waitlistPosition: number | null = null;
    if (status === "waitlisted") {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.registrations)
        .where(and(eq(schema.registrations.eventId, event.id), eq(schema.registrations.status, "waitlisted")));
      waitlistPosition = rows[0]?.count ?? 1;
    }

    return { registration, ticket, waitlistPosition };
  });

  // Emails after commit.
  const cName = await committeeName(event.committeeId);
  const info = eventEmailInfo(event, cName);
  if (outcome.ticket) {
    const mail = ticketEmail({ ev: info, guestName: opts.fullName, serial: outcome.ticket.serial, number: outcome.ticket.number });
    void sendMail({ to: user.email, ...mail });
  } else if (outcome.registration.status === "pending") {
    const mail = requestReceivedEmail({ ev: info, guestName: opts.fullName });
    void sendMail({ to: user.email, ...mail });
  } else if (outcome.registration.status === "waitlisted" && outcome.waitlistPosition !== null) {
    const mail = waitlistedEmail({ ev: info, position: outcome.waitlistPosition });
    void sendMail({ to: user.email, ...mail });
  }

  return outcome;
}

export async function approveRegistration(registrationId: string): Promise<{ ok: boolean; message?: string }> {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ registration: schema.registrations, event: schema.events, user: schema.users })
      .from(schema.registrations)
      .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
      .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
      .where(eq(schema.registrations.id, registrationId));
    const row = rows[0];
    if (!row) return { ok: false as const, message: "Registration not found" };
    if (row.registration.status === "approved") return { ok: true as const, already: true };
    if (!["pending", "waitlisted"].includes(row.registration.status)) {
      return { ok: false as const, message: `Can't approve a ${row.registration.status} registration` };
    }

    await lockEvent(tx, row.event.id);
    await tx
      .update(schema.registrations)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(schema.registrations.id, registrationId));
    const updatedReg = { ...row.registration, status: "approved" as const };
    const ticket = await issueTicketTx(tx, {
      event: row.event,
      registration: updatedReg,
      userEmail: row.user.email,
      userAndrewId: row.user.andrewId,
    });
    return { ok: true as const, row, ticket };
  });

  if (result.ok && "ticket" in result && result.ticket) {
    const cName = await committeeName(result.row.event.committeeId);
    const info = eventEmailInfo(result.row.event, cName);
    const wasWaitlisted = result.row.registration.status === "waitlisted";
    const mail = ticketEmail({
      ev: info,
      guestName: result.row.registration.fullName,
      serial: result.ticket.serial,
      number: result.ticket.number,
      promotedFromWaitlist: wasWaitlisted,
    });
    void sendMail({ to: result.row.user.email, ...mail });
  }
  return { ok: result.ok, message: "message" in result ? result.message : undefined };
}

/**
 * Promotes waitlisted registrations (in signup order) while capacity allows.
 * Returns how many guests were promoted; emails each of them their ticket.
 */
export async function promoteWaitlist(eventId: string): Promise<number> {
  const promotions: { email: string; fullName: string; serial: string; number: number }[] = [];

  const event = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0];
  if (!event || event.capacity === null) return 0;

  await db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    let approved = await approvedCountTx(tx, eventId);
    if (approved >= event.capacity!) return;

    const waiting = await tx
      .select({ registration: schema.registrations, user: schema.users })
      .from(schema.registrations)
      .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
      .where(and(eq(schema.registrations.eventId, eventId), eq(schema.registrations.status, "waitlisted")))
      .orderBy(asc(schema.registrations.createdAt));

    for (const w of waiting) {
      if (approved >= event.capacity!) break;
      await tx
        .update(schema.registrations)
        .set({ status: "approved", decidedAt: new Date() })
        .where(eq(schema.registrations.id, w.registration.id));
      const ticket = await issueTicketTx(tx, {
        event,
        registration: w.registration,
        userEmail: w.user.email,
        userAndrewId: w.user.andrewId,
      });
      promotions.push({ email: w.user.email, fullName: w.registration.fullName, serial: ticket.serial, number: ticket.number });
      approved += 1;
    }
  });

  if (promotions.length > 0) {
    const cName = await committeeName(event.committeeId);
    const info = eventEmailInfo(event, cName);
    for (const promo of promotions) {
      const mail = ticketEmail({ ev: info, guestName: promo.fullName, serial: promo.serial, number: promo.number, promotedFromWaitlist: true });
      void sendMail({ to: promo.email, ...mail });
    }
  }
  return promotions.length;
}

/**
 * Revokes a registration's primary ticket AND any claimed +1 child (linked by
 * parentTicketId, registrationId is null on the child) and marks the +1
 * transfer revoked. Used by both decline and cancel so the two paths can't
 * disagree — a removed guest's +1 must never still scan in at the door.
 */
async function revokeRegistrationTickets(tx: Tx, registrationId: string): Promise<void> {
  const now = new Date();
  const primary = await tx
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(eq(schema.tickets.registrationId, registrationId));
  await tx
    .update(schema.tickets)
    .set({ revokedAt: now })
    .where(and(eq(schema.tickets.registrationId, registrationId), isNull(schema.tickets.revokedAt)));
  if (primary[0]) {
    await tx
      .update(schema.tickets)
      .set({ revokedAt: now })
      .where(and(eq(schema.tickets.parentTicketId, primary[0].id), isNull(schema.tickets.revokedAt)));
    await tx
      .update(schema.ticketTransfers)
      .set({ status: "revoked", revokedAt: now })
      .where(and(eq(schema.ticketTransfers.ticketId, primary[0].id), eq(schema.ticketTransfers.status, "active")));
  }
}

export async function declineRegistration(registrationId: string): Promise<{ ok: boolean; promoted: number; message?: string }> {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ registration: schema.registrations, event: schema.events, user: schema.users })
      .from(schema.registrations)
      .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
      .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
      .where(eq(schema.registrations.id, registrationId));
    const row = rows[0];
    if (!row) return { ok: false as const, message: "Registration not found" };
    if (["declined", "cancelled"].includes(row.registration.status)) return { ok: true as const, row, wasApproved: false, already: true };

    await lockEvent(tx, row.event.id);
    // Re-read status under the lock — an approve may have committed between the
    // pre-lock SELECT and here, which would otherwise leave a live ticket.
    const fresh = await tx
      .select({ status: schema.registrations.status })
      .from(schema.registrations)
      .where(eq(schema.registrations.id, registrationId));
    const wasApproved = fresh[0]?.status === "approved";
    await tx
      .update(schema.registrations)
      .set({ status: "declined", decidedAt: new Date() })
      .where(eq(schema.registrations.id, registrationId));
    if (wasApproved) await revokeRegistrationTickets(tx, registrationId);
    return { ok: true as const, row, wasApproved, already: false };
  });

  if (!result.ok) return { ok: false, promoted: 0, message: result.message };
  if (result.already) return { ok: true, promoted: 0 }; // idempotent — don't re-email

  const cName = await committeeName(result.row.event.committeeId);
  const mail = declinedEmail({ ev: eventEmailInfo(result.row.event, cName) });
  void sendMail({ to: result.row.user.email, ...mail });

  const promoted = result.wasApproved ? await promoteWaitlist(result.row.event.id) : 0;
  return { ok: true, promoted };
}

export async function cancelRegistration(registrationId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.registrations)
      .where(and(eq(schema.registrations.id, registrationId), eq(schema.registrations.userId, userId)));
    const reg = rows[0];
    if (!reg) return { ok: false as const, message: "Registration not found" };
    if (["cancelled", "declined"].includes(reg.status)) return { ok: true as const, eventId: reg.eventId, wasApproved: false };

    await lockEvent(tx, reg.eventId);
    const fresh = await tx
      .select({ status: schema.registrations.status })
      .from(schema.registrations)
      .where(eq(schema.registrations.id, reg.id));
    const wasApproved = fresh[0]?.status === "approved";
    await tx.update(schema.registrations).set({ status: "cancelled", decidedAt: new Date() }).where(eq(schema.registrations.id, reg.id));
    if (wasApproved) await revokeRegistrationTickets(tx, reg.id);
    return { ok: true as const, eventId: reg.eventId, wasApproved };
  });

  if (result.ok && result.wasApproved) await promoteWaitlist(result.eventId);
  return { ok: result.ok, message: "message" in result ? result.message : undefined };
}

// ---------------------------------------------------------------------------
// +1 transfers
// ---------------------------------------------------------------------------

export async function claimTransfer(opts: {
  token: string;
  claimer: typeof schema.users.$inferSelect;
}): Promise<{ ok: true; ticket: TicketRow } | { ok: false; message: string }> {
  const { parseTransferToken } = await import("./transfers");
  const parsed = await parseTransferToken(opts.token);
  if (!parsed) return { ok: false, message: "That +1 link isn't valid." };

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ transfer: schema.ticketTransfers, ticket: schema.tickets, event: schema.events })
      .from(schema.ticketTransfers)
      .innerJoin(schema.tickets, eq(schema.ticketTransfers.ticketId, schema.tickets.id))
      .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
      .where(eq(schema.ticketTransfers.id, parsed.id));
    const row = rows[0];
    if (!row) return { ok: false as const, message: "That +1 link isn't valid." };
    if (row.transfer.status === "claimed") return { ok: false as const, message: "This +1 was already claimed." };
    if (row.transfer.status === "revoked") return { ok: false as const, message: "This +1 link was revoked by its owner." };
    if (row.ticket.revokedAt) return { ok: false as const, message: "The host's invite is no longer valid." };
    if (row.event.status !== "published") return { ok: false as const, message: "This event is no longer taking guests." };
    if (row.event.endAt < new Date()) return { ok: false as const, message: "This event has already ended." };
    if (row.ticket.userId === opts.claimer.id) return { ok: false as const, message: "That's your own +1 link — send it to a friend instead." };

    await lockEvent(tx, row.event.id);
    const serial = `SIT-${String(row.ticket.number).padStart(3, "0")}-P1`;
    const inserted = await tx
      .insert(schema.tickets)
      .values({
        eventId: row.event.id,
        registrationId: null,
        userId: opts.claimer.id,
        kind: "plus_one",
        parentTicketId: row.ticket.id,
        number: row.ticket.number,
        serial,
      })
      .returning();
    const plusOneTicket = inserted[0];
    await tx
      .update(schema.ticketTransfers)
      .set({ status: "claimed", claimedByUserId: opts.claimer.id, claimedTicketId: plusOneTicket.id, claimedAt: new Date() })
      .where(eq(schema.ticketTransfers.id, row.transfer.id));
    return { ok: true as const, plusOneTicket, row };
  });

  if (!result.ok) return result;

  // Notify the host + send the claimer their pass.
  const { row, plusOneTicket } = result;
  const cName = await committeeName(row.event.committeeId);
  const info = eventEmailInfo(row.event, cName);
  const hostRows = await db.select().from(schema.users).where(eq(schema.users.id, row.ticket.userId));
  const host = hostRows[0];
  const claimerName = opts.claimer.name || opts.claimer.email.split("@")[0];
  if (host) {
    const { plusOneClaimedEmail } = await import("../lib/emails");
    const mail = plusOneClaimedEmail({ ev: info, hostName: host.name ?? host.email, claimerName });
    void sendMail({ to: host.email, ...mail });
  }
  const mail = ticketEmail({ ev: info, guestName: claimerName, serial: plusOneTicket.serial, number: plusOneTicket.number });
  void sendMail({ to: opts.claimer.email, ...mail });

  return { ok: true, ticket: plusOneTicket };
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export interface CheckinOutcome {
  result: "ok" | "plus_one" | "duplicate" | "denied";
  guestName: string | null;
  serial: string | null;
  plusOne: boolean;
  hostName: string | null;
  originalAt: Date | null;
  message: string;
}

export async function checkinBySerial(opts: {
  eventId: string;
  serial: string;
  method: "qr" | "manual";
  byEmail: string;
}): Promise<CheckinOutcome> {
  const serial = opts.serial.trim().toUpperCase();

  const rows = await db
    .select({ ticket: schema.tickets, user: schema.users })
    .from(schema.tickets)
    .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
    .where(and(eq(schema.tickets.eventId, opts.eventId), eq(schema.tickets.serial, serial)));
  const row = rows[0];

  if (!row || row.ticket.revokedAt) {
    await db.insert(schema.checkins).values({
      eventId: opts.eventId,
      ticketId: null,
      serialAttempted: serial,
      result: "denied",
      method: opts.method,
      byEmail: opts.byEmail,
    });
    return {
      result: "denied",
      guestName: null,
      serial,
      plusOne: false,
      hostName: null,
      originalAt: null,
      message: row?.ticket.revokedAt ? "This pass was revoked — send them to registration." : "No pass with that serial — send them to registration.",
    };
  }

  const guestName = row.user.name ?? row.user.email.split("@")[0];
  const isPlusOne = row.ticket.kind === "plus_one";

  // Door-side defense: a +1 is only valid if its host's primary pass is still
  // valid. Even if a child ticket were ever left un-revoked, deny it here.
  if (isPlusOne && row.ticket.parentTicketId) {
    const parent = await db
      .select({ revokedAt: schema.tickets.revokedAt })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, row.ticket.parentTicketId));
    if (!parent[0] || parent[0].revokedAt) {
      await db.insert(schema.checkins).values({
        eventId: opts.eventId,
        ticketId: row.ticket.id,
        serialAttempted: serial,
        result: "denied",
        plusOne: true,
        method: opts.method,
        byEmail: opts.byEmail,
      });
      return {
        result: "denied",
        guestName,
        serial,
        plusOne: true,
        hostName: null,
        originalAt: null,
        message: "The host's invite was revoked — send them to registration.",
      };
    }
  }

  const existing = await db
    .select()
    .from(schema.checkins)
    .where(and(eq(schema.checkins.ticketId, row.ticket.id), eq(schema.checkins.result, "ok")))
    .orderBy(asc(schema.checkins.createdAt))
    .limit(1);

  if (existing.length > 0) {
    await db.insert(schema.checkins).values({
      eventId: opts.eventId,
      ticketId: row.ticket.id,
      serialAttempted: serial,
      result: "duplicate",
      plusOne: isPlusOne,
      method: opts.method,
      byEmail: opts.byEmail,
    });
    return {
      result: "duplicate",
      guestName,
      serial,
      plusOne: isPlusOne,
      hostName: null,
      originalAt: existing[0].createdAt,
      message: "Already scanned",
    };
  }

  await db.insert(schema.checkins).values({
    eventId: opts.eventId,
    ticketId: row.ticket.id,
    serialAttempted: serial,
    result: "ok",
    plusOne: isPlusOne,
    method: opts.method,
    byEmail: opts.byEmail,
  });

  let hostName: string | null = null;
  if (isPlusOne && row.ticket.parentTicketId) {
    const hostRows = await db
      .select({ user: schema.users })
      .from(schema.tickets)
      .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
      .where(eq(schema.tickets.id, row.ticket.parentTicketId));
    hostName = hostRows[0]?.user.name ?? hostRows[0]?.user.email.split("@")[0] ?? null;
  }

  return {
    result: isPlusOne ? "plus_one" : "ok",
    guestName,
    serial,
    plusOne: isPlusOne,
    hostName,
    originalAt: null,
    message: isPlusOne ? `+1 guest${hostName ? ` of ${hostName}` : ""}` : "Good to go",
  };
}

import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env, isCmuEmail } from "../env";
import { newToken, newSixDigitCode, sha256, initialsOf } from "../lib/crypto";
import { sendMail } from "../lib/mail";
import { signInEmail } from "../lib/emails";

const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;
const SESSION_PERSISTENT_DAYS = 30;
const SESSION_EPHEMERAL_HOURS = 24;
const MAX_VERIFY_ATTEMPTS = 5;

// -- in-memory rate limiting (single-instance deploy) ------------------------

interface Bucket {
  count: number;
  resetAt: number;
}
const emailBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

function bump(map: Map<string, Bucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = map.get(key);
  if (!b || b.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of emailBuckets) if (b.resetAt < now) emailBuckets.delete(k);
  for (const [k, b] of ipBuckets) if (b.resetAt < now) ipBuckets.delete(k);
}, 60_000).unref();

// -- helpers -----------------------------------------------------------------

export function andrewIdFor(email: string): string | null {
  return isCmuEmail(email) ? email.split("@")[0].toLowerCase() : null;
}

export async function findAdminByEmail(email: string) {
  const rows = await db
    .select({
      admin: schema.admins,
      committee: schema.committees,
    })
    .from(schema.admins)
    .innerJoin(schema.committees, eq(schema.admins.committeeId, schema.committees.id))
    .where(eq(schema.admins.email, email));
  return rows[0] ?? null;
}

async function transferTokenValid(token: string): Promise<boolean> {
  if (!token) return false;
  const { parseTransferToken } = await import("../services/transfers");
  const transfer = await parseTransferToken(token);
  return transfer !== null && transfer.status === "active";
}

// -- start / verify ----------------------------------------------------------

export type StartResult =
  | { ok: true }
  | { ok: false; error: "domain"; message: string }
  | { ok: false; error: "rate_limited"; message: string }
  | { ok: false; error: "mail_failed"; message: string };

export async function startAuth(opts: {
  email: string;
  keepSignedIn: boolean;
  transferToken?: string;
  ip: string;
}): Promise<StartResult> {
  const email = opts.email.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";

  // An existing account is itself proof of a legitimate path in (CMU email,
  // admin invite, or a +1 claim) — "same email, same account, every time".
  // Without this, a non-CMU +1 guest is locked out of their own ticket the
  // moment their transfer flips to claimed.
  const existingUser = async () =>
    (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))).length > 0;

  const allowed =
    isCmuEmail(email) ||
    (await findAdminByEmail(email)) !== null ||
    (await existingUser()) ||
    (opts.transferToken ? await transferTokenValid(opts.transferToken) : false);

  if (!allowed) {
    return {
      ok: false,
      error: "domain",
      message: `${domain} isn't a CMU domain. Guests get in through a friend's +1 link — organizers with outside emails need a super-admin invite.`,
    };
  }

  if (!bump(emailBuckets, email, 4, 10 * 60 * 1000)) {
    return { ok: false, error: "rate_limited", message: "Too many sign-in emails — try again in a few minutes." };
  }
  if (!bump(ipBuckets, opts.ip, 20, 60 * 60 * 1000)) {
    return { ok: false, error: "rate_limited", message: "Too many sign-in attempts from this network — try again later." };
  }

  const token = newToken();
  const code = newSixDigitCode();
  const inserted = await db
    .insert(schema.magicLinks)
    .values({
      email,
      tokenHash: sha256(token),
      codeHash: sha256(code),
      keepSignedIn: opts.keepSignedIn,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      ip: opts.ip,
    })
    .returning({ id: schema.magicLinks.id });

  const link = `${env.apiUrl}/api/auth/callback?token=${encodeURIComponent(token)}`;
  const mail = signInEmail({ link, code });
  const sent = await sendMail({ to: email, ...mail });
  if (!sent.ok) {
    // Remove the never-delivered link: consumeCode only checks the newest row
    // for this email, so leaving it would shadow a code the user already has.
    await db.delete(schema.magicLinks).where(eq(schema.magicLinks.id, inserted[0].id));
    return {
      ok: false,
      error: "mail_failed",
      message: "We couldn't send the email — the mail service rejected it. Wait a minute and try again.",
    };
  }
  return { ok: true };
}

export interface VerifiedSession {
  sessionToken: string;
  persistent: boolean;
  user: typeof schema.users.$inferSelect;
}

async function upsertUserByEmail(email: string): Promise<typeof schema.users.$inferSelect> {
  const now = new Date();
  const inserted = await db
    .insert(schema.users)
    .values({ email, andrewId: andrewIdFor(email), lastSignInAt: now })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { lastSignInAt: now },
    })
    .returning();
  const user = inserted[0];
  // First sign-in of an invited admin — mark accepted.
  await db
    .update(schema.admins)
    .set({ acceptedAt: now })
    .where(and(eq(schema.admins.email, email), isNull(schema.admins.acceptedAt)));
  return user;
}

async function createSession(userId: string, persistent: boolean): Promise<string> {
  const token = newToken();
  const ttlMs = persistent ? SESSION_PERSISTENT_DAYS * 86_400_000 : SESSION_EPHEMERAL_HOURS * 3_600_000;
  await db.insert(schema.sessions).values({
    userId,
    tokenHash: sha256(token),
    persistent,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

/** Validates + consumes the newest magic link for an email by 6-digit code. */
export async function consumeCode(
  email: string,
  code: string,
): Promise<{ link: typeof schema.magicLinks.$inferSelect } | { error: string; message: string }> {
  const normalized = email.trim().toLowerCase();
  const now = new Date();
  const links = await db
    .select()
    .from(schema.magicLinks)
    .where(and(eq(schema.magicLinks.email, normalized), isNull(schema.magicLinks.consumedAt), gt(schema.magicLinks.expiresAt, now)))
    .orderBy(desc(schema.magicLinks.createdAt))
    .limit(1);
  const link = links[0];
  if (!link) return { error: "invalid", message: "That code expired or was already used — request a new one." };

  // Atomic consume-if-correct: the code check, the single-use guard, and the
  // attempt cap all live in the WHERE clause, so concurrent /verify requests
  // can never each observe attempts<cap and slip past it (TOCTOU brute force).
  const consumed = await db
    .update(schema.magicLinks)
    .set({ consumedAt: now })
    .where(
      and(
        eq(schema.magicLinks.id, link.id),
        isNull(schema.magicLinks.consumedAt),
        lt(schema.magicLinks.attempts, MAX_VERIFY_ATTEMPTS),
        eq(schema.magicLinks.codeHash, sha256(code)),
      ),
    )
    .returning();
  if (consumed.length > 0) return { link: consumed[0] };

  // Wrong code (or already locked/consumed): atomically burn one attempt,
  // still bounded by the cap. Zero rows updated means locked or consumed.
  const bumped = await db
    .update(schema.magicLinks)
    .set({ attempts: sql`${schema.magicLinks.attempts} + 1` })
    .where(
      and(eq(schema.magicLinks.id, link.id), isNull(schema.magicLinks.consumedAt), lt(schema.magicLinks.attempts, MAX_VERIFY_ATTEMPTS)),
    )
    .returning({ attempts: schema.magicLinks.attempts });
  if (bumped.length === 0) return { error: "attempts", message: "Too many wrong tries — request a new code." };
  return { error: "wrong_code", message: "That's not the code we sent — check the newest email." };
}

export async function verifyByCode(email: string, code: string): Promise<VerifiedSession | { error: string; message: string }> {
  const result = await consumeCode(email, code);
  if ("error" in result) return result;
  const user = await upsertUserByEmail(result.link.email);
  const sessionToken = await createSession(user.id, result.link.keepSignedIn);
  return { sessionToken, persistent: result.link.keepSignedIn, user };
}

export async function verifyByToken(token: string): Promise<VerifiedSession | null> {
  const now = new Date();
  const consumed = await db
    .update(schema.magicLinks)
    .set({ consumedAt: now })
    .where(
      and(
        eq(schema.magicLinks.tokenHash, sha256(token)),
        isNull(schema.magicLinks.consumedAt),
        gt(schema.magicLinks.expiresAt, now),
      ),
    )
    .returning();
  const link = consumed[0];
  if (!link) return null;
  const user = await upsertUserByEmail(link.email);
  const sessionToken = await createSession(user.id, link.keepSignedIn);
  return { sessionToken, persistent: link.keepSignedIn, user };
}

// -- session resolution -------------------------------------------------------

export interface AuthContext {
  user: typeof schema.users.$inferSelect;
  session: typeof schema.sessions.$inferSelect;
  admin: { row: typeof schema.admins.$inferSelect; committee: typeof schema.committees.$inferSelect } | null;
}

export async function resolveSession(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const now = new Date();
  const rows = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, now)));
  const row = rows[0];
  if (!row) return null;

  // Rolling expiry — touch at most once an hour.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 3_600_000) {
    const ttlMs = row.session.persistent ? SESSION_PERSISTENT_DAYS * 86_400_000 : SESSION_EPHEMERAL_HOURS * 3_600_000;
    await db
      .update(schema.sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
      .where(eq(schema.sessions.id, row.session.id));
  }

  const adminRow = await findAdminByEmail(row.user.email);
  return {
    user: row.user,
    session: row.session,
    admin: adminRow ? { row: adminRow.admin, committee: adminRow.committee } : null,
  };
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, sha256(token)));
}

export function meFor(ctx: AuthContext | null) {
  if (!ctx) return { user: null, admin: null };
  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      andrewId: ctx.user.andrewId,
      initials: initialsOf(ctx.user.name || ctx.user.email),
    },
    admin: ctx.admin
      ? {
          role: ctx.admin.row.role,
          committee: {
            id: ctx.admin.committee.id,
            slug: ctx.admin.committee.slug,
            name: ctx.admin.committee.name,
            color: ctx.admin.committee.color,
            isAllClub: ctx.admin.committee.isAllClub,
          },
        }
      : null,
  };
}

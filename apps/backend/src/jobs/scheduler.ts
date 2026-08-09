import { and, eq, gte, isNull, lt, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { sendMail } from "../lib/mail";
import { digestEmail, escalationEmail } from "../lib/emails";
import { eventEmailInfo, promoteWaitlist } from "../services/registrations";

const DIGEST_INTERVAL_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

async function runDigests(): Promise<void> {
  const now = new Date();
  const events = await db
    .select({ event: schema.events, committee: schema.committees })
    .from(schema.events)
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(and(eq(schema.events.status, "published"), gte(schema.events.endAt, now)));

  for (const { event, committee } of events) {
    const interval = DIGEST_INTERVAL_MS[event.digest] ?? DIGEST_INTERVAL_MS.daily;
    if (now.getTime() - event.lastDigestAt.getTime() < interval) continue;

    const regs = await db
      .select({ status: schema.registrations.status, createdAt: schema.registrations.createdAt })
      .from(schema.registrations)
      .where(eq(schema.registrations.eventId, event.id));

    const newSignups = regs.filter((r) => r.createdAt > event.lastDigestAt && r.status !== "cancelled").length;
    const pendingCount = regs.filter((r) => r.status === "pending").length;
    const approved = regs.filter((r) => r.status === "approved").length;
    const waitlist = regs.filter((r) => r.status === "waitlisted").length;

    // Nothing to report: just advance the window so we don't recount later.
    if (newSignups === 0 && pendingCount === 0) {
      await db.update(schema.events).set({ lastDigestAt: now }).where(eq(schema.events.id, event.id));
      continue;
    }

    const mail = digestEmail({
      ev: eventEmailInfo(event, committee.name),
      newSignups,
      pendingCount,
      approved,
      capacity: event.capacity,
      waitlist,
      dashboardUrl: `${env.appUrl}/organize/${event.id}`,
      cadence: event.digest,
    });
    const sent = await sendMail({ to: event.updatesEmail, ...mail });
    // Only advance the window once the digest actually went out — a failed
    // send must not silently swallow this batch of signups.
    if (sent.ok) await db.update(schema.events).set({ lastDigestAt: now }).where(eq(schema.events.id, event.id));
  }
}

async function runEscalations(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const overdue = await db
    .select({ registration: schema.registrations, event: schema.events, committee: schema.committees })
    .from(schema.registrations)
    .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(
      and(
        eq(schema.registrations.status, "pending"),
        lt(schema.registrations.createdAt, cutoff),
        isNull(schema.registrations.escalatedAt),
        eq(schema.events.status, "published"),
        gte(schema.events.endAt, new Date()),
      ),
    );

  const byEvent = new Map<string, { event: typeof schema.events.$inferSelect; committee: typeof schema.committees.$inferSelect; regs: (typeof schema.registrations.$inferSelect)[] }>();
  for (const row of overdue) {
    const bucket = byEvent.get(row.event.id) ?? { event: row.event, committee: row.committee, regs: [] };
    bucket.regs.push(row.registration);
    byEvent.set(row.event.id, bucket);
  }

  for (const { event, committee, regs } of byEvent.values()) {
    const oldest = regs.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), regs[0].createdAt);
    const oldestHours = Math.round((Date.now() - oldest.getTime()) / 3_600_000);
    const mail = escalationEmail({
      ev: eventEmailInfo(event, committee.name),
      count: regs.length,
      oldestHours,
      dashboardUrl: `${env.appUrl}/organize/${event.id}`,
    });
    await sendMail({ to: event.updatesEmail, ...mail });
    await db
      .update(schema.registrations)
      .set({ escalatedAt: new Date() })
      .where(inArray(schema.registrations.id, regs.map((r) => r.id)));
  }
}

/** Safety net: capacity events occasionally re-check for promotable waitlisters. */
async function runWaitlistSweep(): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(eq(schema.events.status, "published"), gte(schema.events.endAt, now), sql`${schema.events.capacity} is not null`));
  for (const row of rows) await promoteWaitlist(row.id);
}

export function startScheduler(): void {
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // never let a slow tick overlap the next — breaks exactly-once escalation
    ticking = true;
    try {
      await runDigests();
      await runEscalations();
      await runWaitlistSweep();
    } catch (err) {
      console.error("[scheduler] tick failed:", err);
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 5 * 60 * 1000).unref();
  console.log("[scheduler] digests + escalations every 5 minutes");
}

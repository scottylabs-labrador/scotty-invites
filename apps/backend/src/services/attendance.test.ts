import { describe, expect, it } from "vitest";

const TEST_ENV = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5433/scottylabs_invites",
  TRANSFER_LINK_SECRET: "test-secret-not-used-here-0123456789abcdef",
  SEED_SUPER_ADMIN_EMAILS: "",
  MAIL_MODE: "console",
};
for (const [k, v] of Object.entries(TEST_ENV)) if (process.env[k] === undefined) process.env[k] = v;

import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import * as schema from "../db/schema";
import { attendanceLong, attendancePeople } from "./attendance";

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const HOUR = 3600_000;

/** Seeds two committees with events in every state the spec cares about. */
async function seedFixture() {
  const tag = uniq();
  const [comA] = await db.insert(schema.committees).values({ slug: `att-a-${tag}`, name: `AttA ${tag}`, color: "#111111" }).returning();
  const [comB] = await db.insert(schema.committees).values({ slug: `att-b-${tag}`, name: `AttB ${tag}`, color: "#222222" }).returning();

  const ev = (committeeId: string, title: string, startOffsetMs: number, status: "published" | "cancelled") =>
    db.insert(schema.events).values({
      shortCode: `e${uniq()}`,
      title: `${title} ${tag}`,
      committeeId,
      category: "Work sessions",
      audience: "cmu",
      model: "instant",
      startAt: new Date(Date.now() + startOffsetMs),
      endAt: new Date(Date.now() + startOffsetMs + 3 * HOUR),
      location: "Test Room",
      updatesEmail: "test@scottylabs.org",
      contactEmail: "test@scottylabs.org",
      status,
      createdByEmail: "test@scottylabs.org",
    }).returning().then((r) => r[0]);

  const pastA = await ev(comA.id, "PastA", -48 * HOUR, "published");
  const futureA = await ev(comA.id, "FutureA", 48 * HOUR, "published");
  const cancelledA = await ev(comA.id, "CancelledA", -24 * HOUR, "cancelled");
  const pastB = await ev(comB.id, "PastB", -48 * HOUR, "published");

  const user = (local: string, name: string | null) =>
    db.insert(schema.users).values({ email: `${local}-${tag}@andrew.cmu.edu`, name, andrewId: `${local}${tag.slice(-4)}` }).returning().then((r) => r[0]);
  const alice = await user("att-alice", "Alice A");
  const bob = await user("att-bob", "Bob B");
  const guest = await user("att-guest", "Guest G");
  const carol = await user("att-carol", "Carol C");

  let n = 0;
  const ticket = async (eventId: string, userId: string, extra: Partial<typeof schema.tickets.$inferInsert> = {}) => {
    n += 1;
    const [row] = await db.insert(schema.tickets).values({
      eventId, userId, number: n, serial: `ATT-${tag}-${n}`, kind: "primary", ...extra,
    }).returning();
    return row;
  };

  // Alice: attended pastA (qr), upcoming futureA. Bob: no-show pastA, cancelled-event ticket.
  const tAlicePast = await ticket(pastA.id, alice.id);
  const tAliceFuture = await ticket(futureA.id, alice.id);
  const tBobPast = await ticket(pastA.id, bob.id);
  const tBobCancelled = await ticket(cancelledA.id, bob.id);
  // Guest is Alice's +1 on pastA and attended. Carol's ticket on pastA is revoked.
  const tGuest = await ticket(pastA.id, guest.id, { kind: "plus_one", parentTicketId: tAlicePast.id });
  await ticket(pastA.id, carol.id, { revokedAt: new Date() });
  // Bob attended pastB (other committee) so scoping is observable.
  const tBobB = await ticket(pastB.id, bob.id);

  const ok = (eventId: string, ticketId: string, method: "qr" | "manual", atMs: number) =>
    db.insert(schema.checkins).values({
      eventId, ticketId, serialAttempted: "x", result: "ok", method, byEmail: "door@scottylabs.org",
      createdAt: new Date(atMs),
    });
  await ok(pastA.id, tAlicePast.id, "qr", Date.now() - 47 * HOUR);
  await ok(pastA.id, tGuest.id, "manual", Date.now() - 46 * HOUR);
  await ok(pastB.id, tBobB.id, "qr", Date.now() - 40 * HOUR);
  // A stranger denied at pastA's door — no ticket at all.
  await db.insert(schema.checkins).values({
    eventId: pastA.id, ticketId: null, serialAttempted: `SIT-999-GHOST${tag.slice(-4)}`,
    result: "denied", method: "qr", byEmail: "door@scottylabs.org",
  });

  return { tag, comA, comB, pastA, futureA, cancelledA, pastB, alice, bob, guest, carol };
}

describe("attendanceLong", () => {
  it("classifies attended / no_show / upcoming / cancelled and excludes revoked tickets", async () => {
    const f = await seedFixture();
    const rows = await attendanceLong({ committeeId: f.comA.id });
    const by = (email: string, title: string) =>
      rows.find((r) => r.email === email && r.eventTitle.startsWith(title));

    expect(by(f.alice.email, "PastA")?.status).toBe("attended");
    expect(by(f.alice.email, "PastA")?.checkinMethod).toBe("qr");
    expect(by(f.alice.email, "PastA")?.checkedInAt).not.toBe("");
    expect(by(f.alice.email, "FutureA")?.status).toBe("upcoming");
    expect(by(f.bob.email, "PastA")?.status).toBe("no_show");
    expect(by(f.bob.email, "CancelledA")?.status).toBe("cancelled");
    expect(rows.find((r) => r.email === f.carol.email)).toBeUndefined();       // revoked
    expect(rows.find((r) => r.eventTitle.startsWith("PastB"))).toBeUndefined(); // other committee
  });

  it("marks +1 rows with the host's name", async () => {
    const f = await seedFixture();
    const rows = await attendanceLong({ committeeId: f.comA.id });
    const g = rows.find((r) => r.email === f.guest.email);
    expect(g?.plusOne).toBe(true);
    expect(g?.hostName).toBe("Alice A");
    expect(g?.status).toBe("attended");
  });

  it("includes denied-at-door attempts with serial-derived identity", async () => {
    const f = await seedFixture();
    const rows = await attendanceLong({ committeeId: f.comA.id });
    const d = rows.find((r) => r.status === "denied_at_door");
    expect(d).toBeDefined();
    expect(d?.email).toBe("");
    expect(d?.andrewId).toBe(`ghost${f.tag.slice(-4)}`.toLowerCase());
  });

  it("scope null sees every committee", async () => {
    const f = await seedFixture();
    const rows = await attendanceLong({ committeeId: null });
    expect(rows.some((r) => r.eventTitle.startsWith(`PastB ${f.tag}`))).toBe(true);
  });
});

describe("attendancePeople", () => {
  it("rolls up counts, rate, and first/last attended per person", async () => {
    const f = await seedFixture();
    const people = await attendancePeople({ committeeId: f.comA.id });
    const alice = people.find((p) => p.email === f.alice.email);
    const bob = people.find((p) => p.email === f.bob.email);

    // Alice: pastA attended + futureA upcoming → 2 signed up, 1 attended, 0 no-shows, rate 1.00
    expect(alice).toMatchObject({ eventsSignedUp: 2, eventsAttended: 1, noShows: 0, plusOnesBrought: 1, attendanceRate: "1.00" });
    expect(alice?.firstAttendedAt).not.toBe("");
    expect(alice?.firstAttendedAt).toBe(alice?.lastAttendedAt);

    // Bob in comA: pastA no-show + cancelled ticket → 2 signed up, 0 attended, 1 no-show, rate 0.00
    expect(bob).toMatchObject({ eventsSignedUp: 2, eventsAttended: 0, noShows: 1, attendanceRate: "0.00" });

    // Carol only had a revoked ticket → absent entirely
    expect(people.find((p) => p.email === f.carol.email)).toBeUndefined();
  });

  it("scopes to the committee (Bob's PastB attendance only appears unscoped)", async () => {
    const f = await seedFixture();
    const scoped = await attendancePeople({ committeeId: f.comA.id });
    expect(scoped.find((p) => p.email === f.bob.email)?.eventsAttended).toBe(0);
    const all = await attendancePeople({ committeeId: null });
    expect((all.find((p) => p.email === f.bob.email)?.eventsAttended ?? 0) >= 1).toBe(true);
  });

  it("gives someone with no finished events an empty attendance rate", async () => {
    const f = await seedFixture();
    const people = await attendancePeople({ committeeId: f.comA.id });
    // Guest attended (rate defined); construct the empty case from Alice-future only:
    // a person whose only ticket is upcoming — seed inline here.
    const [dana] = await db.insert(schema.users)
      .values({ email: `att-dana-${f.tag}@andrew.cmu.edu`, name: "Dana D", andrewId: `dana${f.tag.slice(-4)}` }).returning();
    await db.insert(schema.tickets).values({
      eventId: f.futureA.id, userId: dana.id, number: 999999, serial: `ATT-${f.tag}-D`, kind: "primary",
    });
    const after = await attendancePeople({ committeeId: f.comA.id });
    expect(after.find((p) => p.email === dana.email)).toMatchObject({
      eventsSignedUp: 1, eventsAttended: 0, noShows: 0, attendanceRate: "",
    });
    void people;
  });
});

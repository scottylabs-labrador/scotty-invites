# Cross-Event Attendance CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One committee-scoped endpoint, `GET /api/org/attendance.csv?shape=people|long`, exporting who shows up across events, plus two download buttons on the organizer page.

**Architecture:** A new pure-query service (`apps/backend/src/services/attendance.ts`) aggregates `events ⋈ tickets ⋈ users ⋈ checkins (⋈ registrations for source)` into row objects; a thin Fastify route beside the existing per-event `export.csv` in `server.ts` renders them with the existing `toCsv` helper; the web change is two `<a>` pills on `OrganizePage`. No new tables, no ts-rest contract change.

**Tech Stack:** Fastify, drizzle-orm (node-postgres), vitest (tests run against the real local Postgres on 5433 — `pnpm test` migrates first), React (web).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-cross-event-attendance-design.md` — column lists and status definitions there are normative.
- Branch: `feat/cross-event-attendance`. Commit after each task.
- TDD: write the failing test, RUN it and see it fail for the right reason, then implement.
- All backend tests: `cd apps/backend && pnpm test` (requires local Postgres on 5433 — embedded-postgres via the session scratchpad `start-pg.mjs`, or the README Docker recipe).
- Status semantics (from spec): `attended` = ticket has ≥1 `ok` check-in; `no_show` = un-revoked ticket, event `status='published'` and `end_at` past, no `ok` check-in; `upcoming` = published event not yet ended; `cancelled` = un-attended ticket on a cancelled event; `denied_at_door` = a `checkins` row with `result='denied'`.
- Scoping: committee admins see only their committee's events; super admins see all, optional `?committee=<uuid>` filter. (`request.authCtx.admin.row.role === "super_admin"`, else `.committeeId`.)
- CSV: always through `toCsv` from `apps/backend/src/lib/csv.ts` (BOM, CRLF, formula-injection guard).

---

### Task 1: Attendance service — `long` shape

**Files:**
- Create: `apps/backend/src/services/attendance.ts`
- Test: `apps/backend/src/services/attendance.test.ts`

**Interfaces:**
- Consumes: `db` from `../db/client`, `* as schema` from `../db/schema`, drizzle `and, asc, eq, inArray, isNull`.
- Produces (Tasks 2–3 rely on these exact names):

```ts
export interface AttendanceScope { committeeId: string | null }  // null = all committees
export type LongStatus = "attended" | "no_show" | "upcoming" | "cancelled" | "denied_at_door";
export interface LongRow {
  eventTitle: string; eventDate: string; eventStatus: string; committee: string;
  name: string; andrewId: string; email: string; status: LongStatus;
  checkinMethod: string; checkedInAt: string; plusOne: boolean; hostName: string; source: string;
}
export async function attendanceLong(scope: AttendanceScope): Promise<LongRow[]>
```

- [ ] **Step 1: Write the failing test**

`apps/backend/src/services/attendance.test.ts` — the seed helper below is also used by Task 2, write it complete now. Env must be set before importing the service (matches `auth/service.test.ts`).

```ts
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
      shortCode: `e${uniq()}`.slice(0, 12),
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
```

Field names in the seed helper must match `apps/backend/src/db/schema.ts` (events at :94, tickets at :200, checkins at :247) — if tsc complains, fix the seed to the schema, never the schema.

- [ ] **Step 2: Run it, confirm it fails because the module doesn't exist**

Run: `cd apps/backend && pnpm test src/services/attendance.test.ts`
Expected: FAIL — cannot resolve `./attendance` (and `attendancePeople` import will also be unresolved until Task 2; export a stub `attendancePeople` in Step 3 so only real assertions fail).

- [ ] **Step 3: Implement `attendanceLong`**

`apps/backend/src/services/attendance.ts`:

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import * as schema from "../db/schema";

export interface AttendanceScope {
  committeeId: string | null; // null = all committees (super admin)
}

export type LongStatus = "attended" | "no_show" | "upcoming" | "cancelled" | "denied_at_door";

export interface LongRow {
  eventTitle: string; eventDate: string; eventStatus: string; committee: string;
  name: string; andrewId: string; email: string; status: LongStatus;
  checkinMethod: string; checkedInAt: string; plusOne: boolean; hostName: string; source: string;
}

interface BaseData {
  events: (typeof schema.events.$inferSelect)[];
  committeeName: Map<string, string>;
  tickets: (typeof schema.tickets.$inferSelect)[]; // all, incl. revoked (host/denied lookups)
  userById: Map<string, typeof schema.users.$inferSelect>;
  firstOkByTicket: Map<string, typeof schema.checkins.$inferSelect>;
  denied: (typeof schema.checkins.$inferSelect)[];
  sourceByReg: Map<string, string>;
  ticketById: Map<string, typeof schema.tickets.$inferSelect>;
}

async function fetchBase(scope: AttendanceScope): Promise<BaseData> {
  const events = scope.committeeId
    ? await db.select().from(schema.events).where(eq(schema.events.committeeId, scope.committeeId))
    : await db.select().from(schema.events);
  const eventIds = events.map((e) => e.id);
  const empty: BaseData = {
    events, committeeName: new Map(), tickets: [], userById: new Map(),
    firstOkByTicket: new Map(), denied: [], sourceByReg: new Map(), ticketById: new Map(),
  };
  if (eventIds.length === 0) return empty;

  const committees = await db.select().from(schema.committees);
  const committeeName = new Map(committees.map((c) => [c.id, c.name]));

  const tickets = await db.select().from(schema.tickets).where(inArray(schema.tickets.eventId, eventIds));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const userIds = [...new Set(tickets.map((t) => t.userId))];
  const users = userIds.length
    ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const checkins = await db
    .select().from(schema.checkins)
    .where(inArray(schema.checkins.eventId, eventIds))
    .orderBy(asc(schema.checkins.createdAt));
  const firstOkByTicket = new Map<string, typeof schema.checkins.$inferSelect>();
  for (const c of checkins) {
    if (c.result === "ok" && c.ticketId && !firstOkByTicket.has(c.ticketId)) firstOkByTicket.set(c.ticketId, c);
  }
  const denied = checkins.filter((c) => c.result === "denied");

  const regIds = [...new Set(tickets.map((t) => t.registrationId).filter((x): x is string => !!x))];
  const regs = regIds.length
    ? await db.select({ id: schema.registrations.id, source: schema.registrations.source })
        .from(schema.registrations).where(inArray(schema.registrations.id, regIds))
    : [];
  const sourceByReg = new Map(regs.map((r) => [r.id, r.source ?? ""]));

  return { events, committeeName, tickets, userById, firstOkByTicket, denied, sourceByReg, ticketById };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
const displayName = (u: { name: string | null; email: string } | undefined) =>
  u ? (u.name ?? u.email.split("@")[0]) : "";

function ticketStatus(
  event: typeof schema.events.$inferSelect,
  attended: boolean,
  now: number,
): Exclude<LongStatus, "denied_at_door"> {
  if (attended) return "attended";
  if (event.status === "cancelled") return "cancelled";
  return event.endAt.getTime() < now ? "no_show" : "upcoming";
}

export async function attendanceLong(scope: AttendanceScope): Promise<LongRow[]> {
  const base = await fetchBase(scope);
  const now = Date.now();
  const eventById = new Map(base.events.map((e) => [e.id, e]));
  const rows: LongRow[] = [];

  for (const t of base.tickets) {
    if (t.revokedAt) continue;
    const event = eventById.get(t.eventId);
    if (!event) continue;
    const user = base.userById.get(t.userId);
    const ok = base.firstOkByTicket.get(t.id);
    const host = t.parentTicketId ? base.userById.get(base.ticketById.get(t.parentTicketId)?.userId ?? "") : undefined;
    rows.push({
      eventTitle: event.title,
      eventDate: iso(event.startAt),
      eventStatus: event.status,
      committee: base.committeeName.get(event.committeeId) ?? "",
      name: displayName(user),
      andrewId: user?.andrewId ?? "",
      email: user?.email ?? "",
      status: ticketStatus(event, !!ok, now),
      checkinMethod: ok?.method ?? "",
      checkedInAt: iso(ok?.createdAt),
      plusOne: t.kind === "plus_one",
      hostName: displayName(host),
      source: t.registrationId ? base.sourceByReg.get(t.registrationId) ?? "" : "",
    });
  }

  for (const c of base.denied) {
    const event = eventById.get(c.eventId);
    if (!event) continue;
    const ticket = c.ticketId ? base.ticketById.get(c.ticketId) : undefined;
    const user = ticket ? base.userById.get(ticket.userId) : undefined;
    rows.push({
      eventTitle: event.title,
      eventDate: iso(event.startAt),
      eventStatus: event.status,
      committee: base.committeeName.get(event.committeeId) ?? "",
      name: displayName(user),
      andrewId: user?.andrewId ?? (c.serialAttempted?.split("-").pop() ?? "").toLowerCase(),
      email: user?.email ?? "",
      status: "denied_at_door",
      checkinMethod: c.method ?? "",
      checkedInAt: iso(c.createdAt),
      plusOne: ticket?.kind === "plus_one",
      hostName: "",
      source: "",
    });
  }

  rows.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.email.localeCompare(b.email));
  return rows;
}

// Implemented in Task 2 — stub keeps Task 1's test file compiling.
export async function attendancePeople(scope: AttendanceScope): Promise<never[]> {
  void scope;
  return [];
}
```

If `checkins.method`'s column type makes `c.method` non-nullable, drop the `?? ""`. Match schema exactly.

- [ ] **Step 4: Run the Task 1 tests, confirm PASS**

Run: `cd apps/backend && pnpm test src/services/attendance.test.ts`
Expected: the four `attendanceLong` tests PASS. (`attendancePeople` tests don't exist yet.)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/attendance.ts apps/backend/src/services/attendance.test.ts
git commit -m "feat: cross-event attendance service (long shape)"
```

---

### Task 2: Attendance service — `people` rollup

**Files:**
- Modify: `apps/backend/src/services/attendance.ts` (replace the `attendancePeople` stub)
- Test: `apps/backend/src/services/attendance.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `fetchBase`, `displayName`, `ticketStatus`, `iso` from Task 1 (same file).
- Produces (Task 3 relies on these exact names):

```ts
export interface PersonRow {
  name: string; andrewId: string; email: string;
  eventsSignedUp: number; eventsAttended: number; noShows: number; plusOnesBrought: number;
  firstAttendedAt: string; lastAttendedAt: string; attendanceRate: string;
}
export async function attendancePeople(scope: AttendanceScope): Promise<PersonRow[]>
```

- [ ] **Step 1: Append the failing tests**

```ts
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
```

- [ ] **Step 2: Run, confirm the new tests fail (stub returns `[]`)**

Run: `cd apps/backend && pnpm test src/services/attendance.test.ts`
Expected: Task 1 tests PASS, the three new ones FAIL (`undefined` person rows).

- [ ] **Step 3: Replace the stub**

```ts
export interface PersonRow {
  name: string; andrewId: string; email: string;
  eventsSignedUp: number; eventsAttended: number; noShows: number; plusOnesBrought: number;
  firstAttendedAt: string; lastAttendedAt: string; attendanceRate: string;
}

export async function attendancePeople(scope: AttendanceScope): Promise<PersonRow[]> {
  const base = await fetchBase(scope);
  const now = Date.now();
  const eventById = new Map(base.events.map((e) => [e.id, e]));

  interface Acc { signedUp: number; attended: number; noShows: number; plusOnes: number; first: Date | null; last: Date | null }
  const acc = new Map<string, Acc>();
  const get = (userId: string): Acc => {
    let a = acc.get(userId);
    if (!a) { a = { signedUp: 0, attended: 0, noShows: 0, plusOnes: 0, first: null, last: null }; acc.set(userId, a); }
    return a;
  };

  for (const t of base.tickets) {
    if (t.revokedAt) continue;
    const event = eventById.get(t.eventId);
    if (!event) continue;
    const ok = base.firstOkByTicket.get(t.id);
    const status = ticketStatus(event, !!ok, now);
    const a = get(t.userId);
    a.signedUp += 1;
    if (status === "attended") {
      a.attended += 1;
      const at = ok!.createdAt;
      if (!a.first || at < a.first) a.first = at;
      if (!a.last || at > a.last) a.last = at;
      if (t.kind === "plus_one" && t.parentTicketId) {
        const host = base.ticketById.get(t.parentTicketId);
        if (host) get(host.userId).plusOnes += 1;
      }
    } else if (status === "no_show") {
      a.noShows += 1;
    }
  }

  const rows: PersonRow[] = [];
  for (const [userId, a] of acc) {
    const u = base.userById.get(userId);
    if (!u) continue;
    const denom = a.attended + a.noShows;
    rows.push({
      name: displayName(u),
      andrewId: u.andrewId ?? "",
      email: u.email,
      eventsSignedUp: a.signedUp,
      eventsAttended: a.attended,
      noShows: a.noShows,
      plusOnesBrought: a.plusOnes,
      firstAttendedAt: iso(a.first),
      lastAttendedAt: iso(a.last),
      attendanceRate: denom === 0 ? "" : (a.attended / denom).toFixed(2),
    });
  }
  rows.sort((a, b) => a.email.localeCompare(b.email));
  return rows;
}
```

Note the +1 credit goes to the **host ticket's user**, and a host with `plusOnesBrought` but no own ticket still gets an Acc entry — `userById` covers them because the +1's host ticket is in `tickets`.

- [ ] **Step 4: Run all attendance tests, confirm PASS**

Run: `cd apps/backend && pnpm test src/services/attendance.test.ts`
Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/attendance.ts apps/backend/src/services/attendance.test.ts
git commit -m "feat: cross-event attendance people rollup"
```

---

### Task 3: `GET /api/org/attendance.csv` route

**Files:**
- Modify: `apps/backend/src/server.ts` — insert directly AFTER the `app.get("/api/org/events/:id/export.csv", ...)` handler (starts ~line 230)
- Test: `apps/backend/src/routes/attendance-route.test.ts`

**Interfaces:**
- Consumes: `attendanceLong`, `attendancePeople`, `AttendanceScope` (Task 1–2), `toCsv` (already imported in server.ts), `request.authCtx` (existing auth hook), `buildServer` from `../server`.
- Produces: the HTTP endpoint used verbatim by Task 4's `<a href>`s.

- [ ] **Step 1: Write the failing route test**

`apps/backend/src/routes/attendance-route.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_ENV = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5433/scottylabs_invites",
  TRANSFER_LINK_SECRET: "test-secret-not-used-here-0123456789abcdef",
  SEED_SUPER_ADMIN_EMAILS: "",
  MAIL_MODE: "console",
};
for (const [k, v] of Object.entries(TEST_ENV)) if (process.env[k] === undefined) process.env[k] = v;

import type { FastifyInstance } from "fastify";
import { buildServer } from "../server";

describe("GET /api/org/attendance.csv", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/attendance.csv?shape=long" });
    expect(res.statusCode).toBe(401);
  });

  it("is registered (does not 404)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/attendance.csv" });
    expect(res.statusCode).not.toBe(404);
  });
});
```

- [ ] **Step 2: Run, confirm the second test fails with 404**

Run: `cd apps/backend && pnpm test src/routes/attendance-route.test.ts`
Expected: "rejects unauthenticated" may already pass via a global guard or fail on 404 — the registration test MUST fail with 404 before implementation.

- [ ] **Step 3: Implement the route in `server.ts`**

Add import at the top with the other service imports:

```ts
import { attendanceLong, attendancePeople } from "./services/attendance";
```

Insert after the per-event export.csv handler's closing `});`:

```ts
  // Cross-event attendance CSV — committee-scoped, two shapes (people | long).
  app.get("/api/org/attendance.csv", async (request, reply) => {
    const ctx = request.authCtx;
    if (!ctx?.admin) return reply.status(401).send({ error: "unauthorized", message: "Organizers only." });
    const q = request.query as { shape?: string; committee?: string };
    if (q.shape !== "people" && q.shape !== "long") {
      return reply.status(400).send({ error: "bad_shape", message: "shape must be people or long" });
    }
    const committeeId =
      ctx.admin.row.role === "super_admin" ? (q.committee ?? null) : ctx.admin.row.committeeId;

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="attendance-${q.shape}.csv"`);

    if (q.shape === "people") {
      const rows = await attendancePeople({ committeeId });
      return reply.send(toCsv(
        ["Name", "Andrew ID", "Email", "Events signed up", "Events attended", "No-shows", "Plus-ones brought", "First attended", "Last attended", "Attendance rate"],
        rows.map((p) => [p.name, p.andrewId, p.email, p.eventsSignedUp, p.eventsAttended, p.noShows, p.plusOnesBrought, p.firstAttendedAt, p.lastAttendedAt, p.attendanceRate]),
      ));
    }
    const rows = await attendanceLong({ committeeId });
    return reply.send(toCsv(
      ["Event", "Date", "Event status", "Committee", "Name", "Andrew ID", "Email", "Status", "Check-in method", "Checked in at", "Plus one", "Host", "Source"],
      rows.map((r) => [r.eventTitle, r.eventDate, r.eventStatus, r.committee, r.name, r.andrewId, r.email, r.status, r.checkinMethod, r.checkedInAt, r.plusOne ? "yes" : "no", r.hostName, r.source]),
    ));
  });
```

If `ctx.admin.row.committeeId` is nullable for super admins only, the ternary already covers it; if tsc flags null for committee admins, coalesce: `ctx.admin.row.committeeId ?? null`.

- [ ] **Step 4: Run route + all backend tests, confirm PASS**

Run: `cd apps/backend && pnpm test`
Expected: all suites PASS (auth 3, attendance 7, route 2).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/server.ts apps/backend/src/routes/attendance-route.test.ts
git commit -m "feat: /api/org/attendance.csv export route"
```

---

### Task 4: Organizer-page download buttons + full verification

**Files:**
- Modify: `apps/web/src/pages/OrganizePage.tsx` — after the header actions flex row (the `div` with `marginLeft: "auto"` containing Edit event / Export CSV / Open check-in, ends ~line 253)

**Interfaces:**
- Consumes: the Task 3 endpoint; `DownloadIcon` already imported/used by the per-event Export CSV link in this file.

- [ ] **Step 1: Add the buttons**

Immediately after the closing `</div>` of that actions row's PARENT header container (the one wrapping both the title block and the actions row), insert:

```tsx
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontFamily: "var(--font-ui)" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>Attendance across events</span>
        <a href="/api/org/attendance.csv?shape=people" className="pill pill-outline" style={{ fontSize: 12, padding: "7px 16px" }}>
          <DownloadIcon size={13} />
          People CSV
        </a>
        <a href="/api/org/attendance.csv?shape=long" className="pill pill-outline" style={{ fontSize: 12, padding: "7px 16px" }}>
          <DownloadIcon size={13} />
          Full history CSV
        </a>
      </div>
```

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r typecheck` (repo root)
Expected: contract, backend, web all "Done" with no errors.

- [ ] **Step 3: Verify in the running app**

With local Postgres on 5433 and both dev servers up (`.claude/launch.json` has `backend` and `web`):
1. Sign in at `http://localhost:5173/signin` (console-mode code is printed in backend logs) as the seeded super admin.
2. Open `/organize` — the "Attendance across events" row renders under the header.
3. `curl` both shapes with the browser session, or click both buttons: each downloads a CSV whose header row matches Task 3 exactly, containing the local test data (the vitest fixtures land in the same dev DB — rows prefixed `att-` are expected).
4. `curl -i "http://localhost:4000/api/org/attendance.csv?shape=nope"` with the session cookie → 400 `bad_shape`; without a cookie → 401.

Expected: all four observations hold.

- [ ] **Step 4: Run the complete backend suite one final time**

Run: `cd apps/backend && pnpm test && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/OrganizePage.tsx
git commit -m "feat: attendance CSV download buttons on organizer page"
```

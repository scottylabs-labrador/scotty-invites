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
      checkinMethod: c.method,
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

import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client";

/**
 * The joined ticket a wallet pass is built from, flattened to plain values so
 * the pass builders can be imported (and tested) without touching the database.
 *
 * passStyle is deliberately widened to `string`: the Drizzle column type
 * (schema.ts:114) is a TypeScript-only union, not a Postgres CHECK, so a third
 * value is representable. Both builders therefore use the same
 * `passStyle !== "light"` predicate — see Global Constraints.
 */
export interface PassRow {
  ticket: { id: string; serial: string; number: number; kind: string };
  event: {
    title: string;
    location: string;
    shortCode: string;
    startAt: Date;
    endAt: Date;
    passStyle: string;
    contactEmail: string;
  };
  user: { name: string | null; email: string };
  committee: { name: string };
}

/** Live, non-revoked ticket owned by this user. Null means 404. */
export async function loadPassRow(ticketId: string, userId: string): Promise<PassRow | null> {
  const rows = await db
    .select({ ticket: schema.tickets, event: schema.events, user: schema.users, committee: schema.committees })
    .from(schema.tickets)
    .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
    .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, userId), isNull(schema.tickets.revokedAt)));

  const r = rows[0];
  if (!r) return null;
  return {
    ticket: { id: r.ticket.id, serial: r.ticket.serial, number: r.ticket.number, kind: r.ticket.kind },
    event: {
      title: r.event.title,
      location: r.event.location,
      shortCode: r.event.shortCode,
      startAt: r.event.startAt,
      endAt: r.event.endAt,
      passStyle: r.event.passStyle,
      contactEmail: r.event.contactEmail,
    },
    user: { name: r.user.name, email: r.user.email },
    committee: { name: r.committee.name },
  };
}

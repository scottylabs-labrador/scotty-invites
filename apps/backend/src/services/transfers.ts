import { createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { safeEqual } from "../lib/crypto";

function mac(id: string, rotation: number): string {
  return createHmac("sha256", env.transferLinkSecret).update(`${id}:${rotation}`).digest("base64url").slice(0, 22);
}

export function transferToken(id: string, rotation: number): string {
  return `${id}.${mac(id, rotation)}`;
}

export function transferUrl(id: string, rotation: number): string {
  return `${env.appUrl}/inv/${transferToken(id, rotation)}`;
}

export async function parseTransferToken(token: string) {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const rows = await db.select().from(schema.ticketTransfers).where(eq(schema.ticketTransfers.id, id));
  const transfer = rows[0];
  if (!transfer) return null;
  if (!safeEqual(sig, mac(id, transfer.rotation))) return null;
  return transfer;
}

/** Returns the existing (or newly created) active transfer link for a ticket the user owns. */
export async function ensureTransfer(ticketId: string, ownerUserId: string) {
  const tickets = await db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, ownerUserId), isNull(schema.tickets.revokedAt)));
  const ticket = tickets[0];
  if (!ticket) return { ok: false as const, message: "Ticket not found" };
  if (ticket.kind !== "primary") return { ok: false as const, message: "Only primary invites can send a +1" };

  const regs = ticket.registrationId
    ? await db.select().from(schema.registrations).where(eq(schema.registrations.id, ticket.registrationId))
    : [];
  if (!regs[0]?.plusOne) return { ok: false as const, message: "This invite doesn't include a +1" };

  const existing = await db.select().from(schema.ticketTransfers).where(eq(schema.ticketTransfers.ticketId, ticketId));
  if (existing[0]) {
    const t = existing[0];
    if (t.status === "claimed") return { ok: false as const, message: "Your +1 was already claimed" };
    if (t.status === "revoked") {
      const updated = await db
        .update(schema.ticketTransfers)
        .set({ status: "active", rotation: t.rotation + 1, revokedAt: null })
        .where(eq(schema.ticketTransfers.id, t.id))
        .returning();
      const row = updated[0];
      return { ok: true as const, url: transferUrl(row.id, row.rotation), transfer: row };
    }
    return { ok: true as const, url: transferUrl(t.id, t.rotation), transfer: t };
  }

  const inserted = await db.insert(schema.ticketTransfers).values({ ticketId }).returning();
  const row = inserted[0];
  return { ok: true as const, url: transferUrl(row.id, row.rotation), transfer: row };
}

export async function revokeTransfer(ticketId: string, ownerUserId: string) {
  const tickets = await db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, ownerUserId)));
  if (!tickets[0]) return { ok: false as const, message: "Ticket not found" };
  await db
    .update(schema.ticketTransfers)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(schema.ticketTransfers.ticketId, ticketId), eq(schema.ticketTransfers.status, "active")));
  return { ok: true as const };
}

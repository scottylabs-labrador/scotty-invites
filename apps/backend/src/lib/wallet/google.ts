import { createSign } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { env } from "../../env";
import { fmtLongDate, fmtTimeWithZone } from "../format";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * "Fat" Save-to-Google-Wallet JWT: embeds the EventTicketClass (one per event)
 * and EventTicketObject (one per ticket) so no Wallet API pre-provisioning is
 * needed. Activates when GOOGLE_WALLET_* env vars are configured.
 */
export async function googleWalletSaveUrl(
  ticketId: string,
  userId: string,
): Promise<{ ok: true; url: string } | { ok: false; status: 401 | 404 | 503; message: string }> {
  if (!env.googleWalletIssuerId || !env.googleWalletSaEmail || !env.googleWalletSaKey) {
    return {
      ok: false,
      status: 503,
      message: "Google Wallet passes aren't configured yet — set GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL and GOOGLE_WALLET_SA_KEY_PEM.",
    };
  }

  const rows = await db
    .select({ ticket: schema.tickets, event: schema.events, user: schema.users, committee: schema.committees })
    .from(schema.tickets)
    .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
    .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, userId), isNull(schema.tickets.revokedAt)));
  const row = rows[0];
  if (!row) return { ok: false, status: 404, message: "Ticket not found" };

  const classId = `${env.googleWalletIssuerId}.scotty_invite_${row.event.shortCode}`;
  const objectId = `${env.googleWalletIssuerId}.${row.ticket.serial.replace(/[^\w]/g, "_")}_${row.event.shortCode}`;

  const ticketClass = {
    id: classId,
    issuerName: "ScottyLabs",
    eventName: { defaultValue: { language: "en-US", value: row.event.title } },
    venue: {
      name: { defaultValue: { language: "en-US", value: row.event.location } },
      address: { defaultValue: { language: "en-US", value: "Carnegie Mellon University, Pittsburgh, PA" } },
    },
    dateTime: { start: row.event.startAt.toISOString(), end: row.event.endAt.toISOString() },
    reviewStatus: "UNDER_REVIEW",
    hexBackgroundColor: "#0a0a0a",
  };

  const ticketObject = {
    id: objectId,
    classId,
    state: "ACTIVE",
    ticketHolderName: row.user.name ?? row.user.email,
    ticketNumber: row.ticket.serial,
    barcode: { type: "QR_CODE", value: row.ticket.serial, alternateText: row.ticket.serial },
    hexBackgroundColor: "#0a0a0a",
    textModulesData: [
      { header: "Committee", body: row.committee.name, id: "committee" },
      { header: "Doors", body: `${fmtLongDate(row.event.startAt)} · ${fmtTimeWithZone(row.event.startAt)}`, id: "doors" },
      { header: "Questions?", body: row.event.contactEmail, id: "contact" },
    ],
  };

  const claims = {
    iss: env.googleWalletSaEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [env.appUrl],
    payload: { eventTicketClasses: [ticketClass], eventTicketObjects: [ticketObject] },
  };

  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(env.googleWalletSaKey.replace(/\\n/g, "\n")).toString("base64url");

  return { ok: true, url: `https://pay.google.com/gp/v/save/${signingInput}.${signature}` };
}

import { createSign } from "node:crypto";
import type { PassRow } from "./row";

export interface GoogleWalletConfig {
  issuerId: string;
  saEmail: string;
  saKeyPem: string;
  appUrl: string;
}

export interface EventTicketClass {
  id: string;
  [key: string]: unknown;
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Google class/object ids take the form `issuerID.identifier`, and its
 * reference states: "Your unique identifier should only include alphanumeric
 * characters, '.', '_', or '-'."
 * (https://developers.google.com/wallet/tickets/events/rest/v1/eventticketclass)
 * Serials (SIT-001-EUGENEO) and short codes (lowercase alnum) already qualify;
 * the underscore normalisation is kept from the original implementation
 * because changing id shapes buys nothing and no objects exist at Google yet.
 */
export function classIdFor(row: PassRow, issuerId: string): string {
  return `${issuerId}.scotty_invite_${row.event.shortCode}`;
}

export function objectIdFor(row: PassRow, issuerId: string): string {
  return `${issuerId}.${row.ticket.serial.replace(/[^\w]/g, "_")}_${row.event.shortCode}`;
}

/** One per event, created over the REST API — never embedded in the save JWT. */
export function buildEventTicketClass(row: PassRow, cfg: GoogleWalletConfig): EventTicketClass {
  // The single dark-mode predicate — identical in pass-bundle.ts and in
  // TicketsPage.tsx:15, so all three renderings of one event agree.
  const dark = row.event.passStyle !== "light";
  return {
    id: classIdFor(row, cfg.issuerId),
    issuerName: "ScottyLabs",
    eventName: { defaultValue: { language: "en-US", value: row.event.title } },
    venue: {
      name: { defaultValue: { language: "en-US", value: row.event.location } },
      address: { defaultValue: { language: "en-US", value: "Carnegie Mellon University, Pittsburgh, PA" } },
    },
    dateTime: { start: row.event.startAt.toISOString(), end: row.event.endAt.toISOString() },
    reviewStatus: "UNDER_REVIEW",
    hexBackgroundColor: dark ? "#0a0a0a" : "#ffffff",
  };
}

/**
 * ticketHolderName is the one user-controlled field left in the save JWT
 * (the class carries title/location, which are organizer-controlled and
 * bounded by other means). `users.name` is unbounded `text` at rest, but
 * writes to it are validated by RegisterBody.fullName as
 * `z.string().min(1).max(120)` (packages/contract/src/index.ts) with no
 * charset restriction — so 120 *characters* can be up to 120 multi-byte code
 * points. Each one costs several bytes once JSON-stringified and
 * base64url-encoded, which is enough on its own to erode most of the margin
 * under Google's documented 1800-character safe JWT length (see google.ts).
 *
 * 40 characters is comfortably longer than any real name that will actually
 * render on a wallet card, while capping the worst case (120 multi-byte
 * characters) to a fraction of the JWT it could otherwise consume. Truncating
 * on `Array.from` rather than string indexing walks Unicode code points, not
 * UTF-16 code units, so a surrogate pair (an astral character) is never cut
 * in half into two invalid halves.
 */
const TICKET_HOLDER_NAME_MAX_CHARS = 40;

function truncateDisplayName(name: string): string {
  const codePoints = Array.from(name);
  if (codePoints.length <= TICKET_HOLDER_NAME_MAX_CHARS) return name;
  return codePoints.slice(0, TICKET_HOLDER_NAME_MAX_CHARS).join("");
}

/** One per ticket. This is the only thing the save JWT carries. */
export function buildEventTicketObject(row: PassRow, cfg: GoogleWalletConfig): Record<string, unknown> {
  return {
    id: objectIdFor(row, cfg.issuerId),
    classId: classIdFor(row, cfg.issuerId),
    state: "ACTIVE",
    ticketHolderName: truncateDisplayName(row.user.name ?? row.user.email),
    ticketNumber: row.ticket.serial,
    barcode: { type: "QR_CODE", value: row.ticket.serial, alternateText: row.ticket.serial },
    textModulesData: [
      { header: "Committee", body: row.committee.name, id: "committee" },
      { header: "Questions?", body: row.event.contactEmail, id: "contact" },
    ],
  };
}

/**
 * RS256, the only algorithm Google accepts for either JWT this app signs.
 * Throws when keyPem cannot sign — callers turn that into a 503.
 */
export function signJwt(claims: Record<string, unknown>, keyPem: string): string {
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(keyPem.replace(/\\n/g, "\n")).toString("base64url")}`;
}

/** Null when GOOGLE_WALLET_SA_KEY_PEM cannot sign — the caller returns a 503. */
export function buildSaveUrl(row: PassRow, cfg: GoogleWalletConfig): string | null {
  const claims = {
    iss: cfg.saEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [cfg.appUrl],
    payload: { eventTicketObjects: [buildEventTicketObject(row, cfg)] },
  };
  try {
    return `https://pay.google.com/gp/v/save/${signJwt(claims, cfg.saKeyPem)}`;
  } catch (err) {
    console.error("[wallet] google save JWT signing failed", err);
    return null;
  }
}

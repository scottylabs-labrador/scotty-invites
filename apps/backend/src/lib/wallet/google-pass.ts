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

/** One per ticket. This is the only thing the save JWT carries. */
export function buildEventTicketObject(row: PassRow, cfg: GoogleWalletConfig): Record<string, unknown> {
  return {
    id: objectIdFor(row, cfg.issuerId),
    classId: classIdFor(row, cfg.issuerId),
    state: "ACTIVE",
    ticketHolderName: row.user.name ?? row.user.email,
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

export function buildSaveUrl(row: PassRow, cfg: GoogleWalletConfig): string {
  const claims = {
    iss: cfg.saEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [cfg.appUrl],
    payload: { eventTicketObjects: [buildEventTicketObject(row, cfg)] },
  };
  return `https://pay.google.com/gp/v/save/${signJwt(claims, cfg.saKeyPem)}`;
}

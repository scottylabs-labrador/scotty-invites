import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEventTicketClass, buildEventTicketObject, buildSaveUrl, type GoogleWalletConfig } from "./google-pass";
import type { PassRow } from "./row";

const SAVE_PREFIX = "https://pay.google.com/gp/v/save/";

const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// Worst case for JWT length under RegisterBody.fullName's
// `z.string().min(1).max(120)` (packages/contract/src/index.ts): Zod's
// max() counts the string's UTF-16 `.length`, not Unicode code points, so a
// name built from single-code-unit multi-byte characters (BMP, like this
// one) fits 120 *glyphs* in that budget. A name built from surrogate-pair
// (astral) characters would only fit 60 glyphs in the same length budget —
// fewer total UTF-8 bytes once JSON-stringified and base64url-encoded, so it
// is not the worst case. contactEmail (also carried in the JWT, via
// textModulesData) has no `.max()` in the contract at all; 60 characters
// here is a plausible-but-long real address, not a true upper bound.
const WORST_CASE_NAME = "測".repeat(120);
const WORST_CASE_CONTACT_EMAIL = "tartanhacks-2026-organizing-committee-contact@scottylabs.org";

const WORST_CASE: PassRow = {
  ticket: { id: "6f1c7f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", serial: "SIT-999-BARTHOLOMEWF", number: 999, kind: "primary" },
  event: {
    title: "TartanHacks 2026 — Carnegie Mellon's Largest Student-Run Hackathon",
    location: "Rangos Ballroom, Cohon University Center, 5032 Forbes Avenue",
    shortCode: "abcdmnp",
    startAt: new Date("2026-02-06T22:00:00.000Z"),
    endAt: new Date("2026-02-08T03:00:00.000Z"),
    passStyle: "dark",
    contactEmail: WORST_CASE_CONTACT_EMAIL,
  },
  user: { name: WORST_CASE_NAME, email: "bfeather@andrew.cmu.edu" },
  committee: { name: "TartanHacks Organizing Committee" },
};

const CFG: GoogleWalletConfig = {
  issuerId: "3388000000012345678",
  saEmail: "scotty-invite-wallet@scottylabs-invites-2026.iam.gserviceaccount.com",
  saKeyPem: KEY_PEM,
  appUrl: "https://invite.scottylabs.org",
};

function claimsOf(url: string): Record<string, any> {
  const [, payload] = url.slice(SAVE_PREFIX.length).split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/**
 * buildSaveUrl returns string | null (null = the PEM cannot sign). These three
 * tests use a real generated key, so null is a bug, not a case to handle.
 */
function saveUrl(row: PassRow, cfg: GoogleWalletConfig): string {
  const url = buildSaveUrl(row, cfg);
  if (!url) throw new Error("expected a save url");
  return url;
}

describe("google wallet save link", () => {
  it("stays under Google's documented 1800-character safe JWT length for a worst-case event", () => {
    // Measured 1490 with this fixture (120-char multi-byte name, truncated to
    // 40 by truncateDisplayName, plus a 60-char contact email) — 310
    // characters of real margin, versus 1799 (25 characters of margin) before
    // ticketHolderName was bounded and the fixture used a worst-case name.
    const jwt = saveUrl(WORST_CASE, CFG).slice(SAVE_PREFIX.length);
    expect(jwt.length).toBeLessThan(1800);
  });

  it("truncates ticketHolderName to 40 code points without splitting a surrogate pair", () => {
    // 50 astral (surrogate-pair) code points — a shape a naive UTF-16 slice(0, 40)
    // would cut mid-pair, producing a lone surrogate. Array.from-based
    // truncation walks code points, so this must come out as exactly 40 clean
    // characters.
    const astralName = "𠀀".repeat(50);
    const row: PassRow = { ...WORST_CASE, user: { ...WORST_CASE.user, name: astralName } };

    const object = buildEventTicketObject(row, CFG);

    expect(object.ticketHolderName).toBe("𠀀".repeat(40));
    expect(Array.from(object.ticketHolderName as string)).toHaveLength(40);
  });

  it("leaves a normal-length name untouched", () => {
    const row: PassRow = { ...WORST_CASE, user: { ...WORST_CASE.user, name: "Jane Tartan" } };
    const object = buildEventTicketObject(row, CFG);
    expect(object.ticketHolderName).toBe("Jane Tartan");
  });

  it("carries only the ticket object — the class is pre-created over REST", () => {
    const claims = claimsOf(saveUrl(WORST_CASE, CFG));
    expect(Object.keys(claims.payload)).toEqual(["eventTicketObjects"]);
    expect(claims.payload.eventTicketObjects).toHaveLength(1);
    expect(claims.payload.eventTicketObjects[0].classId).toBe(buildEventTicketClass(WORST_CASE, CFG).id);
  });

  it("signs a savetowallet JWT issued by the service account", () => {
    const claims = claimsOf(saveUrl(WORST_CASE, CFG));
    expect(claims.aud).toBe("google");
    expect(claims.typ).toBe("savetowallet");
    expect(claims.iss).toBe(CFG.saEmail);
    expect(claims.origins).toEqual(["https://invite.scottylabs.org"]);
  });

  it("gives the class everything Google requires of it", () => {
    const ticketClass = buildEventTicketClass(WORST_CASE, CFG);
    expect(ticketClass.id).toBe("3388000000012345678.scotty_invite_abcdmnp");
    expect(ticketClass.issuerName).toBe("ScottyLabs");
    expect(ticketClass.reviewStatus).toBe("UNDER_REVIEW");
    expect(ticketClass.eventName).toBeDefined();
  });

  it("returns null instead of throwing when the service-account key is unusable", () => {
    expect(buildSaveUrl(WORST_CASE, { ...CFG, saKeyPem: "garbage" })).toBeNull();
  });
});

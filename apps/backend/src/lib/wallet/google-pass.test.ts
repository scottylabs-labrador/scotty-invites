import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEventTicketClass, buildSaveUrl, type GoogleWalletConfig } from "./google-pass";
import type { PassRow } from "./row";

const SAVE_PREFIX = "https://pay.google.com/gp/v/save/";

const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const WORST_CASE: PassRow = {
  ticket: { id: "6f1c7f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", serial: "SIT-999-BARTHOLOMEWF", number: 999, kind: "primary" },
  event: {
    title: "TartanHacks 2026 — Carnegie Mellon's Largest Student-Run Hackathon",
    location: "Rangos Ballroom, Cohon University Center, 5032 Forbes Avenue",
    shortCode: "abcdmnp",
    startAt: new Date("2026-02-06T22:00:00.000Z"),
    endAt: new Date("2026-02-08T03:00:00.000Z"),
    passStyle: "dark",
    contactEmail: "tartanhacks-organizers@scottylabs.org",
  },
  user: { name: "Bartholomew Featherstonehaugh-Cumberbatch", email: "bfeather@andrew.cmu.edu" },
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

describe("google wallet save link", () => {
  it("stays under Google's documented 1800-character safe JWT length for a worst-case event", () => {
    const jwt = buildSaveUrl(WORST_CASE, CFG).slice(SAVE_PREFIX.length);
    expect(jwt.length).toBeLessThan(1800);
  });

  it("carries only the ticket object — the class is pre-created over REST", () => {
    const claims = claimsOf(buildSaveUrl(WORST_CASE, CFG));
    expect(Object.keys(claims.payload)).toEqual(["eventTicketObjects"]);
    expect(claims.payload.eventTicketObjects).toHaveLength(1);
    expect(claims.payload.eventTicketObjects[0].classId).toBe(buildEventTicketClass(WORST_CASE, CFG).id);
  });

  it("signs a savetowallet JWT issued by the service account", () => {
    const claims = claimsOf(buildSaveUrl(WORST_CASE, CFG));
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
});

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PassRow } from "./row";

// googleWalletSaveUrl orchestrates loadPassRow (DB) + accessToken/
// upsertEventTicketClass (Google network calls) — none of which this test
// suite is allowed to touch. "./row" and "./google-api" are mocked per test
// so only google.ts's own message-routing logic (google.ts:45-66) is under
// test; google-api.test.ts covers the vendor-facing behaviour these mocks
// stand in for.
//
// buildSaveUrl (real, unmocked google-pass.ts) still signs the final save
// JWT on the success path, so GOOGLE_WALLET_SA_KEY_PEM has to be a real key —
// signJwt doesn't know accessToken/upsertEventTicketClass are stubbed.
const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const ENV_VARS = {
  GOOGLE_WALLET_ISSUER_ID: "3388000000012345678",
  GOOGLE_WALLET_SA_EMAIL: "wallet-sa@example.iam.gserviceaccount.com",
  GOOGLE_WALLET_SA_KEY_PEM: KEY_PEM,
};

const ROW: PassRow = {
  ticket: { id: "ticket-1", serial: "SIT-001-JANE", number: 1, kind: "primary" },
  event: {
    title: "Test Event",
    location: "Somewhere",
    shortCode: "abc123",
    startAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2026-01-01T01:00:00.000Z"),
    passStyle: "dark",
    contactEmail: "organizers@example.com",
  },
  user: { name: "Jane Tartan", email: "jane@andrew.cmu.edu" },
  committee: { name: "Committee" },
};

type GoogleApiModule = typeof import("./google-api");

async function importGoogleWalletSaveUrl(
  accessTokenImplFor: (api: GoogleApiModule) => (...args: unknown[]) => unknown,
  upsertImpl: (...args: unknown[]) => unknown = async () => ({ ok: true }),
) {
  vi.resetModules();
  for (const [k, v] of Object.entries(ENV_VARS)) process.env[k] = v;

  const actualGoogleApi = await vi.importActual<GoogleApiModule>("./google-api");

  vi.doMock("./row", () => ({ loadPassRow: vi.fn(async () => ROW) }));
  vi.doMock("./google-api", () => ({
    ...actualGoogleApi,
    accessToken: vi.fn(accessTokenImplFor(actualGoogleApi)),
    upsertEventTicketClass: vi.fn(upsertImpl),
  }));

  const { googleWalletSaveUrl } = await import("./google");
  return googleWalletSaveUrl;
}

afterEach(() => {
  for (const k of Object.keys(ENV_VARS)) delete process.env[k];
  vi.resetModules();
});

describe("googleWalletSaveUrl message routing", () => {
  it("reports a timeout fetching the access token as unreachable", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(() => async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.message).toMatch(/didn't respond in time/i);
    }
  });

  it("reports a MalformedKeyError (signJwt failing on a bad PEM) as a misconfigured key", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl((api) => async () => {
      throw new api.MalformedKeyError("bad pem");
    });

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/isn't a usable RSA private key/i);
  });

  it("reports a token-endpoint 500 as a vendor error — not the malformed-key message", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(() => async () => {
      throw new Error("token endpoint 500: internal_error");
    });

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/isn't a usable RSA private key/i);
      expect(result.message).toMatch(/authentication service returned an error/i);
    }
  });

  it("reports a DNS/connection failure (TypeError) as a vendor error — not the malformed-key message", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(() => async () => {
      throw new TypeError("fetch failed");
    });

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/isn't a usable RSA private key/i);
      expect(result.message).toMatch(/authentication service returned an error/i);
    }
  });

  it("reports a 401 from the class upsert with its own self-heal message, not the generic issuer-id one", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(
      () => async () => "tok-1",
      async () => ({ ok: false, status: 401, detail: "unauthorized" }),
    );

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/rotated or revoked/i);
      expect(result.message).not.toMatch(/Check GOOGLE_WALLET_ISSUER_ID/);
    }
  });

  it("keeps the 403 message distinct from the 401 message", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(
      () => async () => "tok-1",
      async () => ({ ok: false, status: 403, detail: "forbidden" }),
    );

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/isn't an authorised user/i);
      expect(result.message).not.toMatch(/rotated or revoked/i);
    }
  });

  it("reports a class-upsert transport failure (status 0) as unreachable", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(
      () => async () => "tok-1",
      async () => ({ ok: false, status: 0, detail: "TimeoutError: The operation was aborted" }),
    );

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/didn't respond in time/i);
  });

  it("returns a save url when the token fetch and class upsert both succeed", async () => {
    const googleWalletSaveUrl = await importGoogleWalletSaveUrl(
      () => async () => "tok-1",
      async () => ({ ok: true }),
    );

    const result = await googleWalletSaveUrl("ticket-1", "user-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  });
});

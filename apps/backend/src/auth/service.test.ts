import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests hit the real service against the local dev Postgres on 5433
// (the test script runs db:migrate first; starting Postgres itself is
// environment-specific — see the README's Docker recipe).
// Only the outbound Mailgun HTTP call is stubbed — everything else is real.
const TEST_ENV = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5433/scottylabs_invites",
  TRANSFER_LINK_SECRET: "test-secret-not-used-here-0123456789abcdef",
  SEED_SUPER_ADMIN_EMAILS: "",
};

async function importStartAuth(mailEnv: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...TEST_ENV, ...mailEnv })) process.env[k] = v;
  const { startAuth } = await import("./service");
  return startAuth;
}

const uniqueEmail = () => `tdd-${Date.now()}-${Math.floor(Math.random() * 1e6)}@andrew.cmu.edu`;

describe("startAuth mail delivery", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when the mail provider accepts (console mode)", async () => {
    const startAuth = await importStartAuth({ MAIL_MODE: "console" });
    const result = await startAuth({ email: uniqueEmail(), keepSignedIn: false, ip: "203.0.113.10" });
    expect(result).toEqual({ ok: true });
  });

  it("surfaces mail_failed when the mail provider rejects the send", async () => {
    const startAuth = await importStartAuth({ MAIL_MODE: "mailgun", MAILGUN_API_KEY: "dummy-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "Domain mail.scottylabs.org is not allowed to send: daily request limit (100) exceeded" }), {
          status: 429,
        }),
      ),
    );

    const result = await startAuth({ email: uniqueEmail(), keepSignedIn: false, ip: "203.0.113.11" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("mail_failed");
      expect(result.message).toMatch(/email/i);
    }
  });

  it("does not shadow a previously delivered code when a resend fails", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries({ ...TEST_ENV, MAIL_MODE: "mailgun", MAILGUN_API_KEY: "dummy-key" })) process.env[k] = v;
    const service = await import("./service");
    const email = uniqueEmail();

    // First send succeeds — capture the outbound Mailgun body to learn the code
    // the "user" received. Second send (the resend) is rejected with a 429.
    const bodies: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ?? "");
        call += 1;
        return call === 1
          ? new Response(JSON.stringify({ id: "queued" }), { status: 200 })
          : new Response(JSON.stringify({ message: "daily request limit (100) exceeded" }), { status: 429 });
      }),
    );

    const first = await service.startAuth({ email, keepSignedIn: false, ip: "203.0.113.12" });
    expect(first).toEqual({ ok: true });
    const deliveredCode = (new URLSearchParams(bodies[0]).get("text") ?? "").match(/Your code: (\d{6})/)?.[1];
    expect(deliveredCode).toBeTruthy();

    const resend = await service.startAuth({ email, keepSignedIn: false, ip: "203.0.113.12" });
    expect(resend.ok).toBe(false);

    // The code from the email that actually arrived must still work.
    const verified = await service.verifyByCode(email, deliveredCode!);
    expect("error" in verified).toBe(false);
  });
});

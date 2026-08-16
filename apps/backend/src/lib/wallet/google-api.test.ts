import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MalformedKeyError, __resetWalletApiCachesForTests, accessToken, upsertEventTicketClass } from "./google-api";
import type { EventTicketClass } from "./google-pass";

const VALID_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/** A minimal fetch-`Response`-shaped object — the code only ever touches .ok, .status, .json(), .text(). */
function fakeResponse(status: number, body: unknown, opts?: { textFails?: unknown; jsonFails?: unknown }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (opts?.jsonFails ? Promise.reject(opts.jsonFails) : Promise.resolve(body)),
    text: () => (opts?.textFails ? Promise.reject(opts.textFails) : Promise.resolve(JSON.stringify(body))),
  } as unknown as Response;
}

function timeoutError(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

/** Resolves/rejects on demand — lets a test hold a fetch call open to prove dedup. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TICKET_CLASS: EventTicketClass = { id: "issuer123.scotty_invite_abc", issuerName: "ScottyLabs" };

beforeEach(() => {
  __resetWalletApiCachesForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accessToken", () => {
  it("throws MalformedKeyError synchronously for an unusable PEM, without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(accessToken("sa@example.iam.gserviceaccount.com", "not a real PEM")).rejects.toBeInstanceOf(
      MalformedKeyError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects with a plain Error (not MalformedKeyError, not a timeout) on a token-endpoint 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(500, { error: "internal_error" })),
    );

    let caught: unknown;
    try {
      await accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(MalformedKeyError);
    expect((caught as Error).name).not.toBe("TimeoutError");
    expect((caught as Error).name).not.toBe("AbortError");
  });

  it("propagates a timeout on the initial fetch as a TimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutError();
      }),
    );

    await expect(accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("propagates a timeout that fires while reading the response body, instead of swallowing it into a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, {}, { jsonFails: timeoutError() })),
    );

    await expect(accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("succeeds and caches the token, short-circuiting a second call", async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(200, { access_token: "tok-1", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);
    const second = await accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);

    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent callers into a single outbound token request", async () => {
    const gate = deferred<Response>();
    const fetchSpy = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetchSpy);

    const call1 = accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);
    const call2 = accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    gate.resolve(fakeResponse(200, { access_token: "tok-shared", expires_in: 3600 }));

    await expect(call1).resolves.toBe("tok-shared");
    await expect(call2).resolves.toBe("tok-shared");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected in-flight request — the next call retries", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => fakeResponse(500, { error: "internal_error" }))
      .mockImplementationOnce(async () => fakeResponse(200, { access_token: "tok-recovered", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM)).rejects.toThrow();
    await expect(accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM)).resolves.toBe("tok-recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("upsertEventTicketClass", () => {
  it("resolves to success via PUT after the insert 409s (already exists)", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe("POST");
        return fakeResponse(409, { error: "already exists" });
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe("PUT");
        return fakeResponse(200, { id: TICKET_CLASS.id });
      });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await upsertEventTicketClass(TICKET_CLASS, "tok");

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves the class cache short-circuit on an unchanged repeat call, with zero further fetches", async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(200, { id: TICKET_CLASS.id }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await upsertEventTicketClass(TICKET_CLASS, "tok");
    const second = await upsertEventTicketClass(TICKET_CLASS, "tok");

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns status 0 with no HTTP status when the request never completes (timeout/transport failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutError();
      }),
    );

    const result = await upsertEventTicketClass(TICKET_CLASS, "tok");

    expect(result).toEqual({ ok: false, status: 0, detail: expect.any(String) });
  });

  it("preserves a real HTTP status (403) even when the body read itself is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(403, { error: "forbidden" }, { textFails: timeoutError() })),
    );

    const result = await upsertEventTicketClass(TICKET_CLASS, "tok");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.status).not.toBe(0);
    }
  });

  it("clears the cached access token on a 401 from the class upsert, so the next accessToken call fetches fresh", async () => {
    const tokenFetch = vi.fn(async () => fakeResponse(200, { access_token: "tok-original", expires_in: 3600 }));
    vi.stubGlobal("fetch", tokenFetch);
    const cachedToken = await accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);
    expect(cachedToken).toBe("tok-original");
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(401, { error: "invalid credentials" })),
    );
    const upsertResult = await upsertEventTicketClass(TICKET_CLASS, cachedToken);
    expect(upsertResult).toEqual({ ok: false, status: 401, detail: expect.any(String) });

    const tokenFetchAfter401 = vi.fn(async () => fakeResponse(200, { access_token: "tok-refreshed", expires_in: 3600 }));
    vi.stubGlobal("fetch", tokenFetchAfter401);
    const refreshedToken = await accessToken("sa@example.iam.gserviceaccount.com", VALID_KEY_PEM);

    expect(refreshedToken).toBe("tok-refreshed");
    expect(tokenFetchAfter401).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent upserts of the identical class body into a single outbound request", async () => {
    const gate = deferred<Response>();
    const fetchSpy = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetchSpy);

    const call1 = upsertEventTicketClass(TICKET_CLASS, "tok");
    const call2 = upsertEventTicketClass(TICKET_CLASS, "tok");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    gate.resolve(fakeResponse(200, { id: TICKET_CLASS.id }));

    await expect(call1).resolves.toEqual({ ok: true });
    await expect(call2).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected in-flight upsert — a later call retries instead of reusing the failure", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw timeoutError();
      })
      .mockImplementationOnce(async () => fakeResponse(200, { id: TICKET_CLASS.id }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await upsertEventTicketClass(TICKET_CLASS, "tok");
    expect(first).toEqual({ ok: false, status: 0, detail: expect.any(String) });

    const second = await upsertEventTicketClass(TICKET_CLASS, "tok");
    expect(second).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

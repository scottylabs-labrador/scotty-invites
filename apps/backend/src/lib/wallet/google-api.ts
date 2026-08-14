import { createHash } from "node:crypto";
import { signJwt } from "./google-pass";
import type { EventTicketClass } from "./google-pass";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const CLASS_URL = "https://walletobjects.googleapis.com/walletobjects/v1/eventTicketClass";

/**
 * Node's global fetch has NO default timeout, and this module is reached from a
 * route with no rate limiter (@fastify/rate-limit is a dependency but is
 * registered nowhere in apps/backend/src). Every outbound call is therefore
 * bounded explicitly — without this, one hung Google connection would pin a
 * Fastify request indefinitely.
 *
 * This is a PER-REQUEST budget, not a total-request budget: accessToken's
 * token-endpoint POST, and upsertEventTicketClass's insert POST and (on a
 * 409) its follow-up PUT, are three independent fetches, each bounded
 * separately by this value. googleWalletSaveUrl's worst case is therefore up
 * to 3x this long, not this long.
 */
const PER_REQUEST_TIMEOUT_MS = 5000;

/**
 * Thrown only when signJwt fails synchronously inside accessToken — an
 * unusable PEM (wrong format, wrong key type, etc). This is the one failure
 * mode that is genuinely "the operator's configured key is bad". Everything
 * that can go wrong *after* signing succeeds — a stalled connection, a
 * timeout, Google's token endpoint returning a non-2xx — is a different
 * failure mode (network/vendor, not key format) and must not be reported to
 * the operator as a key problem. See google.ts's BAD_KEY vs vendor-error
 * message routing, which distinguishes on this type.
 */
export class MalformedKeyError extends Error {
  readonly name = "MalformedKeyError";
  constructor(cause: unknown) {
    super(`service-account private key cannot sign: ${String(cause)}`);
  }
}

/** Process-wide access token cache. Google's tokens last an hour. */
let cached: { token: string; expiresAt: number } | null = null;

/**
 * In-flight token request, keyed by service-account email. Without this, K
 * concurrent callers with no cached (or an expired) token each fire their own
 * token request. Sharing one in-flight promise per key means only the first
 * caller actually calls Google; the rest await the same promise. Cleared in
 * `finally` (success or failure) so a rejected request is never cached as a
 * permanent failure — the next caller after a rejection gets a fresh attempt,
 * not a repeat of the same error.
 */
const tokenInFlight = new Map<string, Promise<string>>();

/**
 * classId -> sha1 of the exact class body Google last accepted in this process.
 * A repeat click on the same event with an unchanged body costs zero Google
 * calls. Hashing the body (rather than just remembering the id) keeps organizer
 * edits working: a new title changes the body, changes the hash, and the upsert
 * goes through on the next click. Bounded by the number of distinct events this
 * process has served — one 40-character string each.
 */
const upsertedClasses = new Map<string, string>();

/**
 * In-flight class-upsert request, keyed by `${classId}:${bodyHash}`. Same
 * stampede problem as tokenInFlight: without this, K concurrent first clicks
 * on an event with no cached class each issue their own insert, K-1 of which
 * lose the race, get a 409, and each fire an additional PUT. Keying on the
 * body hash (not just the id) means an organizer edit that lands mid-flight
 * starts its own request instead of deduping onto a stale one. Cleared in
 * `finally` so a rejection is never cached as a permanent failure.
 */
const upsertInFlight = new Map<string, Promise<UpsertResult>>();

/** Test-only: drop every module-level cache so tests don't leak state across each other. */
export function __resetWalletApiCachesForTests(): void {
  cached = null;
  tokenInFlight.clear();
  upsertedClasses.clear();
  upsertInFlight.clear();
}

/**
 * Service-account access token via the JWT-bearer grant. Throws on failure —
 * the caller turns that into a 503. A MalformedKeyError comes from signJwt,
 * synchronously, before any I/O. Anything else — a TimeoutError from
 * AbortSignal.timeout, a TypeError from a stalled/DNS-failed connection, or a
 * plain Error carrying Google's non-2xx token-endpoint response — means
 * signing worked and something on the network or at Google did not.
 */
export async function accessToken(saEmail: string, keyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.token;

  const existing = tokenInFlight.get(saEmail);
  if (existing) return existing;

  const promise = fetchAccessToken(saEmail, keyPem, now).finally(() => {
    tokenInFlight.delete(saEmail);
  });
  tokenInFlight.set(saEmail, promise);
  return promise;
}

async function fetchAccessToken(saEmail: string, keyPem: string, now: number): Promise<string> {
  let assertion: string;
  try {
    assertion = signJwt({ iss: saEmail, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now }, keyPem);
  } catch (err) {
    throw new MalformedKeyError(err);
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });

  let body: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    body = await res.json();
  } catch (err) {
    // AbortSignal.timeout covers the whole request, including streaming the
    // response, so a timeout can fire while reading the body rather than
    // while waiting for headers — that rejects with the same
    // TimeoutError/AbortError a stalled fetch() would. Let it propagate as-is
    // so the caller's "was this a timeout" check still recognizes it, instead
    // of swallowing it into a generic "no access_token" error that would
    // misreport as a vendor/key problem below. Anything else here is a
    // genuine parse failure (Google returned a non-JSON body) — treat that as
    // "no usable token".
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw err;
    body = {};
  }

  if (!res.ok || !body.access_token) {
    throw new Error(`token endpoint ${res.status}: ${body.error_description ?? body.error ?? "no access_token"}`);
  }

  cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

type UpsertResult = { ok: true } | { ok: false; status: number; detail: string };

/**
 * Create the event's class, or update it if it already exists. Insert returns
 * 409 AlreadyExists for a known id, so the 409 branch PUTs instead — that also
 * keeps the class in step when an organizer edits the event title or venue.
 *
 * Never throws: a timeout or a transport failure comes back as status 0, which
 * is not a real HTTP status, so googleWalletSaveUrl can tell "Google said no"
 * from "Google never answered".
 */
export async function upsertEventTicketClass(ticketClass: EventTicketClass, token: string): Promise<UpsertResult> {
  const body = JSON.stringify(ticketClass);
  const bodyHash = createHash("sha1").update(body).digest("hex");
  if (upsertedClasses.get(ticketClass.id) === bodyHash) return { ok: true };

  const inFlightKey = `${ticketClass.id}:${bodyHash}`;
  const existing = upsertInFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = doUpsert(ticketClass.id, body, bodyHash, token).finally(() => {
    upsertInFlight.delete(inFlightKey);
  });
  upsertInFlight.set(inFlightKey, promise);
  return promise;
}

async function doUpsert(classId: string, body: string, bodyHash: string, token: string): Promise<UpsertResult> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    const insert = await fetch(CLASS_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
    if (insert.ok) {
      upsertedClasses.set(classId, bodyHash);
      return { ok: true };
    }
    if (insert.status !== 409) return await failure(insert);

    const update = await fetch(`${CLASS_URL}/${encodeURIComponent(classId)}`, {
      method: "PUT",
      headers,
      body,
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
    if (update.ok) {
      upsertedClasses.set(classId, bodyHash);
      return { ok: true };
    }
    return await failure(update);
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError; DNS/TLS failures reject
    // with a TypeError. Neither carries an HTTP status.
    console.error("[wallet] google eventTicketClass request never completed", err);
    return { ok: false, status: 0, detail: String(err) };
  }
}

/**
 * Turn a non-ok class response into the failure shape. The status is read
 * (synchronously — it's a property, not a promise) before the body is
 * touched: AbortSignal.timeout covers the whole request including streaming
 * the response, so `res.text()` can itself be what times out. If it throws,
 * the caller must still get the real, already-known, actionable status (e.g.
 * 403 — "invite the service account") rather than losing it behind a generic
 * "unreachable" 0 from an outer catch.
 *
 * A 401 means Google no longer accepts the token this request used — the
 * cached access token is stale (key rotated, service account revoked, ...).
 * Drop the cache so the next call fetches a fresh token instead of retrying
 * the same rejected one for up to an hour.
 */
async function failure(res: Response): Promise<{ ok: false; status: number; detail: string }> {
  const status = res.status;
  if (status === 401) cached = null;
  const detail = await res.text().catch((err) => `<body unread: ${String(err)}>`);
  return { ok: false, status, detail };
}

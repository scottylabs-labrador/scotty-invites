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
 */
const TIMEOUT_MS = 5000;

/** Process-wide access token cache. Google's tokens last an hour. */
let cached: { token: string; expiresAt: number } | null = null;

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
 * Service-account access token via the JWT-bearer grant. Throws on failure —
 * the caller turns that into a 503. An unusable PEM throws from signJwt; a
 * stalled network throws a TimeoutError after TIMEOUT_MS.
 */
export async function accessToken(saEmail: string, keyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.token;

  const assertion = signJwt({ iss: saEmail, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now }, keyPem);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`token endpoint ${res.status}: ${body.error_description ?? body.error ?? "no access_token"}`);
  }

  cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

/**
 * Create the event's class, or update it if it already exists. Insert returns
 * 409 AlreadyExists for a known id, so the 409 branch PUTs instead — that also
 * keeps the class in step when an organizer edits the event title or venue.
 *
 * Never throws: a timeout or a transport failure comes back as status 0, which
 * is not a real HTTP status, so googleWalletSaveUrl can tell "Google said no"
 * from "Google never answered".
 */
export async function upsertEventTicketClass(
  ticketClass: EventTicketClass,
  token: string,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const body = JSON.stringify(ticketClass);
  const bodyHash = createHash("sha1").update(body).digest("hex");
  if (upsertedClasses.get(ticketClass.id) === bodyHash) return { ok: true };

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    const insert = await fetch(CLASS_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (insert.ok) {
      upsertedClasses.set(ticketClass.id, bodyHash);
      return { ok: true };
    }
    if (insert.status !== 409) return { ok: false, status: insert.status, detail: await insert.text() };

    const update = await fetch(`${CLASS_URL}/${encodeURIComponent(ticketClass.id)}`, {
      method: "PUT",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (update.ok) {
      upsertedClasses.set(ticketClass.id, bodyHash);
      return { ok: true };
    }
    return { ok: false, status: update.status, detail: await update.text() };
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError; DNS/TLS failures reject
    // with a TypeError. Neither carries an HTTP status.
    console.error("[wallet] google eventTicketClass request never completed", err);
    return { ok: false, status: 0, detail: String(err) };
  }
}

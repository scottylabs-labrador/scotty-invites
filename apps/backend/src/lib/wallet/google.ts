import { env } from "../../env";
import { loadPassRow } from "./row";
import { buildEventTicketClass, buildSaveUrl, type GoogleWalletConfig } from "./google-pass";
import { accessToken, upsertEventTicketClass, MalformedKeyError } from "./google-api";

const UNREACHABLE =
  "Google Wallet didn't respond in time. This is usually transient — try again in a moment. If it keeps happening, see docs/google-wallet-setup.md.";

const BAD_KEY =
  "Google Wallet is misconfigured — GOOGLE_WALLET_SA_KEY_PEM isn't a usable RSA private key. Paste the `private_key` value from the service-account JSON, keeping its \\n escapes, not the whole JSON file. See docs/google-wallet-setup.md.";

// Signing succeeded (so the key itself is fine) but the token endpoint never
// gave back a usable token — a stalled/DNS-failed connection (TypeError) or a
// non-2xx response from Google (5xx during an outage, 400/401 for a revoked
// or deleted service account, ...). Distinct from BAD_KEY: re-pasting the key
// fixes nothing here.
const TOKEN_VENDOR_ERROR =
  "Google Wallet's authentication service returned an error rather than a token. This is usually transient on Google's side — try again in a moment. If it persists, confirm GOOGLE_WALLET_SA_EMAIL names a service account that still exists and whose key hasn't been revoked. See docs/google-wallet-setup.md.";

// The token that was used was valid when accessToken() cached it, but Google
// rejected it anyway (key rotated or the SA revoked mid-token-life). Distinct
// from the generic "check GOOGLE_WALLET_ISSUER_ID" message below — the cache
// is cleared as part of producing this result, so the next attempt gets a
// fresh token and should self-heal without operator action.
const CLASS_UNAUTHORIZED =
  "Google rejected the Wallet credentials for this request (401), most likely because the service-account key was rotated or revoked after the cached token was issued. The next attempt will fetch a fresh token; if it keeps failing, verify GOOGLE_WALLET_SA_EMAIL and GOOGLE_WALLET_SA_KEY_PEM. See docs/google-wallet-setup.md.";

/**
 * Save-to-Google-Wallet link. The EventTicketClass is created (or refreshed)
 * once per event through the Wallet REST API and the save JWT carries only the
 * EventTicketObject — Google documents 1800 characters as the safe encoded-JWT
 * length, and the old class-inline "fat" JWT measured 1976-2171. Activates when
 * the GOOGLE_WALLET_* env vars are configured; see docs/google-wallet-setup.md.
 */
export async function googleWalletSaveUrl(
  ticketId: string,
  userId: string,
): Promise<{ ok: true; url: string } | { ok: false; status: 401 | 404 | 503; message: string }> {
  if (!env.googleWalletIssuerId || !env.googleWalletSaEmail || !env.googleWalletSaKey) {
    return {
      ok: false,
      status: 503,
      message:
        "Google Wallet passes aren't configured yet — set GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL and GOOGLE_WALLET_SA_KEY_PEM.",
    };
  }

  const row = await loadPassRow(ticketId, userId);
  if (!row) return { ok: false, status: 404, message: "Ticket not found" };

  const cfg: GoogleWalletConfig = {
    issuerId: env.googleWalletIssuerId,
    saEmail: env.googleWalletSaEmail,
    saKeyPem: env.googleWalletSaKey,
    appUrl: env.appUrl,
  };

  let token: string;
  try {
    token = await accessToken(cfg.saEmail, cfg.saKeyPem);
  } catch (err) {
    console.error("[wallet] google access token request failed", err);
    // AbortSignal.timeout produces a DOMException named TimeoutError; read the
    // name defensively rather than with instanceof, which varies by runtime.
    // MalformedKeyError is ours, so instanceof for it is reliable — it is the
    // *only* signal that the key itself (rather than the network or Google)
    // is the problem; see google-api.ts.
    const name = (err as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const message = timedOut ? UNREACHABLE : err instanceof MalformedKeyError ? BAD_KEY : TOKEN_VENDOR_ERROR;
    return { ok: false, status: 503, message };
  }

  const upserted = await upsertEventTicketClass(buildEventTicketClass(row, cfg), token);
  if (!upserted.ok) {
    console.error("[wallet] google eventTicketClass upsert failed", upserted.status, upserted.detail);
    let message: string;
    if (upserted.status === 0) {
      message = UNREACHABLE;
    } else if (upserted.status === 401) {
      message = CLASS_UNAUTHORIZED;
    } else if (upserted.status === 403) {
      message =
        "Google refused this pass — the service account isn't an authorised user on the Wallet issuer account. Invite GOOGLE_WALLET_SA_EMAIL as a Developer under Users in the Google Pay & Wallet Console. See docs/google-wallet-setup.md.";
    } else {
      message = `Google Wallet rejected this event's pass template (HTTP ${upserted.status}). Check GOOGLE_WALLET_ISSUER_ID and see docs/google-wallet-setup.md.`;
    }
    return { ok: false, status: 503, message };
  }

  return { ok: true, url: buildSaveUrl(row, cfg) };
}

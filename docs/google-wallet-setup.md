# Google Wallet setup

Everything here is console work a human does once. When it is done, set three
environment variables and the "Save to Google Wallet" button starts working.

Sources checked while writing this: the issuer onboarding, REST auth credentials,
publishing-access and error-code pages under https://developers.google.com/wallet/tickets/events/.

## 1. Create the issuer account

1. Go to the Google Pay & Wallet Console: <https://goo.gle/wallet-console>. Sign in with the
   Google account that should hold the Admin role — **use a ScottyLabs-owned account, not a
   graduating student's personal one.** Whoever holds this account controls every pass.
2. Complete the business-profile form. Public business name: `ScottyLabs`.
3. On the dashboard find the Google Wallet API card, click **Create a pass**, then **Build your
   first pass**, and accept the Google Wallet API Terms of Service.
4. The issuer account now exists, in **demo mode** (see step 4 below).
5. Copy the **Issuer ID** from the Wallet API dashboard — a 16-to-19-digit number.
   This is `GOOGLE_WALLET_ISSUER_ID`.

## 2. Create the Cloud service account

1. Open the Google Cloud console <https://console.cloud.google.com> and select or create a project.
2. Enable the API: <https://console.cloud.google.com/apis/library/walletobjects.googleapis.com>
   → **Enable**.
3. Create the service account:
   <https://console.cloud.google.com/iam-admin/serviceaccounts/create> → name it
   e.g. `scotty-invite-wallet` → note the generated email → **Done**.
   No Cloud IAM roles are needed; authorisation happens in the Wallet console, not here.
4. Open the new service account → **Keys** tab → **Add key** → **Create new key** → **JSON** →
   **Create**. A JSON file downloads. Keep it out of git.
   - `client_email` from that file is `GOOGLE_WALLET_SA_EMAIL`.
   - `private_key` from that file is `GOOGLE_WALLET_SA_KEY_PEM` — **the PEM block only**, with its
     `\n` escapes left exactly as they appear in the JSON. The loader un-escapes them
     (`apps/backend/src/lib/wallet/google-pass.ts`). Pasting the whole JSON file is the single most
     common mistake and produces `Google Wallet is misconfigured — GOOGLE_WALLET_SA_KEY_PEM isn't a
     usable RSA private key.`

**The key must be RSA.** Google service-account JSON keys are RSA by default, but if you ever
substitute an EC/P-256 key it will sign **without any local error** while the app's JWT header
still says `alg: RS256` — the signature comes out 95 characters instead of ~342 and Google rejects
the save with nothing in this app's logs. Sanity-check with:

Export the value in your shell first — step 6 sets it in `.env` and Railway, but this check runs
before that:

```bash
export GOOGLE_WALLET_SA_KEY_PEM='-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n'
openssl pkey -in <(printf '%b' "$GOOGLE_WALLET_SA_KEY_PEM") -noout -text | head -1
```

Expect `RSA Private-Key: (2048 bit, 2 primes)` or similar — not `EC`. An empty result means the
variable is unset, not that the key is bad.

## 3. Authorise the service account on the issuer — THE STEP THAT IS ALWAYS MISSED

Enabling the API in Cloud does **not** grant access to the issuer account. These are two separate
permission systems, and skipping this one is what produces the permission error.

1. Back in the Google Pay & Wallet Console, click **Users** in the left nav.
2. Click **Invite a user**.
3. Paste the **service account's** email address (the `client_email`, ending
   `.iam.gserviceaccount.com`) — not a person's address.
4. In the **Access level** drop-down select **Developer**.
5. Click **Invite**.

Without this, Google returns `403 Permission Denied` on the class insert. The app now surfaces that
as: *"Google refused this pass — the service account isn't an authorised user on the Wallet issuer
account…"*. Before this change the same failure happened silently on Google's side after the
redirect, with nothing in the app's logs at all.

## 4. Demo mode and test accounts

Every new issuer account starts in demo mode:

- Passes carry a **[TEST ONLY]** banner.
- Only Google accounts with the Admin or Developer role on the issuer, **or** accounts explicitly
  added as test accounts, can save a pass. Everyone else's save simply fails.

To add testers: Google Pay & Wallet Console → the Google Wallet API section → **Set up test
accounts** → paste each tester's Google account email on its own line → update.

CMU-issued Google accounts and personal gmail accounts are different identities. Testers must list
the account they are actually signed into in the Google Wallet app on their phone.

## 5. Leaving demo mode

Documented requirements before you can request publishing access: a completed business profile
(including a payments profile) and at least one created pass class. The first successful "Save to
Google Wallet" click creates the class automatically, so do that first.

Then: Google Pay & Wallet Console → **Google Wallet API** → **Request publishing access**. Google
reviews the issuer account and notifies you when it is approved; the [TEST ONLY] banner disappears
and any Google user can save a pass.

**Unverified, treat as a guess:** the pass class carries no logo or hero image today. Both are
optional for the API. It is *plausible* that a logo-less class draws a rejection during review, and
that any image you add has to be an HTTPS-hosted URL — but the publishing-access page says nothing
about design review or image hosting, and we could not confirm either. If a review is rejected
without a stated reason, adding a logo is the cheap first thing to try; it costs no JWT bytes.

## 6. Set the environment variables

```
GOOGLE_WALLET_ISSUER_ID="3388000000012345678"
GOOGLE_WALLET_SA_EMAIL="scotty-invite-wallet@your-project.iam.gserviceaccount.com"
GOOGLE_WALLET_SA_KEY_PEM="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

`.env` values are parsed line-by-line, so the PEM **must** be one line with literal `\n` escapes,
never real newlines. Set the same three in Railway for the deployed service.

## 7. Verify

1. Sign in, open `/tickets`, click **Save to Google Wallet** on an approved ticket.
2. Success: a `pay.google.com` tab opens and offers to add the pass.
3. Failure: the yellow note under the buttons carries the reason. Match it here:
   - *"…aren't configured yet"* → one of the three env vars is empty.
   - *"…isn't a usable RSA private key"* → you pasted the whole JSON, or lost the `\n` escapes.
   - *"…isn't an authorised user on the Wallet issuer account"* → step 3 was skipped.
   - *"…rejected this event's pass template (HTTP 404)"* → `GOOGLE_WALLET_ISSUER_ID` is wrong.
   - *"…didn't respond in time"* → the call to Google exceeded its 5-second budget, or DNS/TLS
     failed. Transient; the backend log carries the underlying error.
4. Backend logs carry the full vendor response under `[wallet] google eventTicketClass upsert
   failed` — the HTTP status and Google's own error body.
5. To reproduce a rejection by hand, decode the JWT from the save URL at jwt.io and POST the class
   body to `https://walletobjects.googleapis.com/walletobjects/v1/eventTicketClass` with the service
   account's credentials.
6. **Repeat clicks on the same event may make no Google call at all.** The backend caches
   `classId -> sha1(class body)` for the life of the process, so a second click with an unchanged
   event skips both the insert and the update. To force a call while debugging, edit the event
   (title or venue) or restart the backend.

## 8. What this app does and does not do

- It creates (or updates) one `EventTicketClass` per event over the REST API. The first save click
  for an event does the call; later clicks skip it while the class body is unchanged, and an
  organizer's edit to the title or venue pushes through on the next click.
- Every individual outbound call to Google is capped at 5 seconds (`AbortSignal.timeout`) — that is
  a per-call budget, not a per-save one. A single "Save to Google Wallet" click can make up to
  three sequential calls (the access-token fetch, the class insert, and — only on a 409 — a
  follow-up update PUT; see `apps/backend/src/lib/wallet/google-api.ts:16-21`), so the worst case
  for one click is up to ~15 seconds, not 5. A slow Google produces the "didn't respond in time"
  note rather than a hung request.
- It does **not** pre-create the `EventTicketObject`; the object rides in the save JWT. Measured
  directly by calling this branch's own `buildEventTicketObject` + `signJwt`
  (`apps/backend/src/lib/wallet/google-pass.ts`), against Google's documented 1800-character safe
  length (<https://developers.google.com/wallet/tickets/events/web>):
  - a typical ticket (short name, short contact email): ~1230 characters
  - this branch's own worst-case test fixture (`google-pass.test.ts`'s `WORST_CASE` — a name
    truncated to 40 code points by `truncateDisplayName`, plus a long event title/location): 1486
  - that same fixture with its contact email swapped for an RFC 5321-maximum 254-character
    address — `contactEmail` has no length cap in the contract, unlike the ticket holder name —
    measures 1744, only ~56 characters under the 1800 limit.
- It does **not** update or expire passes after they are saved.

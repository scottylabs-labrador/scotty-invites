# Wallet Passes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Apple `.pkpass` bundle installable, move the Google Wallet save link inside Google's documented size limit, turn every wallet misconfiguration into an actionable 503 instead of a generic 500, and stop the product claiming that wallet passes already work.

**Architecture:** All wallet code lives under `apps/backend/src/lib/wallet/`. Today `apple.ts` and `google.ts` each do the same four things in one function — a four-table database join, an env check, pass construction, and cryptographic signing — which makes them untestable. This plan splits that into one shared database loader (`row.ts`), two DB-free and env-free construction modules (`pass-bundle.ts`, `google-pass.ts`), one network module for Google's REST API (`google-api.ts`), and leaves `apple.ts` / `google.ts` as thin orchestrators that own the env gate and the HTTP status mapping. The Google pass changes shape: instead of embedding the whole `EventTicketClass` in the save JWT, the class is created once per event over the Wallet REST API and the JWT carries only the ticket object.

**Tech Stack:** TypeScript 5.8, Node 22, Fastify 4 + ts-rest, Drizzle ORM on Postgres, `node-forge` for PKCS#7, `node:crypto` for RS256, vitest 4 (backend only), React 18 + Vite (web), pnpm workspaces.

## Global Constraints

- `pnpm -r typecheck` must pass at the end of **every** task. Run it before every commit.
- `packages/contract` is consumed from source (`"main": "./src/index.ts"`) and `s.router(contract, {...})` is exhaustive — a contract change with no matching handler breaks the backend and the web app at once. Contract changes therefore land in the **same commit** as their handler and their web call sites. That is Task 5 only; no other task touches the contract.
- `apps/backend` is the only package with a test runner (vitest 4.1.10). There is **no vitest config file**, so the default `**/*.test.ts` glob auto-discovers new test files. `apps/web` has no test runner — do not write frontend unit tests; verify frontend work with `pnpm -r typecheck` plus the manual QA steps written into the task.
- `apps/backend/tsconfig.json` has `"include": ["src"]` and `"strict": true`, so **`pnpm -r typecheck` typechecks `.test.ts` files too**. vitest itself does not: it transpiles through esbuild and reports zero type errors. A change that widens a function's return type must therefore fix its existing tests *in the same task*, or the task's own typecheck gate fails.
- The scripted test command `pnpm --filter @scottylabs-invites/backend test` runs `db:migrate` first and needs a live Postgres. **Every test in this plan is DB-free by construction.** Run them with:
  `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run <file>`
  The `DATABASE_URL` value is never connected to; it exists only because `apps/backend/src/env.ts:37` throws at import when it is unset, and this worktree has no `.env`.
- Match the style of the one existing test file, `apps/backend/src/auth/service.test.ts`: `import { describe, expect, it } from "vitest"`, one `describe` per unit, sentence-style `it` names.
- Server-side logging convention is `console.error("[wallet] <what failed>", err)`, matching `apps/backend/src/lib/mail.ts:45,53`. **Never** put OpenSSL or vendor error text in an HTTP response body — the response names the env var and the fix.
- **One dark-mode predicate everywhere: `row.event.passStyle !== "light"`.** `pass_style` is declared `text("pass_style", { enum: ["dark", "light"] })` at `apps/backend/src/db/schema.ts:114` — a TypeScript-level union, *not* a Postgres CHECK constraint — and `PassRow` widens it to `string`, so a third value is representable in both the type system and the database. `apps/web/src/pages/TicketsPage.tsx:15` already renders the on-screen pass with `!== "light"`; today's `apple.ts:37` uses `=== "dark"` and is the odd one out. Task 1 (`pass-bundle.ts`) and Task 3 (`google-pass.ts`) both use `!== "light"` so an Apple pass, a Google pass and the web preview can never disagree about the same event.
- **`@fastify/rate-limit` is a dependency but is registered nowhere.** `grep -rn "rate-limit\|rateLimit\|@fastify/rate-limit" apps/backend/src` returns only two prose comments (`server.ts:366`, `server.ts:403`). Every wallet route is therefore unthrottled for any signed-in ticket holder. Any outbound HTTP this plan adds must carry an explicit `AbortSignal.timeout(...)` — Node's global `fetch` has no default timeout, so one hung vendor connection would pin a Fastify request indefinitely.
- The backend is never compiled or bundled: `apps/backend/tsconfig.json:8` sets `"noEmit": true` and `apps/backend/package.json:8` starts with `tsx src/index.ts`. Non-TS assets under `apps/backend/src/` therefore ship verbatim into the Docker image via `Dockerfile:15` `COPY apps ./apps`. **Do not modify the Dockerfile or the backend tsconfig** — verified, neither needs a change for PNG assets to reach production.
- **`apps/backend/src/lib/wallet/zip.ts` is CORRECT and must not be replaced with a zip library.** It emits a spec-legal store-only archive; a 642 KB binary PNG entry was written through it and `unzip -t` reported "No errors detected" with correct CRCs and central-directory offsets. Compression method 0 is mandatory-to-support in the ZIP specification, so store-only is legal for `.pkpass`. The pass fails on its missing `icon.png`, not on the zip. Leave the file alone.
- Frequent commits: one commit per task, message in the repo's imperative sentence-case style (`git log --oneline` for examples — "Surface sign-in email send failures instead of faking success").

## Vendor claims this plan relies on

Every claim below was checked against live vendor documentation while writing this plan. The ones that could **not** be confirmed are marked; do not restate them as fact anywhere, including in the runbooks. Apple's modern documentation site (`developer.apple.com/documentation/...`) is JavaScript-rendered and could not be fetched at all — that is why several Apple rows are UNVERIFIED rather than contradicted.

| Claim | Status | Source checked |
| --- | --- | --- |
| "The safe length of an encoded JWT is 1800 characters. If the length is over 1800 characters, the save may not work due to truncation by web browsers." | **VERIFIED** — quoted verbatim | https://developers.google.com/wallet/tickets/events/web |
| `POST https://walletobjects.googleapis.com/walletobjects/v1/eventTicketClass` creates a class; scope `https://www.googleapis.com/auth/wallet_object.issuer` | **VERIFIED** | https://developers.google.com/wallet/tickets/events/rest/v1/eventticketclass/insert |
| Inserting an existing class id returns **409 AlreadyExists**; a service account without issuer access gets **403 "Permission Denied"**, fixed by authorising the service-account email in the Wallet console | **VERIFIED** | https://developers.google.com/wallet/tickets/events/resources/error-codes |
| `EventTicketClass` marks exactly four fields Required — `id`, `issuerName`, `eventName`, `reviewStatus`. `venue` itself is **not** marked required, but when present both `venue.name` and `venue.address` are ("This is required" appears on each). A developer may set `reviewStatus` only to `draft` or `underReview` (REST enum spellings `DRAFT` / `UNDER_REVIEW`); Google itself moves `underReview` to `approved`, and `draft` cannot be reverted once changed. | **VERIFIED** | https://developers.google.com/wallet/tickets/events/rest/v1/eventticketclass |
| Class and object ids take the form `issuerID.identifier`, where Google issues the `issuerID` portion, and "Your unique identifier should only include alphanumeric characters, '.', '_', or '-'." | **VERIFIED** — quoted verbatim | same page |
| Service-account access token: `POST https://oauth2.googleapis.com/token`, form-encoded `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` + `assertion=<RS256 JWT>`; JWT claims `iss` (SA email), `scope`, `aud` = the token URL, `exp` (max 1 h after `iat`), `iat`; RS256 is the only supported algorithm | **VERIFIED** | https://developers.google.com/identity/protocols/oauth2/service-account |
| The service account must be invited under **Users → Invite a user → Access level "Developer"** in the Google Pay & Wallet Console, separately from enabling the Cloud API | **VERIFIED** | https://developers.google.com/wallet/tickets/events/getting-started/auth/rest |
| New issuer accounts start in demo mode; only Admin/Developer users and explicitly listed test accounts can save a pass; passes show "[TEST ONLY]"; publishing access needs a completed business profile plus at least one created pass class | **VERIFIED** | https://developers.google.com/wallet/tickets/events/test-and-go-live/request-publishing-access |
| Issuer signup runs through https://goo.gle/wallet-console — business name, Wallet API card, "Create a pass" → "Build your first pass", accept the Wallet API ToS | **VERIFIED** | https://developers.google.com/wallet/tickets/events/getting-started/issuer-onboarding |
| **Google reviews pass *designs* against its brand guidelines when granting publishing access, and class images must be HTTPS-hosted URLs** | **UNVERIFIED.** The publishing-access page covers only the business-profile and one-created-class prerequisites; it says nothing about design review or image hosting. Treat "a logo-less class may be rejected" as a guess in the runbook, not a requirement. | https://developers.google.com/wallet/tickets/events/test-and-go-live/request-publishing-access |
| A `.pkpass` bundle contains `pass.json`, `manifest.json` (SHA-1 of every other file) and `signature` (PKCS#7 detached over the manifest, WWDR intermediate included, with an S/MIME signing-time attribute) | **VERIFIED** | https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html |
| Icon is 29 × 29 points, logo is bounded by 160 × 50 points; ship @1x/@2x/@3x | **VERIFIED** | same Apple page |
| **`icon.png` is mandatory and a pass without it fails to install** | **UNVERIFIED / CONTESTED.** Apple's archived Wallet Developer Guide lists *every* image, icon included, as optional per pass style. Third-party pass tooling and Apple's PKPass API docs describe the icon as required and as the image shown on the Lock Screen, in Notification Center and in Mail. We could not find a current, unambiguous Apple sentence saying "required". Treat the missing icon as the **most likely** cause of a failed install, not a proven one. Adding it is harmless either way, which is why this plan adds it. | https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html and https://developer.apple.com/documentation/passkit/pkpass/1618762-icon |
| **Apple treats `webServiceURL` and `authenticationToken` as a pair — present one without the other and the pass is invalid** | **UNVERIFIED.** The archived Wallet Developer Guide this plan cites elsewhere does not mention either key, and `https://developer.apple.com/documentation/walletpasses/pass` returns a title with no body to a non-JS fetch. **Task 2 does not depend on this claim**: both keys are removed because the `/api/passes` web service they advertise was never built (a repo-wide grep finds the string on exactly one line), and because the token leaks a value derived from `TRANSFER_LINK_SECRET` into a file the guest can unzip. | https://developer.apple.com/documentation/walletpasses/pass (unfetchable) |
| **`passTypeIdentifier` in `pass.json` must equal the certificate's UID exactly or iOS shows a generic "invalid data" error** | **UNVERIFIED.** Widely repeated by pass tooling and consistent with how the signature is validated, but no fetchable Apple page states it. The runbook keeps the advice and marks it as unconfirmed folklore. | Apple docs unfetchable; no archived page states it |
| **Pass Type ID certificates expire one year after issue** | **UNVERIFIED.** `https://developer.apple.com/help/account/certificates/create-a-pass-type-id/` 404s and the documentation site is unfetchable. The runbook therefore tells the operator to read the real expiry off their own certificate with `openssl x509 -noout -enddate` rather than assuming twelve months. | Apple docs unfetchable |
| **WWDR **G4** is the right intermediate for a Pass Type ID certificate** | **UNVERIFIED.** Apple's CA page currently offers G2 (exp. 2029-05-06), G3 (2030-02-20), G4 (2030-12-10), G5 (2030-12-10), G6 (2036-03-19) and WWDR MP CA 1 - G1 (2038-09-28). The page does not say which generation signs Pass Type ID certificates today. The runbook in Task 7 therefore does **not** hardcode G4 — it tells the operator to read the issuer off their own downloaded certificate and download the matching generation. | https://www.apple.com/certificateauthority/ |
| Apple Developer Program is **$99/year**; an Organization membership needs a D-U-N-S number and a legal entity; nonprofits/educational institutions may qualify for a fee waiver | **VERIFIED** | https://developer.apple.com/support/compare-memberships/ |

## Measurements taken while writing this plan

Reproduce any of these before doubting them.

- **The current fat JWT is over Google's limit for every realistic event.** Rebuilding the exact claims object from `apps/backend/src/lib/wallet/google.ts:41-76` with a 19-digit issuer id and a real 342-character RS256 signature gives **1976** characters for the shortest plausible ScottyLabs event, **2074** for a typical one and **2171** for a long one. There is no event shape that comes in under 1800. This is why Task 3 exists.
- **The shape this plan prescribes measures 1350 characters** for a deliberately worst-case event (68-char title, 59-char venue, 41-char holder name, 32-char committee, 68-char service-account email, 19-digit issuer id), i.e. a 1383-character save URL. That is 450 characters of headroom.
- **`sips` produces the exact asset sizes.** `sips -Z 29|58|87|50|100|150 -s format png apps/web/src/assets/scotty-logo-color.png` yields 29×29 (2,122 B), 58×58 (5,937 B), 87×87 (11,319 B), 50×50 (4,756 B), 100×100 (14,351 B), 150×150 (27,359 B) — 65.8 KB total, all RGBA, non-interlaced. The source is 1472×1472 and fully opaque, so no flattening is needed.
- **A malformed RSA PEM throws synchronously** from `createSign(...).sign()` with `code: ERR_OSSL_UNSUPPORTED`, and from `forge.pki.privateKeyFromPem` with "Too few bytes to parse DER." Both escape to the global Fastify handler at `apps/backend/src/server.ts:117-125` and reach the user as `{"error":"internal","message":"Something went wrong on our end."}` with status 500. That is the defect Task 4 fixes.
- **`AbortSignal.timeout(...)` on a `fetch` init typechecks clean** under `apps/backend/tsconfig.json`'s `"types": ["node"]`, as do global `fetch`, `URLSearchParams` and `Map`. Probed with `npx tsc --noEmit -p tsconfig.json`, exit 0.

---

## File Structure

### Created

| Path | Responsibility |
| --- | --- |
| `apps/backend/src/lib/wallet/assets/icon.png`<br>`…/icon@2x.png`, `…/icon@3x.png`<br>`…/logo.png`, `…/logo@2x.png`, `…/logo@3x.png` | Committed PNG binaries, generated once from `apps/web/src/assets/scotty-logo-color.png`. Live under `apps/backend` so `Dockerfile:15` carries them into the image. |
| `apps/backend/src/lib/wallet/assets.ts` | Reads those six files once via `readFileSync(new URL(…, import.meta.url))` and memoises them. Never `import x from "*.png"` — tsx has no asset loader and that throws `ERR_UNKNOWN_FILE_EXTENSION` at runtime. |
| `apps/backend/src/lib/wallet/row.ts` | The one Drizzle join both wallet paths need, plus the `PassRow` shape the DB-free modules are typed against. Replaces two byte-identical joins. |
| `apps/backend/src/lib/wallet/pass-bundle.ts` | DB-free, env-free Apple pass construction: `pass.json`, the bundle entry list, the manifest, and the PKCS#7 signature. This is the module the tests import. |
| `apps/backend/src/lib/wallet/pass-bundle.test.ts` | Asserts the bundle contents, the manifest hashes, the absence of the dead web-service keys, and that a malformed PEM returns `null` instead of throwing. |
| `apps/backend/src/lib/wallet/google-pass.ts` | DB-free, env-free Google construction: the `EventTicketClass` body, the `EventTicketObject` body, RS256 JWT signing, and the save URL. |
| `apps/backend/src/lib/wallet/google-pass.test.ts` | Asserts the save URL stays under 1800 characters for a worst-case event, that the JWT carries only the object, and that a malformed key returns `null`. |
| `apps/backend/src/lib/wallet/google-api.ts` | The only network module: service-account access token (JWT-bearer grant, cached) and the `eventTicketClass` insert/update call. Every `fetch` is bounded by `AbortSignal.timeout`, and a per-process class cache keeps repeat clicks from re-hitting Google. |
| `docs/google-wallet-setup.md` | Human runbook: issuer account, Cloud project, service account, **the Users-tab invite that is always missed**, demo-mode test accounts, publishing access, and how to reproduce a Google-side rejection by hand. |
| `docs/apple-wallet-certs.md` | Human runbook: Apple Developer Program, Pass Type ID, CSR, `.p12` → PEM conversion, the WWDR intermediate, env escaping, verification, renewal. |

### Modified

| Path | Change | Task |
| --- | --- | --- |
| `apps/backend/src/lib/wallet/apple.ts` (whole file) | Becomes a thin orchestrator: env gate → `loadPassRow` → `pass-bundle` → `buildZip`. Gains the icon/logo entries and the signing-failure 503; loses `webServiceURL`, `authenticationToken` and its own join. | 1, 2, 4 |
| `apps/backend/src/lib/wallet/google.ts` (whole file) | Becomes a thin orchestrator: env gate → `loadPassRow` → access token → class upsert → skinny save JWT, with a 503 for each failure mode. | 3, 4 |
| `apps/backend/src/env.ts:82-84` | **Comment only** — the parenthetical "(and the Apple pass auth token)" becomes false. The production guard on lines 85-88 (`const DEV_TRANSFER_SECRET` + the `if (…) throw`) is **not touched**: +1 transfer links still depend on `TRANSFER_LINK_SECRET`. The replacement comment is the same three lines as the old one, so no line numbers move. | 2 |
| `packages/contract/src/index.ts:84-100` | The `Me` schema object gains `wallet: { apple: boolean, google: boolean }`. This lands on **two** endpoints: `GET /api/auth/me` and the 200 body of `POST /api/auth/verify`. (`export type Me` is line 101 and needs no edit.) | 5 |
| `apps/backend/src/auth/service.ts:294-317` | `meFor` returns the flags on **both** branches, including the signed-out early return at line 295. | 5 |
| `apps/web/src/lib/auth.tsx:13,30` | The two places that construct a `Me` literal. | 5 |
| `apps/web/src/pages/TicketsPage.tsx:14, 138-151` | `PassCard` reads `useAuth()` (line 14 is the component signature); the button block at 138-151 renders a disabled "coming soon" button for each wallet whose flag is false. | 5 |
| `apps/web/src/pages/TicketsPage.tsx:157-159` | The footnote stops promising both passes and follows the same flags. Separate task, separate commit. | 6 |
| `apps/backend/src/lib/emails.ts:119` | "or add it to your wallet" fires on every approval, waitlist promotion and +1 claim. Corrected. | 6 |
| `README.md:74-77` | Stops claiming both integrations are "fully implemented". | 6 |
| `.env.example:24-34` | Annotates where each wallet value comes from and links the runbooks. | 7 |

### Deliberately unchanged — do not edit

| Path | Why |
| --- | --- |
| `apps/backend/src/lib/wallet/zip.ts` | Verified correct. See Global Constraints. |
| `Dockerfile`, `apps/backend/tsconfig.json` | Verified: PNG assets already reach production. |
| `apps/backend/src/env.ts:85-88` | The `TRANSFER_LINK_SECRET` production guard. Task 2 rewrites only the comment above it. |
| `apps/backend/src/server.ts:321-330` | The Apple route is a raw Fastify route (not ts-rest). It already does `reply.status(result.status).send({ error: "wallet", message: result.message })`, so a new 503 from `buildPkpass` reaches the browser with no route change. `apps/web/src/pages/TicketsPage.tsx:39-42` already renders that `message` in the yellow note box. |
| `apps/backend/src/routes/router.ts:707-714` | The `googleWallet` handler already forwards `result.status` verbatim, and `packages/contract/src/index.ts:623` already declares `503: ErrorBody` for that route. No contract or router change is needed for any of the new 503s. |

---

### Task 1: DB-free pass bundle with the icon and logo images

The `.pkpass` currently contains exactly three entries — `pass.json`, `manifest.json`, `signature` — because `apple.ts:71` seeds the file list with `pass.json` alone. This task adds the images and, to make that assertable at all, lifts pass construction out of `buildPkpass`, which cannot be tested as written: it imports `db/client` and `env` at module scope, short-circuits to a 503 unless four certificate env vars are set, and needs a real four-table join before it builds anything.

**Files:**
- Create: `apps/backend/src/lib/wallet/assets/icon.png`, `icon@2x.png`, `icon@3x.png`, `logo.png`, `logo@2x.png`, `logo@3x.png`
- Create: `apps/backend/src/lib/wallet/assets.ts`
- Create: `apps/backend/src/lib/wallet/row.ts`
- Create: `apps/backend/src/lib/wallet/pass-bundle.ts`
- Test: `apps/backend/src/lib/wallet/pass-bundle.test.ts`
- Modify: `apps/backend/src/lib/wallet/apple.ts` (whole file, currently 100 lines)

**Interfaces:**
- Consumes: `buildZip(entries: { name: string; data: Buffer }[]): Buffer` from `./zip`; `fmtShortDate(d: Date): string` and `fmtTimeWithZone(d: Date): string` from `../format`.
- Produces:
  - `interface PassRow` (in `./row`) — `{ ticket: { id: string; serial: string; number: number; kind: string }; event: { title: string; location: string; shortCode: string; startAt: Date; endAt: Date; passStyle: string; contactEmail: string }; user: { name: string | null; email: string }; committee: { name: string } }`
  - `loadPassRow(ticketId: string, userId: string): Promise<PassRow | null>` (in `./row`)
  - `interface PassConfig` (in `./pass-bundle`) — `{ passTypeId: string; teamId: string; apiUrl: string; transferLinkSecret: string }` (**narrowed to `{ passTypeId: string; teamId: string }` in Task 2**)
  - `buildPassJson(row: PassRow, cfg: PassConfig): Record<string, unknown>`
  - `bundleEntries(passJson: Record<string, unknown>): { name: string; data: Buffer }[]`
  - `manifestFor(entries: { name: string; data: Buffer }[]): Record<string, string>`
  - `signManifest(manifest: Buffer, pem: { cert: string; key: string; wwdr: string }): Promise<Buffer>` (**return type widened to `Promise<Buffer | null>` in Task 4; no test in Tasks 1-3 calls it, so no test file needs fixing then**)
  - `passAssets(): { name: string; data: Buffer }[]` (in `./assets`)

---

- [ ] **Step 1: Generate and commit the six PNG assets**

There is no image library in `apps/backend/package.json`, so resizing is a one-time step whose outputs are committed. `sips` ships with macOS. Run from the repository root:

```bash
mkdir -p apps/backend/src/lib/wallet/assets
SRC=apps/web/src/assets/scotty-logo-color.png
for pair in 29:icon.png 58:icon@2x.png 87:icon@3x.png 50:logo.png 100:logo@2x.png 150:logo@3x.png; do
  sips -Z "${pair%%:*}" -s format png "$SRC" --out "apps/backend/src/lib/wallet/assets/${pair##*:}"
done
file apps/backend/src/lib/wallet/assets/*.png
```

Expected — exactly these dimensions, nothing else:

```
icon.png:     PNG image data, 29 x 29, 8-bit/color RGBA, non-interlaced
icon@2x.png:  PNG image data, 58 x 58, 8-bit/color RGBA, non-interlaced
icon@3x.png:  PNG image data, 87 x 87, 8-bit/color RGBA, non-interlaced
logo.png:     PNG image data, 50 x 50, 8-bit/color RGBA, non-interlaced
logo@2x.png:  PNG image data, 100 x 100, 8-bit/color RGBA, non-interlaced
logo@3x.png:  PNG image data, 150 x 150, 8-bit/color RGBA, non-interlaced
```

Icon is 29 × 29 points and logo is bounded by 160 × 50 points (https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html); the source mark is square, so the logo is rendered square at its 50-point height.

Do **not** source the image from `design_handoff_scottylabs_invites/` — `.dockerignore:7` excludes that whole directory from the build context, so the file would not exist in the deployed image and the read would `ENOENT` in production only.

If you are not on macOS, produce the same six files with any tool; only the dimensions and the PNG format matter.

- [ ] **Step 2: Write the failing test**

Create `apps/backend/src/lib/wallet/pass-bundle.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPassJson, bundleEntries, manifestFor, type PassConfig } from "./pass-bundle";
import type { PassRow } from "./row";

const ROW: PassRow = {
  ticket: { id: "6f1c7f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", serial: "SIT-001-EUGENEO", number: 1, kind: "primary" },
  event: {
    title: "ScottyLabs Fall Kickoff",
    location: "Rashid Auditorium, Gates Hillman Center",
    shortCode: "abcdmnp",
    startAt: new Date("2026-09-11T23:00:00.000Z"),
    endAt: new Date("2026-09-12T02:00:00.000Z"),
    passStyle: "dark",
    contactEmail: "hello@scottylabs.org",
  },
  user: { name: "Eugene O", email: "eugeneo@andrew.cmu.edu" },
  committee: { name: "ScottyLabs" },
};

const CFG: PassConfig = {
  passTypeId: "pass.org.scottylabs.invite",
  teamId: "ABCDE12345",
  apiUrl: "https://invite.scottylabs.org",
  transferLinkSecret: "test-secret-not-used-here-0123456789abcdef",
};

describe("pkpass bundle", () => {
  it("carries the icon and logo images alongside pass.json", () => {
    const names = bundleEntries(buildPassJson(ROW, CFG)).map((e) => e.name);
    expect(names).toEqual([
      "pass.json",
      "icon.png",
      "icon@2x.png",
      "icon@3x.png",
      "logo.png",
      "logo@2x.png",
      "logo@3x.png",
    ]);
  });

  it("ships real PNG bytes for every image entry", () => {
    const images = bundleEntries(buildPassJson(ROW, CFG)).filter((e) => e.name.endsWith(".png"));
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(Array.from(image.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  it("hashes every bundle entry into the manifest", () => {
    const entries = bundleEntries(buildPassJson(ROW, CFG));
    const manifest = manifestFor(entries);
    expect(Object.keys(manifest).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const entry of entries) {
      expect(manifest[entry.name]).toBe(createHash("sha1").update(entry.data).digest("hex"));
    }
  });

  it("identifies the pass with the configured pass type and team", () => {
    const passJson = buildPassJson(ROW, CFG);
    expect(passJson.passTypeIdentifier).toBe("pass.org.scottylabs.invite");
    expect(passJson.teamIdentifier).toBe("ABCDE12345");
    expect(passJson.serialNumber).toBe("SIT-001-EUGENEO");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/pass-bundle.test.ts
```

Expected: FAIL with `Failed to resolve import "./pass-bundle"` — that module does not exist yet. **`./row` is imported with `import type`, which esbuild erases before resolution, so it will not appear in the error.** vitest does no typechecking at all, so no TypeScript diagnostics appear in this output either.

- [ ] **Step 4: Write the asset loader**

Create `apps/backend/src/lib/wallet/assets.ts`:

```ts
import { readFileSync } from "node:fs";

/**
 * Pass images, read from disk once and cached.
 *
 * The backend is never compiled or bundled (tsconfig has noEmit, package.json
 * starts `tsx src/index.ts`), so these .png files ship verbatim into the Docker
 * image via `COPY apps ./apps`. Resolve them from import.meta.url — the same
 * pattern env.ts:7-8 uses — never from process.cwd().
 *
 * Never write `import icon from "./assets/icon.png"`: tsx has no asset loader
 * and it throws ERR_UNKNOWN_FILE_EXTENSION at runtime while looking fine in an
 * editor.
 */
const NAMES = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"] as const;

let cache: { name: string; data: Buffer }[] | null = null;

export function passAssets(): { name: string; data: Buffer }[] {
  if (!cache) {
    cache = NAMES.map((name) => ({ name, data: readFileSync(new URL(`./assets/${name}`, import.meta.url)) }));
  }
  return cache;
}
```

- [ ] **Step 5: Write the shared row loader**

Both `apple.ts` and `google.ts` currently run a byte-identical four-table join. Create `apps/backend/src/lib/wallet/row.ts` with the single copy, plus the plain shape the DB-free modules are typed against:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client";

/**
 * The joined ticket a wallet pass is built from, flattened to plain values so
 * the pass builders can be imported (and tested) without touching the database.
 *
 * passStyle is deliberately widened to `string`: the Drizzle column type
 * (schema.ts:114) is a TypeScript-only union, not a Postgres CHECK, so a third
 * value is representable. Both builders therefore use the same
 * `passStyle !== "light"` predicate — see Global Constraints.
 */
export interface PassRow {
  ticket: { id: string; serial: string; number: number; kind: string };
  event: {
    title: string;
    location: string;
    shortCode: string;
    startAt: Date;
    endAt: Date;
    passStyle: string;
    contactEmail: string;
  };
  user: { name: string | null; email: string };
  committee: { name: string };
}

/** Live, non-revoked ticket owned by this user. Null means 404. */
export async function loadPassRow(ticketId: string, userId: string): Promise<PassRow | null> {
  const rows = await db
    .select({ ticket: schema.tickets, event: schema.events, user: schema.users, committee: schema.committees })
    .from(schema.tickets)
    .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
    .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, userId), isNull(schema.tickets.revokedAt)));

  const r = rows[0];
  if (!r) return null;
  return {
    ticket: { id: r.ticket.id, serial: r.ticket.serial, number: r.ticket.number, kind: r.ticket.kind },
    event: {
      title: r.event.title,
      location: r.event.location,
      shortCode: r.event.shortCode,
      startAt: r.event.startAt,
      endAt: r.event.endAt,
      passStyle: r.event.passStyle,
      contactEmail: r.event.contactEmail,
    },
    user: { name: r.user.name, email: r.user.email },
    committee: { name: r.committee.name },
  };
}
```

- [ ] **Step 6: Write the DB-free pass bundle module**

Create `apps/backend/src/lib/wallet/pass-bundle.ts`. It imports nothing from `db/client` or `env`, which is what makes the test above run with no Postgres and no wallet env vars:

```ts
import { createHash } from "node:crypto";
import { passAssets } from "./assets";
import { fmtShortDate, fmtTimeWithZone } from "../format";
import type { PassRow } from "./row";

export interface PassConfig {
  passTypeId: string;
  teamId: string;
  apiUrl: string;
  transferLinkSecret: string;
}

/** The pass.json body. Pure — no env, no database. */
export function buildPassJson(row: PassRow, cfg: PassConfig): Record<string, unknown> {
  // The single dark-mode predicate — identical in google-pass.ts and in
  // TicketsPage.tsx:15, so all three renderings of one event agree.
  const dark = row.event.passStyle !== "light";
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    organizationName: "ScottyLabs",
    serialNumber: row.ticket.serial,
    description: `Scotty Invite — ${row.event.title}`,
    logoText: "Scotty invite",
    foregroundColor: dark ? "rgb(255,255,255)" : "rgb(30,30,30)",
    backgroundColor: dark ? "rgb(10,10,10)" : "rgb(255,255,255)",
    labelColor: dark ? "rgb(158,177,194)" : "rgb(95,111,127)",
    webServiceURL: `${cfg.apiUrl}/api/passes`,
    authenticationToken: createHash("sha256")
      .update(`${cfg.transferLinkSecret}:${row.ticket.id}`)
      .digest("hex")
      .slice(0, 32),
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: row.ticket.serial,
        messageEncoding: "iso-8859-1",
        altText: row.ticket.serial,
      },
    ],
    relevantDate: row.event.startAt.toISOString(),
    eventTicket: {
      headerFields: [{ key: "num", label: "Nº", value: String(row.ticket.number).padStart(3, "0") }],
      primaryFields: [{ key: "event", label: row.committee.name.toUpperCase(), value: row.event.title }],
      secondaryFields: [
        { key: "date", label: "DATE", value: fmtShortDate(row.event.startAt) },
        { key: "doors", label: "DOORS", value: fmtTimeWithZone(row.event.startAt) },
      ],
      auxiliaryFields: [
        { key: "loc", label: "LOCATION", value: row.event.location },
        {
          key: "guest",
          label: "GUEST",
          value: (row.user.name ?? row.user.email) + (row.ticket.kind === "plus_one" ? " +1" : ""),
        },
      ],
      backFields: [
        { key: "serial", label: "Serial", value: row.ticket.serial },
        { key: "contact", label: "Questions?", value: row.event.contactEmail },
      ],
    },
  };
}

/**
 * Everything the manifest must hash. Order matters only for the test's sake.
 * manifest.json and signature are deliberately NOT here — they are appended at
 * zip time, and the manifest never hashes itself.
 */
export function bundleEntries(passJson: Record<string, unknown>): { name: string; data: Buffer }[] {
  return [{ name: "pass.json", data: Buffer.from(JSON.stringify(passJson)) }, ...passAssets()];
}

/** SHA-1 per entry, hex, exactly as Wallet recomputes it on open. */
export function manifestFor(entries: { name: string; data: Buffer }[]): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const entry of entries) manifest[entry.name] = createHash("sha1").update(entry.data).digest("hex");
  return manifest;
}

/**
 * Detached PKCS#7 signature over the manifest, with the WWDR intermediate
 * included. node-forge is imported lazily so the dependency is only touched
 * when certificates exist.
 */
export async function signManifest(
  manifest: Buffer,
  pem: { cert: string; key: string; wwdr: string },
): Promise<Buffer> {
  const forge = await import("node-forge");
  const p7 = forge.default.pkcs7.createSignedData();
  p7.content = forge.default.util.createBuffer(manifest.toString("binary"));
  const cert = forge.default.pki.certificateFromPem(pem.cert.replace(/\\n/g, "\n"));
  const key = forge.default.pki.privateKeyFromPem(pem.key.replace(/\\n/g, "\n"));
  const wwdr = forge.default.pki.certificateFromPem(pem.wwdr.replace(/\\n/g, "\n"));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.default.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.default.pki.oids.contentType, value: forge.default.pki.oids.data },
      { type: forge.default.pki.oids.messageDigest },
      { type: forge.default.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.default.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/pass-bundle.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Rewrite apple.ts as a thin orchestrator**

Replace the whole of `apps/backend/src/lib/wallet/apple.ts` with the following. The env gate, the 404 and the return shape are unchanged; the pass body and signing now come from `pass-bundle.ts`, and the images ride along in `entries` so `manifestFor` hashes them:

```ts
import { env } from "../../env";
import { loadPassRow } from "./row";
import { bundleEntries, buildPassJson, manifestFor, signManifest } from "./pass-bundle";
import { buildZip } from "./zip";

/**
 * Signed .pkpass generation (pass type pass.org.scottylabs.invite). Activates
 * when APPLE_PASS_CERT_PEM / APPLE_PASS_KEY_PEM / APPLE_WWDR_CERT_PEM /
 * APPLE_TEAM_ID are configured — see docs/apple-wallet-certs.md.
 */
export async function buildPkpass(
  ticketId: string,
  userId: string,
): Promise<{ ok: true; buffer: Buffer; filename: string } | { ok: false; status: 404 | 503; message: string }> {
  if (!env.applePassCert || !env.applePassKey || !env.appleWwdrCert || !env.appleTeamId) {
    return {
      ok: false,
      status: 503,
      message:
        "Apple Wallet passes aren't configured yet — set APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM, APPLE_WWDR_CERT_PEM and APPLE_TEAM_ID.",
    };
  }

  const row = await loadPassRow(ticketId, userId);
  if (!row) return { ok: false, status: 404, message: "Ticket not found" };

  const entries = bundleEntries(
    buildPassJson(row, {
      passTypeId: env.applePassTypeId,
      teamId: env.appleTeamId,
      apiUrl: env.apiUrl,
      transferLinkSecret: env.transferLinkSecret,
    }),
  );
  const manifestBuf = Buffer.from(JSON.stringify(manifestFor(entries)));
  const signature = await signManifest(manifestBuf, {
    cert: env.applePassCert,
    key: env.applePassKey,
    wwdr: env.appleWwdrCert,
  });

  const zip = buildZip([
    ...entries,
    { name: "manifest.json", data: manifestBuf },
    { name: "signature", data: signature },
  ]);
  return { ok: true, buffer: zip, filename: `${row.ticket.serial}.pkpass` };
}
```

- [ ] **Step 9: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS in all three packages. `apps/backend/src/lib/wallet/google.ts` is untouched and still compiles with its own join — that is fine; Task 3 moves it onto `loadPassRow`.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/lib/wallet/assets apps/backend/src/lib/wallet/assets.ts \
        apps/backend/src/lib/wallet/row.ts apps/backend/src/lib/wallet/pass-bundle.ts \
        apps/backend/src/lib/wallet/pass-bundle.test.ts apps/backend/src/lib/wallet/apple.ts
git commit -m "Put the icon and logo images iOS looks for into the pkpass bundle"
```

---

### Task 2: Stop advertising a pass web service that does not exist

`pass.json` sets `webServiceURL: "${env.apiUrl}/api/passes"` and an `authenticationToken` derived as `sha256(transferLinkSecret + ":" + ticketId)` truncated to 32 hex characters. A repository-wide grep shows `/api/passes` appears on that one line and nowhere else — no registration, update or log endpoint was ever built. Two further reasons this must go:

- `env.apiUrl` defaults to `http://localhost:4000`, so a locally generated pass embeds a plaintext-HTTP web service URL.
- Deleting the token removes oracle output derived from `TRANSFER_LINK_SECRET` — the same secret that authenticates +1 transfer links (`apps/backend/src/services/transfers.ts:8`) — from a file the guest downloads and can unzip. It is inert today, but removing it is a net security win.

Both keys go together. It is widely repeated that Apple treats them as a pair and rejects a pass carrying one without the other, but **that claim is UNVERIFIED** (see the vendor table: Apple's documentation site is JS-rendered and unfetchable, and the archived guide mentions neither key). Nothing here depends on it — the two reasons above stand on their own.

**Files:**
- Modify: `apps/backend/src/lib/wallet/pass-bundle.ts` (the `PassConfig` interface and `buildPassJson`)
- Modify: `apps/backend/src/lib/wallet/apple.ts` (the `buildPassJson` call site)
- Modify: `apps/backend/src/lib/wallet/pass-bundle.test.ts` (the `CFG` constant, plus one new test)
- Modify: `apps/backend/src/env.ts:82-84` (**comment only** — the guard on 85-88 stays byte-for-byte as it is)

**Interfaces:**
- Consumes: `buildPassJson`, `PassConfig` from Task 1.
- Produces: `PassConfig` narrowed to `{ passTypeId: string; teamId: string }`. Nothing else changes.

---

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/lib/wallet/pass-bundle.test.ts`, replace the `CFG` constant and append one test inside the existing `describe("pkpass bundle", …)` block. After the edit the constant reads:

```ts
const CFG: PassConfig = {
  passTypeId: "pass.org.scottylabs.invite",
  teamId: "ABCDE12345",
};
```

and the new test is the last one in the block:

```ts
  it("does not advertise a pass web service, because /api/passes does not exist", () => {
    const passJson = buildPassJson(ROW, CFG);
    expect(passJson.webServiceURL).toBeUndefined();
    expect(passJson.authenticationToken).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/pass-bundle.test.ts
```

Expected: FAIL, 1 of 5 tests, on the new assertion:

```
AssertionError: expected 'undefined/api/passes' to be undefined
```

`cfg.apiUrl` is now missing from `CFG`, so the template literal in `buildPassJson` interpolates the string `"undefined"` — that is why the message reads `undefined/api/passes` and not a real URL. **No TypeScript error appears in this output**: vitest transpiles with esbuild and never typechecks. The type error that `CFG` no longer satisfies `PassConfig` surfaces only under `pnpm -r typecheck`, and Step 3 removes it.

- [ ] **Step 3: Remove the two fields and narrow the config**

In `apps/backend/src/lib/wallet/pass-bundle.ts`, the interface becomes:

```ts
export interface PassConfig {
  passTypeId: string;
  teamId: string;
}
```

and the head of `buildPassJson` — the two `webServiceURL` / `authenticationToken` lines deleted, everything else identical — reads:

```ts
    labelColor: dark ? "rgb(158,177,194)" : "rgb(95,111,127)",
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: row.ticket.serial,
```

`createHash` stays imported — `manifestFor` and `signManifest` still need it.

- [ ] **Step 4: Update the apple.ts call site**

In `apps/backend/src/lib/wallet/apple.ts`, the `bundleEntries` call becomes:

```ts
  const entries = bundleEntries(
    buildPassJson(row, { passTypeId: env.applePassTypeId, teamId: env.appleTeamId }),
  );
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/pass-bundle.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Correct the stale comment in env.ts**

`apps/backend/src/env.ts:82-84` claims the secret also derives the Apple pass auth token, which is no longer true. **Rewrite those three comment lines and nothing else.** The block below them — `const DEV_TRANSFER_SECRET` on line 85 and the `if (…) throw` on lines 86-88 — is a production guard that +1 transfer links still depend on; it is reproduced here only so you can see where the comment ends.

After the edit:

```ts
// Fail closed in production: +1 transfer links are HMAC'd with this. Booting
// prod with the source-visible dev default would make every +1 token forgeable,
// so refuse to start.
const DEV_TRANSFER_SECRET = "dev-transfer-secret-change-me";                                            // unchanged — shown for context only
if (env.isProd && (env.transferLinkSecret === DEV_TRANSFER_SECRET || env.transferLinkSecret.length < 32)) { // unchanged — shown for context only
  throw new Error("TRANSFER_LINK_SECRET must be set to a strong value (>= 32 chars) in production");    // unchanged — shown for context only
}                                                                                                       // unchanged — shown for context only
```

The replacement comment is exactly three lines, the same as the old one, so lines 85-88 do not move. `git diff apps/backend/src/env.ts` must show three changed lines and nothing else.

- [ ] **Step 7: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/lib/wallet/pass-bundle.ts apps/backend/src/lib/wallet/pass-bundle.test.ts \
        apps/backend/src/lib/wallet/apple.ts apps/backend/src/env.ts
git commit -m "Drop the pkpass web service URL and auth token for an endpoint that never existed"
```

---

### Task 3: Pre-create the Google event class over REST and ship a skinny save JWT

Today the whole `EventTicketClass` and `EventTicketObject` are embedded in the save JWT. Google documents that "The safe length of an encoded JWT is 1800 characters. If the length is over 1800 characters, the save may not work due to truncation by web browsers." (https://developers.google.com/wallet/tickets/events/web). The current JWT measures **1976 / 2074 / 2171** characters for a short / typical / long ScottyLabs event — over the limit unconditionally, with no event shape that fits.

Trimming the payload was measured and does not fix it: a typical event lands at 1718 characters and a long title pushes it straight back over. So the class moves to where Google puts it — created once per event over the Wallet REST API — and the JWT carries only the ticket object. **Measured: 1350 characters for a deliberately worst-case event, a 1383-character save URL.**

This has a second, larger benefit. The fat-JWT flow makes zero server-side calls, so when Google rejects a pass — overwhelmingly because the service account was never invited to the issuer account — the user lands on a generic Google error page and **nothing at all appears in this application's logs**. After this task the class insert happens server-side, so that failure becomes an observable 403 that turns into an actionable 503 in the yellow note box.

**Hazard this task creates, and how it is contained.** It turns `googleWallet` — an unthrottled route, because `@fastify/rate-limit` is a dependency that is registered nowhere — from zero outbound HTTP calls into up to three per click. Two mitigations are mandatory and are built into the code below, not left as an exercise:

1. **Every `fetch` carries `signal: AbortSignal.timeout(5000)`.** Node's global `fetch` has no default timeout; without this, one hung Google connection pins a Fastify request forever and a handful of clicks exhausts the connection pool.
2. **`upsertEventTicketClass` keeps a per-process `Map<classId, sha1(classBody)>`.** A repeat click on the same event with an unchanged class body makes **zero** Google calls. Hashing the body rather than just remembering the id preserves the "an organizer edit propagates on the next save click" property — an edited title changes the body, changes the hash, and forces the upsert through. The map holds one short string per event this process has served.

**Dependency decision — hand-roll, do not add a library.** Fetching a service-account access token needs an RS256-signed JWT posted to Google's token endpoint. `apps/backend/src/lib/wallet/google.ts:80-82` already signs RS256 with `node:crypto`, Node 22 has global `fetch`, and the whole grant is about 20 lines. `google-auth-library` would be the repository's first Google dependency and pulls a large transitive tree (gaxios, gcp-metadata, gtoken, jws) to wrap primitives already in use here. Hand-roll it in `google-api.ts`.

**Files:**
- Create: `apps/backend/src/lib/wallet/google-pass.ts`
- Create: `apps/backend/src/lib/wallet/google-api.ts` — **no unit test.** Every function in it is a network call; there is no HTTP mocking library in `apps/backend/package.json` and adding one is out of scope. Its behaviour is verified by hand: Task 5 Step 6 case 2 (bad key → the token path's 503) and `docs/google-wallet-setup.md` §7 (the real vendor failures).
- Test: `apps/backend/src/lib/wallet/google-pass.test.ts`
- Modify: `apps/backend/src/lib/wallet/google.ts` (whole file, currently 85 lines)

**Interfaces:**
- Consumes: `PassRow`, `loadPassRow(ticketId, userId)` from Task 1's `./row`.
- Produces:
  - `interface GoogleWalletConfig` — `{ issuerId: string; saEmail: string; saKeyPem: string; appUrl: string }`
  - `interface EventTicketClass` — `{ id: string; [key: string]: unknown }`
  - `classIdFor(row: PassRow, issuerId: string): string`
  - `objectIdFor(row: PassRow, issuerId: string): string`
  - `buildEventTicketClass(row: PassRow, cfg: GoogleWalletConfig): EventTicketClass`
  - `buildEventTicketObject(row: PassRow, cfg: GoogleWalletConfig): Record<string, unknown>`
  - `signJwt(claims: Record<string, unknown>, keyPem: string): string` — throws on an unusable PEM
  - `buildSaveUrl(row: PassRow, cfg: GoogleWalletConfig): string` (**return type widened to `string | null` in Task 4, which also fixes this task's test file**)
  - `accessToken(saEmail: string, keyPem: string): Promise<string>` (in `./google-api`, throws on failure — including a `TimeoutError` after 5 s)
  - `upsertEventTicketClass(ticketClass: EventTicketClass, token: string): Promise<{ ok: true } | { ok: false; status: number; detail: string }>` (in `./google-api`) — **never throws.** `status` is Google's HTTP status, or the sentinel `0` when no HTTP response was received at all (timeout, DNS, TLS).

---

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/lib/wallet/google-pass.test.ts`. The worst-case row is deliberately extreme — a 68-character title, a 59-character venue, a 41-character holder name, a 32-character committee, a 68-character service-account email and a 19-digit issuer id:

```ts
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
```

The four fields this last test pins are exactly the four `EventTicketClass` marks Required, and `UNDER_REVIEW` is one of the two states a developer is allowed to set (Google itself promotes it to `approved`). `venue` is optional but must carry both `name` and `address` when present, which is why `buildEventTicketClass` always sets both. All of this is the `EventTicketClass` reference row in the vendor-claims table.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/google-pass.test.ts
```

Expected: FAIL with `Failed to resolve import "./google-pass"`. (`./row` is an erased `import type` and will not be named.)

- [ ] **Step 3: Write the DB-free Google pass module**

Create `apps/backend/src/lib/wallet/google-pass.ts`. Note what is *not* in the object any more: the object-level `hexBackgroundColor` (the class already carries it, and it is ~30 wasted bytes in a size-constrained JWT) and the "Doors" text module (the class's `dateTime` conveys it). The class's colour is now driven off `passStyle`, fixing a light-styled event getting a black Google pass:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet/google-pass.test.ts
```

Expected: PASS, 4 tests. If the length assertion fails, print `jwt.length` before shortening anything — the measured worst case is 1350.

- [ ] **Step 5: Write the Wallet REST client**

Create `apps/backend/src/lib/wallet/google-api.ts`. Every URL, grant type, scope and status code below is cited in the vendor-claims table at the top of this plan:

```ts
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
```

- [ ] **Step 6: Rewrite google.ts as a thin orchestrator**

Replace the whole of `apps/backend/src/lib/wallet/google.ts`. The env gate, the 404, and the `{ ok: false; status: 401 | 404 | 503 }` union are unchanged, so neither the contract nor `router.ts` needs touching. Each new failure maps onto the 503 arm that already exists, with a message naming the actual fix — and a stalled network never borrows the "your key is broken" message:

```ts
import { env } from "../../env";
import { loadPassRow } from "./row";
import { buildEventTicketClass, buildSaveUrl, type GoogleWalletConfig } from "./google-pass";
import { accessToken, upsertEventTicketClass } from "./google-api";

const UNREACHABLE =
  "Google Wallet didn't respond in time. This is usually transient — try again in a moment. If it keeps happening, see docs/google-wallet-setup.md.";

const BAD_KEY =
  "Google Wallet is misconfigured — GOOGLE_WALLET_SA_KEY_PEM isn't a usable RSA private key. Paste the `private_key` value from the service-account JSON, keeping its \\n escapes, not the whole JSON file. See docs/google-wallet-setup.md.";

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
    const name = (err as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { ok: false, status: 503, message: timedOut ? UNREACHABLE : BAD_KEY };
  }

  const upserted = await upsertEventTicketClass(buildEventTicketClass(row, cfg), token);
  if (!upserted.ok) {
    console.error("[wallet] google eventTicketClass upsert failed", upserted.status, upserted.detail);
    let message: string;
    if (upserted.status === 0) {
      message = UNREACHABLE;
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
```

- [ ] **Step 7: Typecheck and re-run both wallet test files**

Run:

```bash
pnpm -r typecheck && cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet
```

Expected: typecheck PASS; 9 tests PASS across `pass-bundle.test.ts` and `google-pass.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/lib/wallet/google-pass.ts apps/backend/src/lib/wallet/google-api.ts \
        apps/backend/src/lib/wallet/google-pass.test.ts apps/backend/src/lib/wallet/google.ts
git commit -m "Pre-create the Google event class over REST so the save link fits Google's JWT limit"
```

---

### Task 4: A malformed key returns an actionable 503, not a generic 500

Both signing paths throw synchronously on a bad PEM — `createSign(...).sign()` with `ERR_OSSL_UNSUPPORTED`, `forge.pki.privateKeyFromPem` with "Too few bytes to parse DER." — and both escape to the global Fastify handler at `apps/backend/src/server.ts:117-125`, so the operator sees "Something went wrong on our end." with no hint that a certificate is at fault.

**Route work: none, on either side.** The Google route already declares `503: ErrorBody` in the contract (`packages/contract/src/index.ts:623`) and `router.ts:712` forwards `result.status` verbatim. The Apple route is a **raw Fastify route**, not ts-rest — `apps/backend/src/server.ts:321-330` — and already does `reply.status(result.status).send({ error: "wallet", message: result.message })`, and `buildPkpass`'s return union already includes 503. Both messages land in the yellow `walletNote` box the tickets page already renders.

Both fixes take the same shape: the DB-free function returns `null` on a signing failure and logs the diagnostic server-side; the orchestrator maps `null` to the 503.

Two scope notes, so nothing here is claimed to be tested that is not:

- After Task 3 a malformed **Google** key is usually caught earlier, at the access-token request, by the `try`/`catch` around `accessToken` in `google.ts`. `buildSaveUrl`'s `null` branch closes the last path that can still throw (a key that signs the token assertion but fails on the save JWT), and the unit test in Step 1 exercises it directly.
- The **Apple** `null` branch is covered by the unit test in Step 1 at the `signManifest` level. Its end-to-end 503 — the message actually reaching the yellow box — has no unit test, because `buildPkpass` needs both env vars and Postgres. It is verified by hand in **Task 5, Step 6, case 3**, which is runnable today with garbage certificate values.

**Files:**
- Modify: `apps/backend/src/lib/wallet/pass-bundle.ts` (`signManifest`)
- Modify: `apps/backend/src/lib/wallet/google-pass.ts` (`buildSaveUrl`)
- Modify: `apps/backend/src/lib/wallet/apple.ts`, `apps/backend/src/lib/wallet/google.ts` (the `null` branches)
- Test: `apps/backend/src/lib/wallet/pass-bundle.test.ts` (one new test), `apps/backend/src/lib/wallet/google-pass.test.ts` (one new test **plus a compile fix for the three existing tests** — see Step 5)

**Interfaces:**
- Consumes: `signManifest`, `buildSaveUrl` from Tasks 1 and 3.
- Produces: `signManifest(manifest, pem): Promise<Buffer | null>` and `buildSaveUrl(row, cfg): string | null` — `null` means "the configured PEM cannot sign".

---

- [ ] **Step 1: Write the failing tests**

Append to the `describe("pkpass bundle", …)` block in `apps/backend/src/lib/wallet/pass-bundle.test.ts` (and add `signManifest` to that file's existing import from `./pass-bundle`):

```ts
  it("returns null instead of throwing when the signing certificates are unparseable", async () => {
    const signature = await signManifest(Buffer.from("{}"), {
      cert: "-----BEGIN CERTIFICATE-----\\nnot-a-cert\\n-----END CERTIFICATE-----",
      key: "-----BEGIN PRIVATE KEY-----\\nnot-a-key\\n-----END PRIVATE KEY-----",
      wwdr: "-----BEGIN CERTIFICATE-----\\nnot-a-cert\\n-----END CERTIFICATE-----",
    });
    expect(signature).toBeNull();
  });
```

Append to the `describe("google wallet save link", …)` block in `apps/backend/src/lib/wallet/google-pass.test.ts`:

```ts
  it("returns null instead of throwing when the service-account key is unusable", () => {
    expect(buildSaveUrl(WORST_CASE, { ...CFG, saKeyPem: "garbage" })).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet
```

Expected: FAIL — two failures. The Apple one throws "Too few bytes to parse DER."; the Google one throws with `code: ERR_OSSL_UNSUPPORTED` ("error:1E08010C:DECODER routines::unsupported").

- [ ] **Step 3: Make signManifest fail soft**

In `apps/backend/src/lib/wallet/pass-bundle.ts`, wrap the body of `signManifest`. The signature and the doc comment change; the forge code inside is unchanged from Task 1:

```ts
/**
 * Detached PKCS#7 signature over the manifest, with the WWDR intermediate
 * included. node-forge is imported lazily so the dependency is only touched
 * when certificates exist. Returns null when a PEM cannot be parsed — the
 * caller turns that into an actionable 503 rather than letting forge's DER
 * error surface as a generic 500.
 */
export async function signManifest(
  manifest: Buffer,
  pem: { cert: string; key: string; wwdr: string },
): Promise<Buffer | null> {
  try {
    const forge = await import("node-forge");
    const p7 = forge.default.pkcs7.createSignedData();
    p7.content = forge.default.util.createBuffer(manifest.toString("binary"));
    const cert = forge.default.pki.certificateFromPem(pem.cert.replace(/\\n/g, "\n"));
    const key = forge.default.pki.privateKeyFromPem(pem.key.replace(/\\n/g, "\n"));
    const wwdr = forge.default.pki.certificateFromPem(pem.wwdr.replace(/\\n/g, "\n"));
    p7.addCertificate(wwdr);
    p7.addCertificate(cert);
    p7.addSigner({
      key,
      certificate: cert,
      digestAlgorithm: forge.default.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.default.pki.oids.contentType, value: forge.default.pki.oids.data },
        { type: forge.default.pki.oids.messageDigest },
        { type: forge.default.pki.oids.signingTime, value: new Date() as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    return Buffer.from(forge.default.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
  } catch (err) {
    console.error("[wallet] apple pkpass signing failed", err);
    return null;
  }
}
```

No existing test calls `signManifest`, so nothing else in `pass-bundle.test.ts` needs touching.

- [ ] **Step 4: Make buildSaveUrl fail soft**

In `apps/backend/src/lib/wallet/google-pass.ts`:

```ts
/** Null when GOOGLE_WALLET_SA_KEY_PEM cannot sign — the caller returns a 503. */
export function buildSaveUrl(row: PassRow, cfg: GoogleWalletConfig): string | null {
  const claims = {
    iss: cfg.saEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [cfg.appUrl],
    payload: { eventTicketObjects: [buildEventTicketObject(row, cfg)] },
  };
  try {
    return `https://pay.google.com/gp/v/save/${signJwt(claims, cfg.saKeyPem)}`;
  } catch (err) {
    console.error("[wallet] google save JWT signing failed", err);
    return null;
  }
}
```

- [ ] **Step 5: Keep Task 3's three existing google tests compiling against the widened type**

Step 4 just made `buildSaveUrl` return `string | null`, and Task 3's tests call it in three places that assume a bare `string`:

- `buildSaveUrl(WORST_CASE, CFG).slice(SAVE_PREFIX.length)` → `TS2531: Object is possibly 'null'.`
- `claimsOf(buildSaveUrl(WORST_CASE, CFG))`, twice → `TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.`

`apps/backend/tsconfig.json` has `"include": ["src"]` and `"strict": true`, so `pnpm -r typecheck` compiles `.test.ts` files and Step 7 would fail on these three lines. vitest would not have told you — it does not typecheck.

In `apps/backend/src/lib/wallet/google-pass.test.ts`, add this helper directly below `claimsOf`:

```ts
/**
 * buildSaveUrl returns string | null (null = the PEM cannot sign). These three
 * tests use a real generated key, so null is a bug, not a case to handle.
 */
function saveUrl(row: PassRow, cfg: GoogleWalletConfig): string {
  const url = buildSaveUrl(row, cfg);
  if (!url) throw new Error("expected a save url");
  return url;
}
```

and route the three existing call sites through it — the assertions themselves are unchanged:

```ts
  it("stays under Google's documented 1800-character safe JWT length for a worst-case event", () => {
    const jwt = saveUrl(WORST_CASE, CFG).slice(SAVE_PREFIX.length);
    expect(jwt.length).toBeLessThan(1800);
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
```

The new test from Step 1 keeps calling `buildSaveUrl` directly — asserting `null` is the whole point of it.

- [ ] **Step 6: Map null to 503 on both call sites**

In `apps/backend/src/lib/wallet/apple.ts`, between the `signManifest` call and the `buildZip` call:

```ts
  const signature = await signManifest(manifestBuf, {
    cert: env.applePassCert,
    key: env.applePassKey,
    wwdr: env.appleWwdrCert,
  });
  if (!signature) {
    return {
      ok: false,
      status: 503,
      message:
        "Apple Wallet is misconfigured — APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM or APPLE_WWDR_CERT_PEM could not be parsed. Store each PEM on one line with literal \\n escapes and make sure the key is unencrypted. See docs/apple-wallet-certs.md.",
    };
  }
```

In `apps/backend/src/lib/wallet/google.ts`, replace the final `return`. `BAD_KEY` is the module constant Task 3 introduced at the top of the file, so the message is identical whichever signing step failed:

```ts
  const url = buildSaveUrl(row, cfg);
  if (!url) return { ok: false, status: 503, message: BAD_KEY };
  return { ok: true, url };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:

```bash
pnpm -r typecheck && cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet
```

Expected: typecheck PASS; 11 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/lib/wallet/pass-bundle.ts apps/backend/src/lib/wallet/pass-bundle.test.ts \
        apps/backend/src/lib/wallet/google-pass.ts apps/backend/src/lib/wallet/google-pass.test.ts \
        apps/backend/src/lib/wallet/apple.ts apps/backend/src/lib/wallet/google.ts
git commit -m "Turn unparseable wallet certificates into an actionable 503 instead of a 500"
```

---

### Task 5: Tell the browser which wallets are actually configured

The Apple button is a button that always errors: ScottyLabs has no Apple Developer Program membership, so there are no certificates to sign with. It should render disabled and say so.

**The flag is env-presence only, and the Google button therefore stays enabled whenever its flag is true.** `wallet.google === true` means three environment strings are non-empty — it does not mean the issuer is real, the service account was invited, or the account has left demo mode. Two of those three failures happen entirely on Google's side after the redirect. The inline `walletNote` box remains the real feedback channel; never use the flag to hide or shortcut the error path.

This is a contract change, so it lands in **one commit** across three packages. There are exactly three compile sites: `meFor`'s signed-out early return, and the two places the web app constructs a `Me` literal. `meFor` is the only producer, and it feeds **two** endpoints — `GET /api/auth/me` and the 200 body of `POST /api/auth/verify`.

**Files:**
- Modify: `packages/contract/src/index.ts:84-100` (the `Me` schema object; the `export type Me` on line 101 is inferred and needs no edit)
- Modify: `apps/backend/src/auth/service.ts:294-317`
- Modify: `apps/web/src/lib/auth.tsx:13,30`
- Modify: `apps/web/src/pages/TicketsPage.tsx:14, 138-151` (line 14 is `function PassCard({ ticket }: { ticket: TicketView }) {`; 138-151 is the button `<div>`. The footnote at 157-159 belongs to Task 6.)
- Test: none — this is a type-level change plus JSX, and `apps/web` has no test runner. Verification is `pnpm -r typecheck` plus the manual QA in Step 6.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Me.wallet: { apple: boolean; google: boolean }` on the shared contract type.

---

- [ ] **Step 1: Extend the Me schema**

In `packages/contract/src/index.ts`, the `Me` schema after the edit:

```ts
export const Me = z.object({
  user: z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      andrewId: z.string().nullable(),
      initials: z.string(),
    })
    .nullable(),
  admin: z
    .object({
      role: z.enum(["admin", "super_admin"]),
      committee: Committee,
    })
    .nullable(),
  /**
   * Which wallet integrations have credentials configured. Env-presence only —
   * a true here does not mean the vendor will accept the pass, so the UI must
   * keep surfacing runtime errors.
   */
  wallet: z.object({ apple: z.boolean(), google: z.boolean() }),
});
export type Me = z.infer<typeof Me>;
```

- [ ] **Step 2: Run the typecheck to see the exact blast radius**

Run:

```bash
pnpm -r typecheck
```

Expected: FAIL in exactly three places — `apps/backend/src/auth/service.ts` (surfacing at the `me` handler in `routes/router.ts` as a union mismatch, because the signed-out early return at `service.ts:295` is missing the field), and `apps/web/src/lib/auth.tsx` lines 13 and 30. If anything else fails, stop and re-read the failure before editing.

- [ ] **Step 3: Populate the flags server-side**

In `apps/backend/src/auth/service.ts`, add a module-level constant above `meFor` (`env` is already imported at line 3) and put it on **both** return branches. These two predicates must mirror the env gates in `apps/backend/src/lib/wallet/apple.ts` and `google.ts` exactly:

```ts
/**
 * Env-presence only, mirroring the gates in lib/wallet/apple.ts and
 * lib/wallet/google.ts. True does NOT mean the vendor will accept a pass:
 * an uninvited service account or a demo-mode issuer both fail later, at
 * Google. Two booleans are disclosed to anonymous callers of GET
 * /api/auth/me — deliberate, and negligible.
 */
const WALLET = {
  apple: Boolean(env.applePassCert && env.applePassKey && env.appleWwdrCert && env.appleTeamId),
  google: Boolean(env.googleWalletIssuerId && env.googleWalletSaEmail && env.googleWalletSaKey),
};

export function meFor(ctx: AuthContext | null) {
  if (!ctx) return { user: null, admin: null, wallet: WALLET };
  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      andrewId: ctx.user.andrewId,
      initials: initialsOf(ctx.user.name || ctx.user.email),
    },
    admin: ctx.admin
      ? {
          role: ctx.admin.row.role,
          committee: {
            id: ctx.admin.committee.id,
            slug: ctx.admin.committee.slug,
            name: ctx.admin.committee.name,
            color: ctx.admin.committee.color,
            isAllClub: ctx.admin.committee.isAllClub,
          },
        }
      : null,
    wallet: WALLET,
  };
}
```

- [ ] **Step 4: Fix the two web Me literals**

In `apps/web/src/lib/auth.tsx`. Defaulting both to `false` is the safe direction — before `/api/auth/me` resolves the buttons read as unavailable rather than flashing enabled and then failing:

```tsx
const AuthContext = createContext<AuthState>({
  me: { user: null, admin: null, wallet: { apple: false, google: false } },
  loading: true,
  refresh: async () => {},
});
```

and:

```tsx
        me: query.data ?? { user: null, admin: null, wallet: { apple: false, google: false } },
```

- [ ] **Step 5: Render an honest Apple button**

In `apps/web/src/pages/TicketsPage.tsx`, `PassCard` does not currently call `useAuth()` — only the page component at line 235 does. Add it as the first line of the component body (`useAuth` is already imported at line 6):

```tsx
function PassCard({ ticket }: { ticket: TicketView }) {
  const { me } = useAuth();
  const dark = ticket.event.passStyle !== "light";
```

Then replace the button block (currently lines 138-151). Keep `background: "#000"` on the disabled Apple button so it stays recognisably the Apple button rather than turning grey — `.pill:disabled` in `apps/web/src/styles/global.css:175-178` already supplies `opacity: 0.55; cursor: default`. Disabled buttons do not fire mouse handlers, so those are dropped on that branch. After the edit:

```tsx
          <div style={{ display: "flex", gap: 10 }}>
            {me.wallet.apple ? (
              <button className="pill" style={{ flex: 1, background: "#000", color: "#fff", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }} onClick={() => void addToApple()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#383838")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#000")}>
                <WalletIcon size={15} />
                Add to Apple Wallet
              </button>
            ) : (
              <button className="pill" disabled title="Apple Wallet passes need a paid Apple Developer account — not set up yet." style={{ flex: 1, background: "#000", color: "#fff", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }}>
                <WalletIcon size={15} />
                Apple Wallet — coming soon
              </button>
            )}
            {me.wallet.google ? (
              <button className="pill" style={{ flex: 1, background: "#1f1f1f", color: "#fff", border: "1px solid #1f1f1f", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }} onClick={() => void saveToGoogle()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#383838")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#1f1f1f")}>
                <WalletIcon size={15} />
                Save to Google Wallet
              </button>
            ) : (
              <button className="pill" disabled title="Google Wallet passes aren't configured on this deployment yet." style={{ flex: 1, background: "#1f1f1f", color: "#fff", border: "1px solid #1f1f1f", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }}>
                <WalletIcon size={15} />
                Google Wallet — coming soon
              </button>
            )}
          </div>
```

Leave the `walletNote` block and the footnote below it exactly as they are — Task 6 handles the footnote.

- [ ] **Step 6: Typecheck and QA manually**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS in all three packages.

Then, since `apps/web` has no test runner, verify by hand. With Postgres running, start the app with `pnpm dev` and sign in as a user who holds at least one approved ticket, then check `/tickets`:

1. With **no** wallet env vars set (the default in this worktree — there is no `.env` here), both buttons render greyed at 55% opacity, read "Apple Wallet — coming soon" and "Google Wallet — coming soon", and clicking them does nothing.

2. Add three dummy Google values to `.env` and restart the backend:

   ```
   GOOGLE_WALLET_ISSUER_ID=1
   GOOGLE_WALLET_SA_EMAIL=x@y.iam.gserviceaccount.com
   GOOGLE_WALLET_SA_KEY_PEM=garbage
   ```

   The Google button is now enabled; clicking it shows the yellow note reading "Google Wallet is misconfigured — GOOGLE_WALLET_SA_KEY_PEM isn't a usable RSA private key…", **not** "Something went wrong on our end." That check confirms Tasks 3 and 5 together. It does **not** reach Task 4's `buildSaveUrl` null branch — with a garbage key the throw happens first, inside `accessToken`, and is caught by Task 3's `try`/`catch` in `google.ts`.

3. Now do the Apple half, which is the only runnable check of Task 4's Apple path end to end. Replace the Google values with four dummy Apple ones and restart the backend:

   ```
   APPLE_PASS_CERT_PEM=garbage
   APPLE_PASS_KEY_PEM=garbage
   APPLE_WWDR_CERT_PEM=garbage
   APPLE_TEAM_ID=ABCDE12345
   ```

   All four are non-empty, so `me.wallet.apple` is true and the Apple button renders **enabled**. Click it. The yellow note must read "Apple Wallet is misconfigured — APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM or APPLE_WWDR_CERT_PEM could not be parsed…" and **not** "Something went wrong on our end." The backend log carries forge's own error under `[wallet] apple pkpass signing failed`.

4. Remove all dummy values again and restart; both buttons return to "coming soon".

- [ ] **Step 7: Commit**

```bash
git add packages/contract/src/index.ts apps/backend/src/auth/service.ts \
        apps/web/src/lib/auth.tsx apps/web/src/pages/TicketsPage.tsx
git commit -m "Carry configured-wallet flags on Me and stop offering buttons that cannot work"
```

---

### Task 6: Stop the copy claiming wallet passes work

Three places assert wallet passes work today. The ticket email is the loudest: it fires on every approval, every waitlist promotion and every +1 claim.

**Files:**
- Modify: `apps/backend/src/lib/emails.ts:119`
- Modify: `README.md:74-77`
- Modify: `apps/web/src/pages/TicketsPage.tsx:157-159`
- Test: none — copy only. Verified by grep and by `pnpm -r typecheck`.

**Interfaces:**
- Consumes: `Me.wallet` from Task 5 (for the conditional footnote), already in scope via the `const { me } = useAuth()` that Task 5 added to `PassCard`.
- Produces: nothing.

---

- [ ] **Step 1: Fix the ticket email**

`apps/backend/src/lib/emails.ts:119` currently reads:

```ts
${p(`Show the QR under <b>My tickets</b> at the door — or add it to your wallet. Your pass serial is ${mono(opts.serial)}.`)}
```

Drop the wallet promise; the QR is the thing that actually works. After the edit:

```ts
${p(`Show the QR under <b>My tickets</b> at the door. Your pass serial is ${mono(opts.serial)}.`)}
```

The plain-text branch of the same function does not mention the wallet and needs no change.

- [ ] **Step 2: Fix the README**

`README.md:74-77`. After the edit:

```markdown
- **Wallet passes**: `GET /api/tickets/:id/google-wallet` builds the Save-to-Google-Wallet link
  (the `EventTicketClass` is created over the Wallet REST API and the JWT carries only the ticket
  object, staying inside Google's 1800-character safe length) — it activates once the
  `GOOGLE_WALLET_*` env vars are set; see [docs/google-wallet-setup.md](docs/google-wallet-setup.md).
  `GET /api/tickets/:id/apple.pkpass` builds a signed PKCS#7 `.pkpass`, but signing needs an Apple
  Developer Program membership ScottyLabs does not hold, so the Apple button renders as "coming
  soon"; the certificate steps are written up in
  [docs/apple-wallet-certs.md](docs/apple-wallet-certs.md). Both endpoints return a 503 the UI
  surfaces inline when they are unconfigured or misconfigured.
```

- [ ] **Step 3: Fix the tickets-page footnote**

`apps/web/src/pages/TicketsPage.tsx:157-159` currently reads "Issued as real passes — PKPass and Google Wallet objects." That is false the moment the Apple button is honestly disabled. Make it follow the flags — after the edit:

```tsx
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--muted-3)", textAlign: "center" }}>
            {me.wallet.apple && me.wallet.google
              ? "Add it to Apple Wallet or Google Wallet — or just show the QR."
              : me.wallet.google
                ? "Save it to Google Wallet — Apple Wallet is coming soon."
                : me.wallet.apple
                  ? "Save it to Apple Wallet — Google Wallet is coming soon."
                  : "Your QR is the ticket — wallet passes are coming soon."}
          </div>
```

- [ ] **Step 4: Verify nothing else still claims it works**

Run:

```bash
grep -rn "add it to your wallet\|fully implemented\|Issued as real passes" \
  README.md apps/backend/src apps/web/src packages/contract/src
```

Expected: no output. (Before this task the same command returns exactly three hits — one per site above. If anything else matches, fix it in this task.)

- [ ] **Step 5: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/lib/emails.ts README.md apps/web/src/pages/TicketsPage.tsx
git commit -m "Stop promising wallet passes the product cannot yet deliver"
```

---

### Task 7: The credential runbooks

Neither wallet works without a human doing console work no code can do. Both runbooks are written as steps a person runs, with the exact commands.

Every vendor-sourced instruction below was checked against live documentation while writing this plan; see the vendor-claims table at the top. The claims that could not be confirmed are marked **in the runbooks themselves** — do not silently upgrade them to fact.

**Files:**
- Create: `docs/google-wallet-setup.md`
- Create: `docs/apple-wallet-certs.md`
- Modify: `.env.example:24-34`
- Test: none — documentation. Verified by the link check in Step 4.

**Interfaces:**
- Consumes: the env var names `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_EMAIL`, `GOOGLE_WALLET_SA_KEY_PEM`, `APPLE_PASS_CERT_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_WWDR_CERT_PEM`, `APPLE_TEAM_ID`, `APPLE_PASS_TYPE_ID` as read in `apps/backend/src/env.ts:69-79`, and the 503 messages written in Tasks 3 and 4, which point at these two files by name.
- Produces: nothing consumed by code.

---

- [ ] **Step 1: Write the Google runbook**

Create `docs/google-wallet-setup.md`:

````markdown
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

```bash
openssl pkey -in <(printf '%b' "$GOOGLE_WALLET_SA_KEY_PEM") -noout -text | head -1
```

Expect `RSA Private-Key: (2048 bit, 2 primes)` or similar — not `EC`.

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
- Every outbound call to Google is capped at 5 seconds (`AbortSignal.timeout`). A slow Google
  produces the "didn't respond in time" note rather than a hung request.
- It does **not** pre-create the `EventTicketObject`; the object rides in the save JWT, which
  measures ~1350 characters worst case against Google's documented 1800-character safe length
  (<https://developers.google.com/wallet/tickets/events/web>).
- It does **not** update or expire passes after they are saved.
````

- [ ] **Step 2: Write the Apple runbook**

Create `docs/apple-wallet-certs.md`:

````markdown
# Apple Wallet certificates

The `.pkpass` bundle is built and correct. It cannot be **signed** without a Pass Type ID
certificate, which requires a paid Apple Developer Program membership ScottyLabs does not currently
hold. Until then `/tickets` shows "Apple Wallet — coming soon" and the endpoint returns a 503.

This is what to do the day the account exists.

A note on sourcing: Apple's current documentation site is JavaScript-rendered and could not be
fetched while this was written, so a few statements below are marked **unconfirmed**. They are
consistent with how pass signing works and with third-party tooling, but no Apple page was readable
to back them. Where a claim is unconfirmed, the runbook gives you a command that measures the real
answer instead.

## 1. Get the membership

The Apple Developer Program is **$99/year**. An **Organization** membership requires a D-U-N-S
number registered to the legal entity, and apps/passes are listed under that legal entity's name —
so a student org typically enrolls through the university or, failing that, uses an Individual
membership. Nonprofits, educational institutions and government entities may qualify for a fee
waiver: <https://developer.apple.com/support/membership-fee-waiver/>.
Reference: <https://developer.apple.com/support/compare-memberships/>

## 2. Register the Pass Type ID

developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → **+** →
**Pass Type IDs** → register `pass.org.scottylabs.invite`.

That string must match `APPLE_PASS_TYPE_ID` (defaulted in `apps/backend/src/env.ts:73`). If you
register a different identifier, set the env var to match.

**Unconfirmed:** it is widely reported that `pass.json`'s `passTypeIdentifier` must equal the
certificate's UID exactly, and that a mismatch shows on-device as a generic "invalid data" error
with no further detail. We could not read an Apple page saying so. Match them anyway — there is no
reason to differ — and if you do hit "invalid data", step 9 tells you how to compare the two values
directly.

## 3. Create the CSR — use the CLI path

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout pass-key.pem -out pass.csr \
  -subj "/CN=ScottyLabs Pass/emailAddress=you@andrew.cmu.edu/C=US"
```

`-nodes` is mandatory: **node-forge cannot decrypt an encrypted private key**, so an encrypted
`APPLE_PASS_KEY_PEM` makes every pass request fail. This path hands you an unencrypted PEM key
directly and skips the `.p12` dance entirely.

(The Keychain Access alternative — Certificate Assistant → Request a Certificate From a Certificate
Authority → Saved to disk + Let me specify key pair information, RSA 2048 — works, but then you must
do step 5b.)

## 4. Get the pass certificate

1. Upload `pass.csr` to the Pass Type ID in the developer portal and download `pass.cer`.
2. Convert it: `openssl x509 -inform DER -in pass.cer -out pass-cert.pem`

## 5b. Only if you used Keychain Access

Install `pass.cer`, export the certificate **and its private key** together as `Certificates.p12`,
then:

```bash
openssl pkcs12 -in Certificates.p12 -clcerts -nokeys -out pass-cert.pem
openssl pkcs12 -in Certificates.p12 -nocerts -nodes -out pass-key.pem
```

`-nodes` on the second command is mandatory (see step 3). Add `-legacy` **only** if you are using
Homebrew OpenSSL 3.x; the macOS system `openssl` is LibreSSL, which reads Keychain-exported `.p12`
files natively and **rejects** `-legacy`. Check with `openssl version` before copying either form.

## 6. Get the matching WWDR intermediate

Apple currently publishes several Worldwide Developer Relations intermediates at
<https://www.apple.com/certificateauthority/> — G2, G3, G4, G5, G6 and WWDR MP CA 1 - G1. **That page
does not say which generation signs Pass Type ID certificates, and this was not verifiable at the
time of writing.** Do not guess. Read the issuer off your own certificate and download the
generation that matches:

```bash
openssl x509 -in pass-cert.pem -noout -issuer
```

Download the matching `.cer` from the CA page, convert it, and confirm the subject matches the
issuer above:

```bash
openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem   # substitute your generation
openssl x509 -in wwdr.pem -noout -subject
```

The two strings must name the same generation. If they do not, you downloaded the wrong one and
every pass will fail to verify.

## 7. Read the team ID

```bash
openssl x509 -in pass-cert.pem -noout -subject
```

The `OU` field is the team ID. Set `APPLE_TEAM_ID` to it. It must equal `pass.json`'s
`teamIdentifier` or iOS rejects the pass.

## 8. Flatten the PEMs and set the environment

`.env` is parsed line-by-line, so every PEM must be **one line with literal `\n` escapes**:

```bash
python3 -c "print(open('pass-cert.pem').read().replace(chr(10), chr(92)+'n'))"
python3 -c "print(open('pass-key.pem').read().replace(chr(10), chr(92)+'n'))"
python3 -c "print(open('wwdr.pem').read().replace(chr(10), chr(92)+'n'))"
```

Set `APPLE_PASS_CERT_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_WWDR_CERT_PEM` and `APPLE_TEAM_ID` (plus
`APPLE_PASS_TYPE_ID` if you did not use the default) locally and in Railway.

## 9. Verify

```bash
curl -sS -b "session=<your cookie>" \
  https://invite.scottylabs.org/api/tickets/<ticket-id>/apple.pkpass -o test.pkpass
unzip -l test.pkpass
```

Expect nine entries: `pass.json`, `icon.png`, `icon@2x.png`, `icon@3x.png`, `logo.png`,
`logo@2x.png`, `logo@3x.png`, `manifest.json`, `signature`.

```bash
mkdir t && cd t && unzip ../test.pkpass
openssl smime -verify -in signature -inform DER -content manifest.json -noverify
```

Expect "Verification successful" and the manifest echoed back.

Then AirDrop or email `test.pkpass` to an iPhone and tap it. If you get a generic "invalid data"
error, compare the two identity fields against the certificate before looking anywhere else:

```bash
python3 -c "import json;d=json.load(open('pass.json'));print(d['passTypeIdentifier'], d['teamIdentifier'])"
openssl x509 -in ../pass-cert.pem -noout -subject     # UID = pass type id, OU = team id
```

If the endpoint returns 503 with *"Apple Wallet is misconfigured — … could not be parsed"*, one of
the three PEMs is malformed or the key is encrypted; the backend log carries the parser's own error
under `[wallet] apple pkpass signing failed`.

## 10. Renewal

Pass Type ID certificates are short-lived; **one year is the commonly cited term, but we could not
confirm it against an Apple page** — so read the real date off your own certificate rather than
assuming:

```bash
openssl x509 -in pass-cert.pem -noout -enddate
```

Put a calendar reminder one month before whatever that prints. When the certificate expires, newly
generated passes stop installing while already-installed passes keep working — a silent failure
nobody reports.

## Note on the icon

This bundle ships `icon.png` at 29 × 29 points with @2x and @3x variants, and a logo bounded by the
160 × 50 point maximum. Apple's archived Wallet Developer Guide lists all pass images as optional
per pass style, while third-party pass tooling and Apple's PKPass API documentation describe the
icon as required. **We could not confirm a current, unambiguous Apple statement that a pass without
`icon.png` fails to install.** It is the most likely explanation for a pass that will not install,
and shipping it costs 66 KB, so it ships.

## Out of scope

Pass updates. `webServiceURL` and `authenticationToken` were removed because the `/api/passes` web
service they advertised was never built. Adding push updates later means building that service plus
an APNs credential.
````

- [ ] **Step 3: Annotate .env.example**

Replace `.env.example:24-34` — after the edit:

```
# Apple Wallet (optional — passes activate when all four are set)
# Runbook: docs/apple-wallet-certs.md. Each PEM must be ONE line with literal \n
# escapes; a real newline breaks the .env parser. The key must be UNENCRYPTED.
# APPLE_PASS_CERT_PEM=""     # pass.cer -> PEM (openssl x509 -inform DER)
# APPLE_PASS_KEY_PEM=""      # the private key from the CSR, -nodes / unencrypted
# APPLE_WWDR_CERT_PEM=""     # the Apple WWDR intermediate that ISSUED the cert above
# APPLE_TEAM_ID=""           # the OU field of the pass certificate's subject
# APPLE_PASS_TYPE_ID="pass.org.scottylabs.invite"   # must match the registered Pass Type ID

# Google Wallet (optional — runbook: docs/google-wallet-setup.md)
# The service account ALSO has to be invited as a Developer under Users in the
# Google Pay & Wallet Console — enabling the Cloud API is not enough.
# GOOGLE_WALLET_ISSUER_ID=""    # 16-19 digits, from the Wallet API dashboard
# GOOGLE_WALLET_SA_EMAIL=""     # `client_email` from the service-account JSON
# GOOGLE_WALLET_SA_KEY_PEM=""   # `private_key` from that JSON — RSA, the PEM block only, \n escapes intact
```

- [ ] **Step 4: Verify every referenced doc path exists**

The 503 messages written in Tasks 3 and 4 name these files. Confirm nothing points at a file that
does not exist:

```bash
grep -rhno "docs/[a-z0-9./-]*\.md" README.md .env.example apps/backend/src apps/web/src \
  | sed 's/.*\(docs\/[a-z0-9./-]*\.md\)/\1/' | sort -u | while read -r f; do
      test -f "$f" && echo "OK   $f" || echo "MISSING $f"
    done
```

Expected: `OK docs/apple-wallet-certs.md` and `OK docs/google-wallet-setup.md`, no `MISSING` lines.

- [ ] **Step 5: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS. (Nothing in this task touches TypeScript, but the plan's done-criteria include it on every task.)

- [ ] **Step 6: Commit**

```bash
git add docs/google-wallet-setup.md docs/apple-wallet-certs.md .env.example
git commit -m "Write the Google issuer and Apple certificate runbooks"
```

---

## Done criteria

- [ ] `pnpm -r typecheck` passes across all three packages.
- [ ] `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/wallet` passes — 11 tests, no Postgres.
- [ ] `apps/backend/src/lib/wallet/zip.ts` is byte-for-byte unchanged.
- [ ] `Dockerfile` and `apps/backend/tsconfig.json` are unchanged.
- [ ] The production guard at `apps/backend/src/env.ts:85-88` is unchanged; only the three comment lines above it, at 82-84, were rewritten.
- [ ] `grep -rn "add it to your wallet\|fully implemented\|Issued as real passes" README.md apps/backend/src apps/web/src packages/contract/src` returns nothing.
- [ ] `grep -n "passStyle" apps/backend/src/lib/wallet/pass-bundle.ts apps/backend/src/lib/wallet/google-pass.ts` shows the same `!== "light"` predicate in both.
- [ ] `grep -c "AbortSignal.timeout" apps/backend/src/lib/wallet/google-api.ts` returns 3 — every outbound Google call is bounded.
- [ ] With no wallet env vars set, `/tickets` shows two disabled "coming soon" buttons and clicking them does nothing.
- [ ] With a deliberately garbage `GOOGLE_WALLET_SA_KEY_PEM`, clicking Save to Google Wallet shows the misconfiguration message in the yellow note — not "Something went wrong on our end."
- [ ] With deliberately garbage `APPLE_PASS_CERT_PEM` / `APPLE_PASS_KEY_PEM` / `APPLE_WWDR_CERT_PEM` and `APPLE_TEAM_ID=ABCDE12345`, the Apple button is enabled and clicking it shows "Apple Wallet is misconfigured — … could not be parsed" in the yellow note — not "Something went wrong on our end."

## Out of scope

- Apple pass push updates — the `/api/passes` web service and its APNs credential. The pass no longer advertises them.
- Pre-creating the `EventTicketObject` over REST. **This is the plan's one deliberate deviation from the spec**, which estimates the skinny JWT at "~800 characters" — a figure only reachable by pre-creating the object too and shipping a bare id. Keeping the object in the JWT is still object-only in the sense the spec means (the *class* moves to REST), and it measures 1350 characters against Google's 1800-character safe length: 450 characters of headroom, one fewer network call per click, and no orphaned objects for passes nobody saves. Only the character estimate differs.
- Adding a logo or hero image to the Google pass class. Optional for the API; possibly needed for the publishing review, and noted as such (and as unverified) in the runbook.
- Registering `@fastify/rate-limit`. It is a dependency that is registered nowhere, which is why Task 3 bounds every outbound call with `AbortSignal.timeout` and caches class upserts per process instead. Actually throttling the wallet routes is a separate, repo-wide change.
- Unit-testing `google-api.ts`. Every function in it is a network call and there is no HTTP mocking library in `apps/backend/package.json`; its failure modes are verified by hand in Task 5 Step 6 and `docs/google-wallet-setup.md` §7.
- Localising either pass. Both hardcode `en-US`.
- Anything from the spec's signup-questions half.

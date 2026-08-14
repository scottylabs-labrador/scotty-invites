# Signup questions that actually work, and wallet passes that actually install

**Date:** 2026-08-13
**Branch:** `claude/additional-questions-wallet-bugs-81cabf`

## Problem

Two reported problems.

1. **The additional-questions feature is largely decorative.** The organizer can pick a
   question type of "Select", but there is nowhere to enter the options, so the guest gets a
   plain text box. Several other controls on that screen are in the same state — visible,
   clickable, and connected to nothing.
2. **Wallet passes don't work.** The QR pass renders on `/tickets`, but Add-to-wallet reports
   a permissions error.

The first turned out to be one root cause with six symptoms. The second is two unrelated
causes — missing credentials on the Google side, and a malformed bundle on the Apple side.

## Confirmed defects

All confirmed by reading the code on `claude/additional-questions-wallet-bugs-81cabf`
(`0aad349`).

| # | Defect | Where |
| --- | --- | --- |
| 1 | `DraftQuestion` has no `options`, so a "Select" question is published with `options: null` and renders as a text input | `EventForm.tsx:19`, `CreateEventPage.tsx:65`, `EventPage.tsx:435` |
| 2 | A "File" question has no file branch in the guest renderer — it also renders as a text input | `EventPage.tsx:442` |
| 3 | The "Phone number" and "T-shirt size" capture toggles create visible questions the guest form never renders, so they collect nothing and export permanently blank columns | `router.ts:1158`, `EventPage.tsx:122`, `server.ts:267` |
| 4 | `required` exists in the DB and the API type but has no builder control and no enforcement on either side; blank answers are silently dropped | `schema.ts:145`, `EventPage.tsx:136`, `router.ts:456` |
| 5 | The drag handle on each question row is a decorative SVG — questions cannot be reordered | `EventForm.tsx:370` |
| 6 | Questions freeze at publish: `UpdateEventBody` omits `hostQuestions` and the edit screen is read-only, so a typo in a question is permanent | `contract/index.ts:459`, `EventForm.tsx:328` |
| 7 | The organizer pending queue shows only the *first* custom answer, and no screen shows the rest — CSV is the only complete surface | `router.ts:814`, `OrganizePage.tsx:400` |
| 8 | The `.pkpass` bundle contains no `icon.png`; iOS refuses to install a pass without one, so Apple Wallet would fail even after certificates are configured | `apple.ts:71` |
| 9 | The pass advertises `webServiceURL` + `authenticationToken` for `/api/passes`, which was never implemented | `apple.ts:49` |
| 10 | A committee admin can only read files through `registrations.resume_file_id`, so a file uploaded to a custom question would 403 for the organizer who asked for it | `server.ts:214` |

Defect 10 does not bite today only because file questions don't work at all (defect 2).
Fixing 2 without 10 would ship a data black hole.

## Root cause

`EventPage` renders the signup form from two hardcoded lists: four named standard fields
(`showMajorYear` / `showDietary` / `showResume` / `showSource`), and then a loop over
questions where `kind === "custom"`. The database has a single ordered question list with a
`visible` flag, and the backend already accepts answers for `phone` and `tshirt` alongside
custom questions (`router.ts:455`). The frontend is the only layer that believes questions
come in two flavours.

Every one of defects 1–4 disappears when the guest form renders the list the API already
sends.

## Design

### One renderer

`EventPage` renders a single loop over `detail.questions` in `sort` order.

- `major_year`, `dietary`, `resume`, `source` keep their bespoke widgets. These four write to
  columns on `registrations`, not to the `answers` table, and their UI (two dropdowns, chips,
  an uploader) is not expressible as a generic type.
- Everything else — `phone`, `tshirt`, and every custom question — goes through one generic
  renderer keyed on `type`: `short` → input, `long` → textarea, `select` → dropdown built
  from `options`, `file` → uploader. All of these submit through `RegisterBody.custom`, which
  the backend already validates for exactly this set.

Standard questions carry `sort` 0–5 and custom questions follow. This is *not* order-preserving
for existing events: today "How did you hear about this?" renders *after* the host questions
(`EventPage.tsx:448`), and sorted order moves it above them. That reordering is accepted — the
sorted order is the one the organizer sees in the builder, and the two must agree.

### The builder gains the controls it implies

`DraftQuestion` becomes `{ id, text, type, options: string[], required: boolean }`. A row
whose type is `select` expands to an inline options editor — add, remove, edit, reorder is
not needed for options. `validateEventForm` refuses to publish a select question with no
non-empty option, which is the check that makes defect 1 unrepeatable.

Each row gets a Required toggle using the existing `Switch` component. The existing drag
handle becomes a real HTML5 drag source, and up/down buttons sit beside it so reordering
works without a mouse.

### Editing after publish, without destroying answers

New endpoint `PUT /api/org/events/:id/questions`, taking the full desired list. The server
reconciles against what exists:

| Change | Question has answers | Question has no answers |
| --- | --- | --- |
| Label, order, `required`, `visible` | allowed | allowed |
| `type`, `options` | rejected — 409 `locked`, newly declared on this route | allowed |
| Delete | becomes hide — `visible = false` | real delete |
| Add new question | allowed | allowed |

Questions with `kind === "standard"` accept only a `visible` change; their label, type and
options are ours, not the organizer's. This has the useful side effect of making the "Data to
capture" toggles editable after publish, which they are not today.

Hidden questions keep their answers, and keep their CSV column, so hiding is never lossy.

The organizer screen needs three fields the public one must never carry — `visible`, `sort`,
and an answer count for the lock badges. Widening the shared `EventQuestion` would leak them
into the public `EventDetail`, so the org payload gets its own `OrgEventQuestion` extension,
following the precedent already set by the server-computed `deletable` flag.

### Two privacy gates that hiding must actually close

Making `visible` editable exposes two latent holes, and shipping the toggle without closing
them would be a privacy misrepresentation — a switch labelled "hide" that keeps collecting.

1. The register handler decides which answers to keep from the question's `visible` flag alone
   (`router.ts:447-455`), never consulting the super admin's global controls the public page
   applies (`router.ts:368`). An organizer could re-enable collection of a field the super
   admin globally disabled. The PUT refuses `visible: true` for a standard key whose global
   control is off, and the register handler adopts the public page's predicate.
2. The four bespoke values are gated on the global controls only (`router.ts:483-487`), never
   on the event's own question rows. Hiding "Resume upload" would stop the field rendering
   while the server kept storing `resume_file_id`. Those four are gated on the event's rows
   too.

### Server-side validation

The register handler currently drops anything it doesn't recognise. It gains three
rejections, all of which must run **before** the existing destructive delete of a prior
cancelled registration (`router.ts:469` documents that ordering constraint):

- a `required`, visible, answerable question with an empty value → 400 naming the question
- a `select` answer whose value is not in that question's `options` → 400
- a `file` answer whose value is not a file UUID owned by the submitter → 400, mirroring the
  existing `resumeFileId` ownership check at `router.ts:462`

### File answers

A file question stores the file's UUID as its answer value, lower-cased so the organizer's
download link matches the strict lower-case UUID pattern `GET /api/files/:id` enforces.
`POST /api/files` gains an optional `kind` field so an answer upload is distinguishable from a
resume; its accepted MIME types stay PDF/Word, and the builder says so, rather than widening
uploads in a change nobody asked for.

`GET /api/files/:id` extends its committee-admin branch: a file is also readable when its
UUID appears as an answer to a question belonging to an event of that admin's committee. The
owner and super-admin branches are unchanged.

CSV renders a file answer as a download URL, matching how the Resume column already works.

### Organizer visibility

The dashboard payload carries every answer per registration instead of the first custom one.
The pending queue lists them all; guest rows expand to show them. This follows the existing
unbounded guest-list pattern rather than introducing pagination — noted as a known tradeoff,
not an improvement.

### Wallet

**Google — credentials *and* a code fix.** The reported permissions error is Google's, and
comes from one of two console omissions: the service account has not been granted access to the
Issuer account in the Wallet Console's Users tab, or the issuer is still in demo mode, where
only allowlisted test accounts may save a pass. Both are documented as a runbook.

But credentials alone are not enough. The current implementation embeds the whole
`EventTicketClass` and `EventTicketObject` in the JWT ("fat" JWT), and the resulting save URL
measures ~1,980–2,170 characters against Google's ~1,800-character guidance — over the limit
for *every* event, not just long ones. So the pass moves to the shape Google prescribes: the
`EventTicketClass` is created once per event through the Wallet REST API, and the save link
carries a skinny object-only JWT (~800 characters). That needs a service-account access token,
obtained with the JWT-bearer grant the codebase can already sign.

The signing call is also wrapped so a malformed PEM returns an actionable 503 instead of a 500
— and the identical defect on the Apple path is fixed at the same time.

**Apple — code now, certificates later.** ScottyLabs has no Apple Developer Program
membership, so passes cannot be signed yet. The bundle is fixed now so that the day the
certificates land, it works: `icon.png` (with `@2x`) and `logo.png` are added to the bundle
and the manifest, and `webServiceURL` + `authenticationToken` are removed because
`/api/passes` does not exist. A test asserts the bundle's contents. The certificate runbook
is written down for later.

**Honest UI.** The `Me` contract — served by `GET /api/auth/me` *and* returned by
`POST /api/auth/verify` — carries `wallet: { apple: boolean, google: boolean }`. The Apple
button renders disabled with "coming soon" when unconfigured, instead of being a button that
errors when pressed. The flag is env-presence only: a Google issuer that hasn't invited the
service account still fails at Google, so the inline error note stays the real feedback channel
and the Google button stays enabled whenever the flag is true.

Three places currently assert that wallet passes work and must stop: the ticket email
(`emails.ts:129`), the README's wallet section, and the tickets page.

### One shared value normalizer

`answers.value` is `jsonb`, and Drizzle's mapper `JSON.parse`s a string that `pg-types` has
already parsed. A stored `"4125551234"` therefore comes back as the *number* `4125551234`, a
stored `"null"` as `null`, and `String(value ?? "")` renders that last one as an empty cell.
Phone — the field this change makes collectable for the first time — is exactly the case that
stops being a string. One `answerText(value)` helper is shared by the dashboard, the CSV export
and MCP so the three surfaces cannot disagree.

## Out of scope

- New question types (checkbox, multi-select, number, date, URL)
- Apple pass push updates — the `/api/passes` web service and its APNs credential
- Multiple files per answer
- Guest-list pagination
- **Questions for claimed +1 guests.** `claimTransfer` issues a ticket with no registration
  (`registrations.ts:405`), so a +1 guest is never asked a question, never appears in the guest
  table, and is absent from the CSV. Marking a question required will therefore still yield
  nothing for +1s. This is pre-existing and stays pre-existing; it is recorded here so nobody
  reads "required" as a guarantee.
- **Backfilling existing events.** `visible` is frozen at create (`router.ts:1169`), so every
  event that exists today has `phone`/`tshirt` rows hidden. They are not switched on by a
  migration — organizers turn them on per event through the new PUT.

## Decisions taken

- Question builder stays at the four advertised types; the fix is to make them real, not to
  add more.
- Editing after publish is allowed with answer-safe rules rather than either frozen (status
  quo) or unrestricted (silent data loss).
- Phone and T-shirt are rendered rather than removed — the backend, CSV and storage already
  support them.
- Google Wallet ships first; Apple is unblocked in code and gated on the developer account.
- Apple pass self-updates are dropped rather than built, and the pass stops advertising them.

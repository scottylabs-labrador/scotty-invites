# Organizer event edit/delete + invite-only fixes

**Date:** 2026-08-07
**Branch:** `admin-event-edit-and-invite-fixes`

## Problem

Two reported problems, which turned out to share a root cause.

1. **Admins can't edit their events.** `PATCH /api/org/events/:id` has existed since the
   first release but has no UI — the README notes it as "(no UI)". Organizers could create
   an event and never change it.
2. **Invite-only doesn't reliably work.** Confirmed against a running server: an event
   switched to invite-only through PATCH ends up with `invite_code = NULL`, and the gate
   compared `(supplied ?? "") !== (stored ?? "")`. With both sides empty the comparison is
   false, so **an empty code was a master key** — anonymous `GET /api/events/:code`
   returned 200 and `POST .../register` returned `approved`.

The two are entangled: shipping an edit form that exposes the registration-model radio
would have handed every organizer a one-click way to publish a wide-open "private" event.

## Confirmed defects

All reproduced against `localhost:4000` before any change (`scratchpad/repro.mjs`):

| # | Defect | Where |
| --- | --- | --- |
| 1 | PATCH to `model: "invite"` never mints an invite code | `router.ts` updateEvent |
| 2 | Null/empty stored code matches an empty submission — read gate open | `router.ts` events.get |
| 3 | Same on the write path — registration succeeds with no code | `router.ts` events.register |
| 4 | `/api/events/:code/calendar.ics` ignores the gate; leaks title, description, location | `server.ts` |
| 5 | `/api/events/:code/google-calendar` same, and served draft/cancelled events too | `server.ts` |
| 6 | Codes are stored lower-case but compared exactly — an autocapitalised code is rejected | `router.ts` |
| 7 | Sign-in round trip drops `?code=`, dumping the invited guest back on the locked gate | `EventPage.tsx` |
| 8 | PATCH accepts `endAt < startAt` (200) and 500s on an unparseable date | `router.ts` updateEvent |

## Design

### Invite codes

`newInviteCode()` moves to `lib/crypto.ts` next to the other generators and reuses the
short-code alphabet (no `i/l/o/0/1`) — these get read off a Slack message and typed on a
phone. Both create and update call it, so an invite-only event cannot exist without a code.

`inviteCodeMatches(stored, supplied)` is the single comparison used by every gate. It trims
and lower-cases both sides, uses a timing-safe compare, and — the important part — treats a
missing stored code as **locked, never open**.

`isScopedAdminFor(ctx, committeeId)` replaces the inline admin check, and now also exempts
scoped admins from the *register* gate, matching the read gate.

Existing broken rows are repaired by an idempotent backfill in `seed()`, which runs on boot.

### Model transitions

`updateEvent` now carries the side effects a model change implies, so PATCH can't produce a
state `createEvent` would never produce:

- → `invite`: unlist, and mint a code if there isn't one
- → anything else: relist, and clear the code

Dates are validated against the event's *post-patch* state, so a one-sided edit still has to
land on a valid range. Unparseable input is a 400, not a 500.

### Cancel vs delete

Deleting destroys registrations, tickets guests are holding, and the check-in record. The
new rule:

- **0 signups** → anyone scoped can delete outright.
- **Has signups** → committee admins get "cancel instead"; a super admin must cancel first,
  then delete. Two deliberate steps, never one click.

`myEvents` no longer filters out cancelled events — the organizer needs to reach them to
un-cancel, export the guest list, or delete them. `OrgEventSummary` gains `status` so the
dashboard can badge them.

### Permission model

Confirmed with the owner, and now covered by tests rather than assumed:

- **Ownership is the committee**, not the individual creator. Any admin of the committee an
  event is stamped with can manage it; an admin of a different committee can do nothing with
  it at all — not read, edit, cancel, delete, export or check in. Tying it to
  `created_by_email` was considered and rejected: it would strand a committee's events when
  the person who made them graduates.
- **Super admins are the only role that crosses committees**, and the only role that can
  reach the admin portal, invite admins, or change global question controls. All six
  `admin.*` routes gate on `role === "super_admin"`; there is no path for a committee admin
  to promote themselves.
- The signup guard on delete is orthogonal to identity: it is about destructiveness, so it
  applies to everyone. A committee admin can delete a zero-signup event but must cancel one
  that has signups; a super admin can then hard-delete the cancelled event.

### Edit UI

`GET /api/org/events/:id` (`org.getEvent` → `OrgEventDetail`) returns every PATCH-able
field plus the read-only context the screen needs: committee, invite code, a ready-made
`shareUrl` that carries `?code=`, the question set, and `registrationCount`/`deletable` so
the danger zone can't offer a button the API would reject.

The form itself is extracted from `CreateEventPage` into `components/EventForm.tsx` and
shared by both screens, so they can't drift. `mode` gates only what the API genuinely treats
differently:

- **Committee** — fixed after creation (`UpdateEventBody` omits `committeeId`).
- **Captures + host questions** — fixed after creation (PATCH omits them); shown read-only
  on the edit screen, because guests who already answered would be left with orphaned rows.
- **+1 allowance** — derived from audience on create (unchanged behaviour); an explicit
  toggle on edit, since the event may already differ.

New route `/organize/:id/edit`, reached from an "Edit event" button on the dashboard.

### Sharing

Every link that leaves the app now carries the code: the create-page success card, the
dashboard's "Copy invite link", the event page's copy button and Google Calendar link, and
the sign-in return path (`?to=` is URL-encoded and round-trips through the existing
localStorage stash).

### Dashboard robustness

An unknown `:id` in the URL no longer silently renders someone else's first event — it falls
back with an explanatory note.

## Verification

`scratchpad/verify.mjs` — 58 checks against a live server covering the gate (no/empty/wrong/
right code, both read and write), code normalisation, both calendar routes, leaving
invite-only, PATCH validation, the cancel/delete rules, and the full committee boundary:
two real invited committee admins, proving the owning committee's admin can read/edit/cancel
and delete a clean event, that the other committee's admin gets 403 on every one of those
plus dashboard, CSV and check-in, that neither appears in the other's event list, and that a
committee admin can neither invite a super admin nor open the admin portal. All pass.

Browser-verified end to end: edit → save → persisted; cancel → badge + hidden from browse;
delete confirm-by-name gate; and the full guest journey — locked gate → unlock via
uppercase code in the link → sign in → land back unlocked → register → ticket issued.

## Second pass — defects the edit UI introduced

A follow-up audit read the shipped implementation. Five of its findings reproduced against
a live server (`scratchpad/regressions.mjs`); all five are fixed:

| Finding | Cause | Fix |
| --- | --- | --- |
| Switching a capacity event to another model stranded every waitlisted guest forever — the promotion paths all bail on a null capacity, and Approve only renders in the *pending* queue, so there was no manual rescue | The edit form sends `capacity: null` for any model but `capacity` | `promoteWaitlist` now treats "no capacity" as "admit everyone waiting"; switching to `approval` moves them to `pending` via `waitlistToPending`; `updateEvent` forces `capacity: null` on `instant` like `createEvent` does; the form warns before the switch using the new `waitlistCount` |
| A cancelled event's public page still rendered live, with an RSVP button that 404s on submit — the Cancel button's own copy claims signups are closed | `EventDetail` had no `status`; `events.get` 404s only on `draft` | `status` added to `EventDetail`; the page shows a Cancelled tag and a "this event was cancelled" panel in place of every registration state |
| "Copy invite link" handed out codeless, dead links whenever the organizer arrived via "View event page" | `inviteQuery` was built only from the URL's `?code=` | `EventDetail.inviteCode` is returned **to scoped admins only**, and the client falls back to it; the label degrades to "Copy event link" when there is no code to embed |
| A claimed +1 holder was a stranger to the invite gate and both calendar routes — they hold a pass but no registration row | The gate checked `registrations` only; a child +1 ticket has `registrationId: null` | Both gates also accept a live `tickets` row for that user via `userHoldsTicket` |
| A mistyped id on the new `/organize/:id/edit` route reached Postgres as a cast error and 500'd | No uuid validation on path ids | `loadScopedEvent` rejects non-uuids as "not found" |

## Out of scope

Editing captures and host questions after publication. It needs a migration story for
existing answers; the edit screen shows them read-only and says why.

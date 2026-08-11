# Cross-Event Attendance Export — Design

**Date:** 2026-08-11 · **Status:** approved approach, pending spec review

## Problem

Attendance is captured per event (scanner → `checkins`), but there is no way to see who
shows up *across* events: a member's history, no-show rates, or an outreach-ready roster.
Organizers want the data in CSV form for Sheets analysis — not new dashboard UI.

## V1 scope

One backend export with two shapes, surfaced by a small download card on the organizer page.

### Endpoint

`GET /api/org/attendance.csv?shape=people|long` — a plain Fastify route beside the existing
per-event `app.get("/api/org/events/:id/export.csv")` in `server.ts`, reusing its session/admin
resolution and `lib/csv.ts`'s `toCsv`. (The per-event export is not a ts-rest contract route,
so this one isn't either — no contract change.) `shape` is required; missing or invalid → 400.

- **Committee admins** get rows for their committee's events only.
- **Super admins** get all committees, with an optional `?committee=<id>` filter.
- Non-admins get the same 401/403 the other org routes return.
- Always returns a CSV (headers only when there is no data). `Content-Disposition` names the
  file `attendance-people.csv` / `attendance-long.csv`.

### Shape `long` — one row per person × event (the source of truth)

| column | notes |
|---|---|
| event_title, event_date, event_status, committee | date = `start_at` ISO; status published/cancelled |
| name, andrew_id, email | from `users` via ticket |
| status | `attended` \| `no_show` \| `upcoming` \| `cancelled` \| `denied_at_door` |
| checkin_method | `qr` \| `manual` \| empty |
| checked_in_at | ISO timestamp of first `ok` scan, else empty |
| plus_one | `true` when the ticket is a +1; +1 rows carry the host's name in `host_name` |
| host_name | empty for primary tickets |
| source | the "how did you hear about this" answer, else empty |

`denied_at_door` rows come from `checkins.result = 'denied'`; when the attempted serial
matches no ticket, identity columns are empty and `andrew_id` falls back to the serial's
embedded localpart. These rows document people who showed up without a valid pass.

### Shape `people` — one row per person (rollup of `long`, excluding denied-only rows)

| column | notes |
|---|---|
| name, andrew_id, email | |
| events_signed_up | all un-revoked tickets, any event status |
| events_attended | events with ≥1 `ok` check-in |
| no_shows | past events, valid ticket, no `ok` check-in |
| plus_ones_brought | +1 tickets attached to their tickets that attended |
| first_attended_at, last_attended_at | ISO, empty if never attended |
| attendance_rate | attended ÷ (attended + no_shows), 2 dp, empty when denominator 0 |

### Definitions (agreed)

- **attended** = ticket has at least one `checkins` row with result `ok`.
- **no_show** = un-revoked ticket on an event whose `end_at` is in the past, with no `ok` check-in.
- **upcoming** events never count as no-shows.
- **Cancelled** events keep whatever check-ins actually happened (they are preserved on cancel).
  Un-attended tickets on cancelled events get long-shape status `cancelled` — neither attended
  nor no-show — and never affect `no_shows` or `attendance_rate` in the people rollup.

### Web

A compact "Attendance" card on the `/organize` dashboard (visible whenever the admin has ≥1
event): two buttons — "People CSV" and "Full history CSV" — plain `<a href>` downloads to the
endpoint, matching the existing Export CSV button style. No new route, no tables.

## Non-goals (v1)

Roster/segment UI, per-person drill-down pages, external BI tooling, scheduled email digests
of attendance, and any new database tables — this is a read-only aggregation of existing data.

## Architecture

- `apps/backend/src/services/attendance.ts` (new): the aggregation queries (drizzle joins over
  `events ⋈ tickets ⋈ users ⋈ checkins`, plus denied scans) returning plain row objects.
- `apps/backend/src/server.ts`: `app.get("/api/org/attendance.csv", ...)` beside the per-event
  export — resolve admin scope the same way, validate `shape`, call the service, `toCsv`, set
  the same headers.
- `apps/web/src/pages/OrganizePage.tsx`: the download card.

## Error handling

Bad `shape` → 400 ErrorBody. Unknown `committee` filter → empty CSV (headers only), not an
error. DB failures surface as the org routes' standard 500 path.

## Testing (TDD, vitest against the local Postgres)

Service-level tests seed a throwaway committee/event/users via the real schema, then assert:

1. attended vs no_show vs upcoming classification (event in past/future, with/without `ok` scan)
2. denied-at-door rows appear in `long` with empty identity when the serial matches nothing
3. committee scoping: admin A's export excludes committee B's events; super admin sees both
4. `people` rollup math (rates, first/last attended) and CSV escaping of commas/quotes
5. revoked tickets are excluded from signed-up counts

Manual verification: run locally, download both CSVs from the organizer page in the browser,
spot-check against the seeded data.

## Privacy

No new data is exposed: committee admins already see every column here in per-event guest
lists and exports; this only joins across their own events. Scoping tests (#3) are the guard.

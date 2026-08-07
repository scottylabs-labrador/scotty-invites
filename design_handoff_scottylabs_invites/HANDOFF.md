# ScottyLabs Invites — engineering handoff prompt

You are building **ScottyLabs Invites**: a Luma-style event signup system for ScottyLabs (CMU's student developer club), living at **invite.scottylabs.org** as its own application, cross-linked with scottylabs.org. The approved design prototype lives in this project as `.dc.html` screens — treat them as the visual + behavioral spec. This document is the contract: technical requirements first, then the design/UX decisions you must preserve.

---

## 1. Product in one paragraph

Admins (appointed by a super admin) create events under one of ScottyLabs' committees. Students sign up with CMU email magic links in one or two clicks; each approved signup issues a numbered, collectible **Scotty Invite** (QR pass, Apple/Google Wallet, transferable +1). Organizers get live dashboards, a door check-in scanner, configurable signup questions, email digests, and MCP access to their guest data. Everything lands in one Postgres on Railway.

## 2. Stack (match the existing repo)

- Monorepo layout mirroring `SunfishTK1/scottylabs.org`: `apps/web` + `apps/backend`, pnpm workspaces.
- Frontend: React Router + Vite + TypeScript + TanStack Query.
- Backend: Fastify + `ts-rest` (typesafe contract shared with frontend) + Drizzle ORM, Node runtime.
- Database: Postgres on Railway. Migrations via `pnpm db:generate`.
- Email: Mailgun (sign-in links/codes, admin invites, approvals, digests). Sender: hello@scottylabs.org.
- Hosting: web on Vercel, API on Railway (as with the main site).
- Fonts are self-hosted: Satoshi (400/500/700/900 woff2), Inter (Google), JetBrains Mono.

## 3. Domains & app split

- `invite.scottylabs.org` — the SPA (all screens below).
- `api.invite.scottylabs.org` — Fastify API.
- `mcp.invite.scottylabs.org` — MCP server (section 8).
- Header links back to `scottylabs.org`; the main site's Events nav item should link here.

## 4. Screens (built in this project — pixel spec)

| Screen | File | Notes |
| --- | --- | --- |
| Browse events | `Events Home.dc.html` | Date-rail timeline, filter chips, flagship hero card |
| Event page + signup | `Event Page.dc.html` | Registration form, states: open / pending / approved |
| My tickets | `Ticket.dc.html` | Wallet-style pass, +1 transfer, stub wall |
| Organizer dashboard | `Organizer Dashboard.dc.html` | KPIs, approve/decline queue, guest table, sources |
| Door check-in | `Check-in Scanner.dc.html` | Mobile scanner, result states, recent scans |
| Create event | `Create Event.dc.html` | Admin-only; committee, models, questions, invite design |
| Sign in | `Sign In.dc.html` | Magic link + 6-digit code, cookie, sign-out |
| Admin portal | `Admin Portal.dc.html` | Super admin: admins, committees, question controls, MCP |
| Architecture | `Architecture.dc.html` | Schema + flows (this doc's visual companion) |

## 5. Auth — email verify system (no passwords)

1. `POST /auth/start { email }`. Allowed if the domain is `andrew.cmu.edu`, `cs.cmu.edu`, or `cmu.edu`, **or** the email belongs to an invited admin (`admins.domain_exempt`), **or** the request carries a valid +1 transfer token.
2. Insert `magic_links` row (hashed token + hashed 6-digit code, 10-minute expiry, single use). Mailgun sends both a click-through link and the code.
3. On verify: **upsert `users` by lowercased email** (citext unique). Same email always resolves to the same account — tickets, registrations, and admin rights follow it.
4. Create a `sessions` row; set an httpOnly, Secure, SameSite=Lax cookie. 30-day rolling expiry ("keep me signed in" checked; session-only cookie otherwise). Sign out revokes the row and clears the cookie.
5. Roles: `admins.role ∈ {admin, super_admin}`. Only super admins manage admins. Only admins create events. Guests need no role.
6. Non-CMU guest emails are rejected with the exact copy in `Sign In.dc.html` (domain-error state).

## 6. Data model (Postgres, Drizzle) — source of truth in `Architecture.dc.html`

Tables: `committees` (seeded: Events, Tech, Design, Foundry, Outreach, Finance, Labrador, Bootcamp + all-club "ScottyLabs" scope), `users`, `sessions`, `magic_links`, `admins`, `events`, `event_questions`, `registrations`, `answers` (jsonb), `tickets`, `ticket_transfers`, `checkins`, `mcp_tokens`.

Key constraints & decisions:
- `users.email citext unique`; `registrations` unique on `(event_id, user_id)`; `tickets.registration_id` unique; `tickets.serial` format `SIT-###` with a per-event sequential `number`.
- `events.committee_id` is stamped from the creating admin (super admins may pick any, including all-club). Every dashboard, export, and pass stamp filters on it.
- `events` carries: audience `cmu | cmu_guests | public`, model `instant | capacity | approval | invite`, `capacity`, invite design (`artwork`, `pass_style`, `stamp`), `updates_email` + `digest (hourly|daily|weekly)`, `contact_email`, `status`.
- `event_questions.kind ∈ {standard, custom}`, with `visible` controlled per event by admins and globally by the super admin's question controls (a hidden standard field never renders anywhere).
- Standard captured data: name + andrew ID (free via sign-in), major + class year, dietary restrictions, resume upload (file storage: S3-compatible bucket, store the URL), "how did you hear about this" (source). Custom answers go to `answers.value jsonb`.
- CSV export per event = one query; keep it a first-class endpoint.

## 7. Registration, tickets, wallet

- Models: instant RSVP; capacity + waitlist (auto-promote in order on decline/cancel); approval required (review queue); invite-only (private link/code, unlisted).
- Approval (or instant signup) creates the ticket and emails it. Pending > 24h triggers an immediate escalation email to `updates_email` regardless of digest frequency.
- +1 transfers: `ticket_transfers.token` link; one transfer per allowance; claiming works for any email domain (the token is the exemption); claimed +1 counts against the host ticket at the door.
- Apple Wallet: signed `.pkpass`, pass type `pass.org.scottylabs.invite`, serial = ticket serial, QR barcode = serial, `webServiceURL` for updates (approval state, room changes).
- Google Wallet: one `EventTicketClass` per event, an `EventTicketObject` per ticket, "Save to Google Wallet" JWT link.
- Scanner: `POST /checkin { serial }` → `ok | duplicate | denied` (+ guest name, +1 status); writes `checkins`. Must be fast on a phone over campus Wi-Fi; support manual andrew-ID lookup and torch.

## 8. MCP server (admin data access)

- `mcp.invite.scottylabs.org`, authenticated through the **same email verify system**: connecting starts a Mailgun code flow; verifying mints an `mcp_tokens` row (committee-scoped; `scope=all` for super admins).
- Tools: `list_events`, `guest_list(event)`, `pending_reviews`, `export_csv(event)` — read the same Postgres with the same committee filters. Tokens are listed and revocable in the Admin portal.

## 9. Notifications (Mailgun)

- Transactional: sign-in link/code, admin invite, approval/decline, waitlist promotion, ticket + wallet links, +1 claimed.
- Digests: per event to `updates_email` at the configured frequency (hourly/daily/weekly) covering new signups and reviews waiting.
- Every invite/pass shows the event's `contact_email` ("questions? …") — replies go to a human, not the system.

## 10. Design & UX decisions (binding)

- **Design system**: ScottyLabs DS. Accent blue `#0e96d1` for links/primary actions; neutrals are cool blue-grays (`#c7d2dc` borders, `#e9ebf8` quiet dividers, `#f0f4f8` muted canvas); text `#1e1e1e`.
- **Type**: Satoshi for brand/display/headings, Inter for all UI, JetBrains Mono for serials, andrew IDs, emails, dates-on-passes, code. Never system-ui.
- **Buttons are always pills** (100px radius). Tags are boxy (4px). Inputs 6–8px. Cards 10–12px. Exception: Apple/Google Wallet buttons use ~10px radius per platform badge conventions (swap in official badge assets in production).
- **Surfaces**: public/browse pages on white; organizer/admin tools on muted `#f0f4f8` with white cards. Brand black + the conic gradient (red → magenta → blue → deep blue) is reserved for ticket artwork and the flagship hero — never on chrome or buttons.
- **Motion**: 120–280ms, `cubic-bezier(0.2,0,0,1)`; hover darkens (blue-500 → blue-600), press darkens + scale 0.97; no bounces.
- **Voice**: sentence case everywhere; direct student-club copy ("Sign up", "Request an invite", "All caught up"); "ScottyLabs" one word; ❤️ only in the footer credit.
- **Branding**: the app wordmark is **ScottyLabs Invites** (avoids confusion with the Events committee). Use the full Scotty terrier logo (`apps/web/app/assets/scottylabs-logo.svg`) — the partial-dog monogram in the DS is a known bug; don't use it.
- **The ticket is the brand moment**: dark (or light) wallet pass, gradient artwork band, mono serial `Nº 088`, dashed perforation, committee stamp toggle, stub wall of past invites. Keep it collectible.
- **Committee identity**: each committee has a fixed dot color (Events `#d72444`, Tech `#0e96d1`, Design `#6940c9`, Foundry `#063f58`, Outreach `#df6f3c`, Finance `#3a9a4c`, Labrador `#e8b13a`, Bootcamp `#5f6f7f`, all-club ScottyLabs `#1e1e1e`); stamps appear on browse cards, event pages, dashboards, scanner, and (optionally) the pass.
- **UX flow decisions**: browse uses a Luma-style date rail grouped by day; the signup form pre-fills identity from the session (andrew ID shown locked); data-use transparency line sits next to every submit; registration panel swaps states in place (open → request sent → you're in); approve/decline works from a queue with the guest's custom-question answer visible; check-in result sheet color-codes ok/+1/duplicate/denied; create-event previews the invite live as you type.
- **Responsive**: every guest-facing screen works from ~375px up (layouts wrap; hit targets ≥ 44px). Organizer tools degrade gracefully on mobile; the scanner is mobile-first.
- **Accessibility**: focus rings `0 0 0 3px rgba(14,150,209,0.25)` on all interactive elements; form fields always have visible labels; status conveyed by text + color, never color alone.

## 11. Non-functional

- Signup path must feel instant: optimistic UI on RSVP, < 200ms perceived actions, fades (180ms) over slides.
- Rate-limit `/auth/start` per email + IP; hash all tokens/codes at rest; single-use magic links.
- Timezone: America/New_York for display; store timestamptz.
- Analytics: PostHog (already used on the main site) — funnel: view → start signup → submit → approved → checked in, plus `source` attribution.

## 12. Open items (decide with the club)

- Resume storage bucket + retention policy (currently: optional, "shared with mentors only" copy).
- Public (non-CMU) audience events: payment/ticket caps are out of scope for v1.
- Google Calendar "subscribe to calendar" feed (ICS per committee?) — designed as a button, endpoint TBD.

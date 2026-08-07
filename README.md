# ScottyLabs Invites

A Luma-style event signup system for ScottyLabs — browse events, one-click signup with CMU
email magic links, numbered **Scotty Invite** QR passes (wallet-ready, transferable +1),
organizer dashboards, door check-in, committee-scoped admin tools, and MCP data access.

Built from the design handoff in `design_handoff_scottylabs_invites/` (see `HANDOFF.md` +
`README.md` there — the `.dc.html` files are the pixel spec).

## Live

| What | URL |
| --- | --- |
| App (SPA + API) | https://invite.scottylabs.org |
| MCP server | https://mcp.invite.scottylabs.org/mcp |
| Health | `/api/health` on the app, `/health` on MCP |

Hosted in the **Foundry Committee Deploy Sandbox** Railway project (services
`invites-app` + `invites-mcp` + a dedicated Postgres). DNS is Cloudflare CNAMEs
(DNS-only / grey cloud — `mcp.invite` must stay grey since the free universal cert
doesn't cover second-level subdomains) pointing at Railway's per-domain targets; the
generated `*.up.railway.app` domains still work as fallbacks.

Seeded super admin: `thomas@velroi.com` (domain-exempt). Sign in at `/signin` — a Mailgun
email delivers a 6-digit code and a scanner-safe magic link.

## Monorepo

```
apps/web        React 18 + Vite + react-router 7 + TanStack Query (SPA)
apps/backend    Fastify 4 + ts-rest + Drizzle ORM (Postgres) — also the MCP entry (APP_MODE=mcp)
packages/contract  Shared ts-rest contract + zod schemas (single source of API truth)
```

```bash
pnpm install
docker run -d --name slinvites-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=scottylabs_invites -p 5433:5432 postgres:16-alpine

# backend (runs migrations + seeds on boot; console mail prints codes)
cd apps/backend
DATABASE_URL=postgres://postgres:postgres@localhost:5433/scottylabs_invites \
MAIL_MODE=console SEED_SUPER_ADMIN_EMAILS=you@example.com pnpm dev

# web (proxies /api → :4000)
cd apps/web && pnpm dev
```

`pnpm -r typecheck` checks everything. `pnpm db:generate` regenerates Drizzle migrations.

## How it works

- **Auth** (`HANDOFF §5`): `POST /api/auth/start` allows `andrew.cmu.edu` / `cs.cmu.edu` /
  `cmu.edu`, invited admins (any domain), or a valid +1 transfer token. Magic-link tokens and
  6-digit codes are stored **hashed**, single-use, 10-minute expiry, 5 wrong-code attempts,
  per-email + per-IP rate limits. Users upsert by citext email; sessions are httpOnly /
  Secure / SameSite=Lax cookies with 30-day rolling expiry ("keep me signed in") or 24 h.
  The emailed link lands on a **confirmation page** — only the explicit POST consumes the
  token, so Gmail/Outlook link-prefetch scanners can't burn it.
- **Registration models**: instant / capacity+waitlist (auto-promote in signup order on
  decline·cancel·capacity-raise) / approval queue / invite-only (unlisted + code). Ticket
  numbering is per-event and race-safe (Postgres advisory locks); serials are
  `SIT-{number}-{ANDREWID}`, +1 passes are `SIT-{number}-P1`.
- **+1 transfers**: HMAC-derived links (`TRANSFER_LINK_SECRET`) — nothing secret at rest,
  revocable, one claim per allowance, any email domain can claim; the claimed pass counts
  against the host at the door.
- **Check-in**: event-scoped `POST /api/org/events/:id/checkin` → `ok | plus_one |
  duplicate | denied` with guest name + original scan time; camera QR (BarcodeDetector →
  jsQR fallback), manual andrew-ID lookup (matches email localpart for exempt guests), torch.
- **Emails (Mailgun)**: sign-in code, admin invite, request-received, ticket (+ waitlist
  promotion), declined, waitlisted, +1 claimed, digests (hourly/daily/weekly to
  `updates_email`, only when there's activity), pending->24 h escalation (immediate, once per
  registration). Every guest email carries the event's `contact_email` reply-to.
- **Wallet passes**: `GET /api/tickets/:id/apple.pkpass` (signed PKCS#7 .pkpass) and
  `GET /api/tickets/:id/google-wallet` (fat Save-to-Wallet JWT) are fully implemented and
  activate when the `APPLE_PASS_*` / `GOOGLE_WALLET_*` env vars are configured; until then
  they return a friendly 503 the UI surfaces inline.
- **MCP** (`APP_MODE=mcp`): streamable-HTTP server secured with **OAuth 2.1** per the MCP
  auth spec — clients hit a 401 challenge, discover the authorization server via RFC 9728,
  dynamically register (RFC 7591), and send the user to `invite.scottylabs.org` to approve
  in the browser (rides the normal app session; sign-in is the same email code). Tokens are
  authorization-code + PKCE with refresh rotation (7-day access / 90-day refresh), stored
  hashed in `mcp_tokens`, committee-scoped (`scope=all` for supers), require the owner to
  still be an admin on every request, and are listed/revocable in the Admin portal. Tools:
  `list_events`, `guest_list`, `pending_reviews`, `export_csv`, `whoami`.
- **CSV export**: `GET /api/org/events/:id/export.csv` — standard columns plus one column
  per custom/phone/t-shirt question, BOM + formula-injection-safe.
- **Calendars**: `GET /api/calendar.ics` (all listed events), per-event `.ics`, and a
  Google Calendar template redirect.

## Security posture

- All tokens/codes hashed at rest (magic links, sessions, MCP tokens); +1 links are
  HMAC-derived so nothing secret is stored. Timing-safe comparisons.
- httpOnly + Secure + SameSite=Lax session cookie; Origin allowlist check on every
  non-GET API call (CSRF defense-in-depth); HSTS, nosniff, frame-deny, referrer-policy.
- Committee scoping enforced server-side on every organizer/admin/MCP read and write;
  super-admin-only portal routes; resume files served only to the owner or admins
  (attachment disposition, type + 5 MB limits).
- Rate limits on `/auth/start` per email (4 / 10 min) and per IP (20 / h); 5 wrong-code
  attempts per link. Postgres is private-network only on Railway.

## Deploy notes

Two Railway services build from the same root `Dockerfile`; `invites-mcp` just sets
`APP_MODE=mcp`. Migrations + idempotent seeds run on boot. The SPA is served by the API
(single origin at `invite.scottylabs.org`) so session cookies stay first-party. If the
web app is ever split out to its own host (`api.invite.scottylabs.org` topology from
HANDOFF §3), set `APP_URL`, `API_URL`, `COOKIE_DOMAIN=.invite.scottylabs.org` and
`CORS_ORIGINS` — the code already supports it.

Key env vars: `DATABASE_URL`, `MAILGUN_API_KEY/DOMAIN/FROM_EMAIL/REGION` (`MAIL_MODE=console`
for dev), `SEED_SUPER_ADMIN_EMAILS`, `TRANSFER_LINK_SECRET`, `APP_URL`, `API_URL`,
`MCP_PUBLIC_URL`, optional `APPLE_PASS_*` / `GOOGLE_WALLET_*`.

## Deviations from the handoff (deliberate)

- **Single-origin sandbox deploy** (SPA served by the API): two sibling `*.up.railway.app`
  hosts are different registrable sites, so a split deploy would make the session cookie
  third-party and break sign-in in Safari/Chrome. Code fully supports the real split domains.
- **Create Event additions**: a Category select (browse filter chips need it) and a
  "Feature on the browse hero (flagship)" toggle (the hero needs a source of truth).
  +1 allowance follows the audience choice (per the design's own helper copy).
- **`PATCH /api/org/events/:id`** (no UI): scoped event editing — HANDOFF §7 anticipates
  room changes; also operationally necessary.
- **Resume storage** lives in Postgres (`files` table) behind auth instead of S3 — right
  size for the sandbox; the URL-based contract means swapping to S3 later touches one module.
- **"Sent via Mailgun from …"** on the sign-in screen shows the real configured sender
  (`noreply@mail.scottylabs.org`) rather than the design's placeholder address.
- `scty.li` short links render as real deployment URLs (functioning links beat fictional copy).

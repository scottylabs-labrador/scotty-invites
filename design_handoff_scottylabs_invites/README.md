# Handoff: ScottyLabs Invites (invite.scottylabs.org)

## Overview
A Luma-style event signup system for ScottyLabs: browse events, one-click signup with CMU email magic links, numbered "Scotty Invite" QR passes (Apple/Google Wallet, transferable +1), organizer dashboards, door check-in, admin-gated event creation, a super-admin portal, and MCP data access. **`HANDOFF.md` in this folder is the full requirements contract (auth, Postgres schema, integrations, non-functional). This README is the design spec companion.** Read both.

## About the Design Files
The `.dc.html` files in this bundle are **design references created in HTML** — interactive prototypes showing intended look and behavior, not production code to copy. Your task is to **recreate these designs in the target codebase's environment**: a new app in the scottylabs.org monorepo pattern (React Router + Vite + TypeScript + TanStack Query frontend; Fastify + ts-rest + Drizzle backend — see HANDOFF.md §2). Open each `.dc.html` in a browser to inspect the real rendering; `support.js` and `ios-frame.jsx` are prototype runtime helpers only and should not be ported.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, copy, and interaction states are final. Recreate pixel-perfectly using the values below and the exact copy in the files.

## Screens / Views

### 1. Events Home (`Events Home.dc.html`) — Browse
- Purpose: discover upcoming events, filter by category, jump into signup.
- Layout: app header (sticky, white, 64px min-height, 1px `#c7d2dc` bottom border, content max-width 1200px, gutters `clamp(16px,4.5vw,40px)`); h1 "Events" Satoshi 44px/700; black flagship hero card (radius 16, radial gradient glows, ticket-stub art rotated 3°); filter pill row; date-rail timeline — per day: 170px date column (dot + dashed rail `#d9e1e7`) beside white event cards (radius 12, border `#c7d2dc`, shadow-sm, hover → shadow-md + border `#9eb1c2`), 116px gradient art thumb right.
- Card contents: time 13px `#5f6f7f`; title Satoshi 20px/700; location + going-count + committee dot row 13px `#4a5662`; tag row (category + audience boxy tags 11px on `#f0f4f8`; status tag color-coded; CTA pill right-aligned).
- CTAs by model: "Sign up" (blue pill), "Join waitlist" (outlined), "Request an invite" (blue), "Enter invite code" (outlined).
- State: filter chip selection (active chip = black pill, white text).

### 2. Event Page (`Event Page.dc.html`) — Signup
- Purpose: event details + registration with data capture.
- Layout: back link; two columns (wrap; left rail flex `1 1 300px` max 400px — ticket art card + "Hosted by" card with copy-link/calendar actions; right flex `1 1 460px` — tag row, h1 Satoshi 44px, date/location rows with 44px icon tiles, "About", Registration panel).
- Registration panel: `#f8fafc` card, radius 12; header row + "87 of 120 spots approved"; 4px capacity bar (`#0e96d1` on `#d9e1e7`); form grid 2-col: Full name; Andrew ID (locked, mono, "via andrew sign-in"); Major, Class year selects; dietary restriction toggle chips (selected = `#e7f5fa` bg, `#0e96d1` border); resume dropzone (dashed `#aebdcc`, hover blue) → uploaded state (green `#e9f5ec` row with Remove); host question textarea; "How did you hear" select; "Bring a +1" switch row; submit pill + privacy line "Your name, andrew ID, and answers go to ScottyLabs organizers — nowhere else."
- States (tweakable prop in prototype): open form → "Request sent" (clock icon, blue circle) → "You're in" (green check, link to ticket).

### 3. My Tickets (`Ticket.dc.html`)
- Purpose: hold and use Scotty Invites; transfer the +1; collect past stubs.
- Pass (max 420px, mobile-first): black `#0a0a0a` card radius 20; header logo + mono serial "Nº 088"; gradient artwork band with event name Satoshi 26px + status chip; 2×2 mono-labeled field grid (Date/Doors/Location/Guest); dashed perforation with page-color notches; white QR block (150px), serial `SIT-088-JTARTAN`, "Scan at the door", contact line "questions? foundry@scottylabs.org".
- Status states: Approved (green chip) / Pending (QR replaced by locked placeholder) / Checked in.
- Wallet buttons: "Add to Apple Wallet" (black, radius 10), "Add to Google Wallet" (`#1f1f1f`, radius 10) — swap in official platform badges in production.
- +1 card: transferable link `scty.li/inv/088-P1` mono field + blue Copy pill (copied state), revoke link. Stub wall: gradient mini-stubs with "Checked in" footers.

### 4. Organizer Dashboard (`Organizer Dashboard.dc.html`)
- Muted canvas `#f0f4f8`. Event switcher h1 + sub-line "Foundry committee · Fri, Sep 11 · … · View event page"; Export CSV (outlined) + Open check-in (blue) pills.
- KPI cards (auto-fit minmax 200px): Requests 143 (+12 today), Approved 87/120 with bar, Waitlist 12, +1 invites 41.
- Guests table (7 cols: Name+avatar+"+1" tag / Andrew ID mono / Major / Year / Dietary / Resume PDF link / Source · Status chip). Status chips: Approved green `#e9f5ec`/`#0d4b17`, Pending yellow `#fdf3e4`/`#654a00`, Waitlist gray, Declined red.
- Right rail: Pending requests queue (name, andrew ID, custom-question answer in quotes, Approve blue pill / Decline outlined-red-hover; count badge; approving increments the KPI live; empty state "All caught up"); "Where signups came from" horizontal bars.

### 5. Check-in Scanner (`Check-in Scanner.dc.html`)
- Desk view around an iPhone frame: left stat cards (Checked in n/120 green bar; +1s, walk-ins, turned away), right "Recent scans" list with color dots.
- In-phone (dark): event header + live mono counter; camera viewport with corner brackets + animated scan line (3s ease loop); tapping simulates scans cycling result sheets: success (green), +1 guest (blue), duplicate (yellow, shows original scan time), denied (red, "send to registration"). Bottom: andrew-ID lookup pill + torch button.

### 6. Create Event (`Create Event.dc.html`) — Admin-only
- Muted canvas; sub-line "Admin-only — signed in as an Events committee admin (manage admins)".
- Cards: **Basics** (committee select incl. all-club "ScottyLabs", name — Satoshi bold styled input, description, date/start/end, location); **Who can sign up** (CMU only / CMU + guests / Public segmented pills + per-choice helper); **Registration** (4 radio cards: Instant / Capacity+waitlist / Approval / Invite only; capacity input or invite-link note appear contextually); **Data to capture** (switch rows; "Andrew ID + name — always on" locked at 65% opacity); **Your questions** (inline-editable rows: drag glyph, text input, type select Short text/Long text/Select/File, remove ×; dashed "Add a question"); **Updates & contact** (status-updates email, contact email, Hourly/Daily/Weekly digest pills, 24h-escalation note).
- Right sticky rail: live Scotty Invite preview (artwork band + name + committee stamp + contact line update as you type); 4 gradient artwork swatches; Dark/Light pass toggle; committee-stamp switch; "Publish event" blue pill → success card with `scty.li/…` link.

### 7. Sign In (`Sign In.dc.html`)
- Centered white card (max 430px) on muted canvas; minimal header.
- States: **email** (dog logo, "Sign in", "No passwords — we email you a link. Same email, same account, every time.", email input, "Keep me signed in on this device" checkbox (dark filled, 4px radius), blue pill, allowed-domains mono footnote) → **code** (mail icon, "Check your inbox", 6 code boxes 42×50 mono with active box blue-ring, Verify pill, Resend / different address, "Sent via Mailgun") → **signed-in** (avatar + green check badge, email mono chip, 30-day-cookie copy, "Continue to events" blue pill, "Sign out" outlined → returns to email state with "Signed out — cookie cleared" note). **domain-error**: red input + explanation (guests use +1 links; outside organizers need a super-admin invite).

### 8. Admin Portal (`Admin Portal.dc.html`) — Super admin
- h1 "Admin" + purple "Super admin" tag. Left: **Admins** list (avatar, name, email mono, "Domain exempt" tag for non-CMU, committee dot, role pill, Active/Invited status, Resend ("Sent ✓" flash) / Revoke (removes row)); **Signup questions** global switches (off = removed from every create flow). Right: **Invite an admin** (email any-domain, committee + role selects, "Send invite via Mailgun" → green confirmation + row appended, auto-tagged Domain exempt for non-CMU); **Committees** (9 rows: all-club ScottyLabs + 8 committees with dot colors and counts); **MCP data access** (endpoint mono chip, connected clients with Revoke, tool list).

### 9. Architecture (`Architecture.dc.html`)
Visual companion to HANDOFF.md: stack cards, four flow cards (auth, wallet, committees, MCP), "Who gets in" dark code card, one-account-per-email + digest notes, 13-table Postgres schema grid.

### 10. Current Events Page (`Current Events Page.dc.html`)
Faithful recreation of today's scottylabs.org shell (header/footer/fonts) and its `/events` placeholder — the link-back target and the styling source for the marketing site, not part of the new app.

## Interactions & Behavior
- Navigation: header tabs Browse / My tickets / Organize / Admin; "Create event" black pill; avatar → Sign in; "scottylabs.org ↗" cross-link. Footer: credit line + scottylabs.org / Architecture / GitHub / Sign in links.
- Motion: 120–280ms, `cubic-bezier(0.2,0,0,1)`. Hover darkens (never scales/lifts): blue `#0e96d1 → #0d89be`, black `#1e1e1e → #383838`. Press: darker + `scale(0.97)`. Content swaps fade 180ms. Scanner scan-line: 3s ease-in-out loop.
- Focus: `0 0 0 3px rgba(14,150,209,0.25)` ring + blue border on all inputs/buttons.
- Copy inline "Copied!" feedback (~1.6s). Approve/decline mutate queue + KPIs optimistically. Validation: email domain check per HANDOFF.md §5; required fields per event settings.
- Responsive: all layouts wrap via flex (guest screens usable at 375px; hit targets ≥ 44px); tables may scroll horizontally on small screens.

## State Management
Per screen: filter selection (Browse); registration phase open/pending/approved + form fields + dietary chips + resume + plusOne (Event Page); ticket status + copied (Tickets); pendingIds + approvedDelta (Dashboard); scan step + counters + recent list (Scanner); full event draft — name, committee, audience, model, captures, questions[], artwork, passStyle, stamp, contactEmail, digest, published (Create); auth phase + cookie consent (Sign In); admins[], question toggles, invite form (Admin). Data fetching: TanStack Query against the ts-rest contract; see HANDOFF.md §6–9 for entities and endpoints.

## Design Tokens
- Colors — accent blue `#0e96d1` (hover `#0d89be`, pressed `#0a6b94`, subtle `#e7f5fa`); text `#1e1e1e`; muted text `#4a5662` / `#5f6f7f` / `#7a8fa3`; borders `#c7d2dc`, subtle `#e9ebf8`, strong `#9eb1c2`; canvas muted `#f0f4f8`, panel `#f8fafc`; black surface `#0a0a0a`; success `#3a9a4c`/`#e9f5ec`/`#0d4b17`; warning `#e8b13a`/`#fdf3e4`/`#654a00`; danger `#d72444`/`#991a30`.
- Committee colors — Events `#d72444`, Tech `#0e96d1`, Design `#6940c9`, Foundry `#063f58`, Outreach `#df6f3c`, Finance `#3a9a4c`, Labrador `#e8b13a`, Bootcamp `#5f6f7f`, ScottyLabs (all-club) `#1e1e1e`.
- Gradients (ticket artwork + hero only, never chrome) — brand conic: `conic-gradient(from 180deg, #d72444 0%, #8766d4 25%, #0e96d1 55%, #063f58 80%, #d72444 100%)`; cool `135deg #0e96d1→#6940c9`; warm `135deg #d72444→#8766d4`; sunset `135deg #e8b13a→#df6f3c→#d72444`. Site footer hairline: `90deg #ff004e→#4f2485→#40d2fc` (8px, marketing site only).
- Type — Satoshi (brand/headings; wordmark 17px/700/-0.025em; h1 28–44px/700/-0.02em); Inter (all UI, 11–15px, 400–700); JetBrains Mono (serials, IDs, emails, code, 9–13px). Never system-ui.
- Radii — pills 100px (ALL buttons/chips/switches); tags 4px; inputs 6–8px; cards 10–12px; panels 14–16px; pass 20px; wallet badges 10px.
- Spacing — 4pt base; card padding 18–24px; section gaps 20–48px; page gutters `clamp(16px,4.5vw,40px)`; content max-width 1200px.
- Shadows — sm `0 1px 2px rgba(30,30,30,0.06)`; md `0 2px 8px rgba(30,30,30,0.08)`; pass `0 20px 48px rgba(6,63,88,0.28)`.

## Assets
- `apps/web/app/assets/scottylabs-logo.svg` — the full Scotty terrier mark (from the scottylabs.org repo). **Always use this**; the design-system monogram is an incomplete dog (known bug).
- `assets/scotty-logo-color.png` — gradient-wrapped dog (host avatar).
- `apps/web/app/assets/icons/` — site nav icons + `socials/` footer icons (repo originals, used on the recreation page).
- Fonts: Satoshi 400/500/700/900 woff2 + JetBrains Mono ttf (bundled); Inter via Google Fonts.
- UI icons: Lucide (lucide.dev), 1.5–2px stroke, `currentColor` — prototypes inline the exact paths.
- QR codes in the prototype are decorative placeholders — generate real ones from the ticket serial.

## Files
- `HANDOFF.md` — full technical requirements (read first).
- Design references: `Events Home.dc.html`, `Event Page.dc.html`, `Ticket.dc.html`, `Organizer Dashboard.dc.html`, `Check-in Scanner.dc.html`, `Create Event.dc.html`, `Sign In.dc.html`, `Admin Portal.dc.html`, `Architecture.dc.html`, `Current Events Page.dc.html`.
- Prototype runtime (do not port): `support.js`, `ios-frame.jsx`.

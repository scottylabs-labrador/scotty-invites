# Signup Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the signup-question feature real end to end — the organizer's builder collects options, required and order; the guest form renders every question the API sends; the server validates the answers; and organizers can edit questions after publish and read every answer back.

**Architecture:** This is a monorepo with three packages. `packages/contract` holds a ts-rest router plus zod schemas and is consumed **from source** by both apps, so a contract change breaks the backend and the web app at the same instant. `apps/backend` is Fastify 4 + Drizzle on Postgres; every API route is implemented against the contract, plus a handful of plain Fastify routes (file upload/download, CSV export, wallet passes) that sit outside it. `apps/web` is React 18 + Vite with inline-styled components, one global stylesheet, and no test runner. The database already has every column this feature needs — `event_questions.options`, `.required`, `.visible`, `.sort` all shipped in migration `0000` — so **no Drizzle migration is required anywhere in this plan.**

**Tech Stack:** TypeScript 5.8, pnpm workspaces, Fastify 4, ts-rest 3.52, Drizzle ORM 0.44 + Postgres, zod 3, React 18, react-router 7, TanStack Query 5, vitest 4 (backend only).

## Global Constraints

- `pnpm -r typecheck` must pass at the end of **every** task. It is the only enforcement of the contract: ts-rest response validation is switched off, so a drifted response shape fails nowhere at runtime.
- A contract change and its handler must land in the **same commit**. `s.router(contract, {...})` at `apps/backend/src/routes/router.ts:224` is exhaustive — a contract route with no implementation stops both apps typechecking.
- Never `throw` from a ts-rest handler; return `{ status, body }`. Every user-facing rule must be checked in the handler and returned as `{ error: <snake_case slug>, message: <conversational sentence> }`. A zod rejection comes back as `{pathParameterErrors, headerErrors, queryParameterErrors, bodyErrors}` with **no `message` field**, and the web client (`apps/web/src/lib/api.ts:16-23`) renders that as the useless string `Request failed (400)`.
- In the register handler, **every** new `400` must be returned before the destructive block at `apps/backend/src/routes/router.ts:469-474`. That block deletes a returning guest's prior cancelled registration and unlinks their old ticket in three un-transacted statements, and nothing recreates them if a later check fails.
- `answers.value` is a `jsonb` column that is decoded **twice** on read (node-postgres parses the column, then Drizzle's jsonb mapper parses the resulting string again). A stored `"4125551234"` comes back as the number `4125551234`, a stored `"true"` as `true`, a stored `"null"` as `null`. Never call `String(value)` on an answer — always `answerText(value)` from `apps/backend/src/lib/answers.ts`.
- File answers are stored as the file's UUID **lower-cased**. `GET /api/files/:id` matches lower-case only.
- No new Drizzle migration. Do not run `db:generate`.
- `apps/web` has **no test runner**. Web-only tasks replace the TDD cycle with `pnpm -r typecheck` plus the explicit manual QA checklist written into the task. Do not add a frontend test framework.
- `apps/backend` is the only package with a runner (vitest 4.1.10). There is **no vitest config file**, so the default `**/*.test.ts` glob discovers new test files automatically.
- Two test commands, and they are not interchangeable:
  - **DB-free unit test:** `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run <file>` — the pg Pool is lazy, but `apps/backend/src/env.ts:37` throws at import if `DATABASE_URL` is unset, and this worktree has no `.env`.
  - **Postgres-bound test:** needs a live Postgres on `localhost:5433`, database `scottylabs_invites`, user/password `postgres/postgres`. On this machine it is started with the `embedded-postgres` npm package, **not** Docker (the comment at `apps/backend/src/auth/service.test.ts:2-6` pointing at the README's Docker recipe is stale). Run migrations once, then the test:
    ```bash
    cd apps/backend
    export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites"
    npx tsx src/db/migrate.ts
    npx vitest run --no-file-parallelism <file>
    ```
    `--no-file-parallelism` is required whenever a test touches the global question controls: they live in a single `app_settings` row, and parallel test files would fight over it.
- Commit at the end of every task. Never bundle two tasks into one commit.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `apps/backend/src/lib/answers.ts` | `answerText(value)` — the one jsonb→display-string normalizer, shared by dashboard, CSV and MCP. Later gains `loadAnswers(registrationIds)`, the single answers⋈questions⋈files loader. |
| `apps/backend/src/lib/answers.test.ts` | DB-free unit tests for `answerText`. |
| `apps/backend/src/lib/guest-export.ts` | `buildGuestCsv(eventId)` — the CSV header + row construction, so the HTTP export and the MCP export cannot drift. |
| `apps/backend/src/lib/guest-export.test.ts` | Postgres-bound test: file answers become URLs, phone answers appear. |
| `apps/backend/src/test/harness.ts` | Integration-test helpers: boot the real `buildServer()`, mint committees/users/sessions, build a `CreateEventBody`, build a multipart upload body. |
| `apps/backend/src/contract-limits.test.ts` | DB-free assertions that `RegisterBody.custom`'s cap stays above what one event can ask. |
| `apps/backend/src/routes/create-event.test.ts` | Postgres-bound: host questions persist `required` and `options`. |
| `apps/backend/src/routes/register.test.ts` | Postgres-bound: answer validation, the "nothing ran past the destructive block" regression, and the standard-value gates. |
| `apps/backend/src/routes/org-questions.test.ts` | Postgres-bound: the `OrgEventQuestion` DTO and the `PUT .../questions` reconciliation table. |
| `apps/backend/src/files.test.ts` | Postgres-bound: `POST /api/files?kind=answer` and the extended read ACL. |

**Modified**

| Path | Change |
| --- | --- |
| `packages/contract/src/index.ts` | `MAX_CUSTOM_QUESTIONS`; `required` on `CreateEventBody.hostQuestions`; `RegisterBody.custom` cap 20→40; new `OrgEventQuestion`, `QuestionDraft`, `UpdateQuestionsBody`, `GuestAnswer`; `OrgEventDetail.questions` retyped; `GuestRow.answers` added; `PendingItem.answer` removed; `Dashboard.event.questions` added; new `org.updateQuestions` route. |
| `apps/backend/src/routes/router.ts` | `createEvent` writes `required`; `register` gains the validating answer pass, hoisted question controls, batched file-ownership check and per-event standard-value gates; `getEvent` emits the org question DTO; new `updateQuestions` handler; `buildGuestRows` attaches answers; `dashboard` drops the first-answer-only block and ships `event.questions`. |
| `apps/backend/src/server.ts` | `POST /api/files` accepts `?kind=answer`; `GET /api/files/:id` normalises the id, tightens the UUID pattern and adds the answer branch to the committee-admin ACL; the CSV route gains a UUID guard and delegates to `buildGuestCsv`. |
| `apps/backend/src/services/registrations.ts` | Export `lockEvent` so the questions PUT can take the same per-event advisory lock registrations take. |
| `apps/backend/src/mcp/main.ts` | `guest_list` and `pending_reviews` show answers; `export_csv` reuses `buildGuestCsv` so its "same columns as the dashboard export" claim becomes true. |
| `apps/web/src/components/EventForm.tsx` | `DraftQuestion` grows `qid/kind/key/options/required/visible/answerCount`; the real builder (options editor, Required toggle, reorder buttons, HTML5 drag, a separate "Hidden — answers kept" list) replaces both the create-only list and the edit-mode read-only list; `validateQuestions` added and the per-row rules split out of `validateEventForm`; the capture card is driven by the event's own standard rows in edit mode. |
| `apps/web/src/components/icons.tsx` | `ChevronUpIcon`, `ChevronDownIcon`. |
| `apps/web/src/pages/CreateEventPage.tsx` | Sends `options` and `required` with each host question. |
| `apps/web/src/pages/EditEventPage.tsx` | `toFormValues` derives `questions` from the server event; new `saveQuestions` mutation; the builder replaces the read-only card. |
| `apps/web/src/pages/EventPage.tsx` | One loop over `detail.questions` replaces the four `show*` flags plus the custom-only loop; per-question file upload; client-side required validation. |
| `apps/web/src/pages/OrganizePage.tsx` | Pending cards list every answer; guest rows expand to show all answers and file links. |
| `apps/web/src/pages/AdminPage.tsx` | The global-controls copy, which stops being true once organizers can toggle standard fields per event. |

---

### Task 1: The shared answer normalizer

**Files:**
- Create: `apps/backend/src/lib/answers.ts`
- Test: `apps/backend/src/lib/answers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `answerText(value: unknown): string` — exported from `apps/backend/src/lib/answers.ts`. Returns `""` for null/undefined, a string unchanged, an array joined with `"; "`, an object as `JSON.stringify`, anything else via `String()`.

**Note for later:** the module is import-free today, but Task 11 adds `loadAnswers` to it and with it imports of `../db/client` and `../env`. `answers.test.ts` keeps running without Postgres — the pg Pool is lazy — but only because the run command below exports `DATABASE_URL`; `apps/backend/src/env.ts:37` throws at import when it is unset. Keep that variable in the command even after this task, and do not describe the module as dependency-free in a comment.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/lib/answers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { answerText } from "./answers";

describe("answerText", () => {
  it("passes a plain string through untouched, spaces and all", () => {
    expect(answerText("Vegetarian")).toBe("Vegetarian");
    expect(answerText("  S  ")).toBe("  S  ");
  });

  it("renders a phone number that lost its string-ness in the jsonb round-trip", () => {
    // A stored "4125551234" is decoded twice and comes back as a number.
    expect(answerText(4125551234)).toBe("4125551234");
  });

  it("renders booleans instead of blanking them", () => {
    expect(answerText(true)).toBe("true");
    expect(answerText(false)).toBe("false");
  });

  it("renders a stored \"null\" as an empty cell", () => {
    expect(answerText(null)).toBe("");
    expect(answerText(undefined)).toBe("");
  });

  it("never emits [object Object]", () => {
    expect(answerText({ a: 1 })).toBe('{"a":1}');
  });

  it("joins arrays the way the dietary column already does", () => {
    expect(answerText(["Vegan", "Halal"])).toBe("Vegan; Halal");
  });

  it("renders zero and the empty string faithfully", () => {
    expect(answerText(0)).toBe("0");
    expect(answerText("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/answers.test.ts`

Expected: FAIL with `Failed to resolve import "./answers"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/backend/src/lib/answers.ts`:

```ts
/**
 * `answers.value` is a jsonb column, and the read path decodes it TWICE:
 * node-postgres JSON.parses the column text (pg-types registers JSON.parse for
 * OID 3802), then Drizzle's jsonb mapper JSON.parses the result again when it is
 * still a string. A stored "4125551234" therefore comes back as the NUMBER
 * 4125551234, a stored "true" as the boolean true, and a stored "null" as null —
 * which `String(v ?? "")` silently renders as an empty cell.
 *
 * Every surface that prints an answer (dashboard, CSV, MCP) goes through this one
 * function, or the three of them will disagree about what a phone number is.
 */
export function answerText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => answerText(v)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/lib/answers.test.ts`

Expected: PASS — 7 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors in any of the three packages.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/lib/answers.ts apps/backend/src/lib/answers.test.ts
git commit -m "Add answerText, the one jsonb answer normalizer"
```

---

### Task 2: Contract write-side — `required`, the answer cap, and the test harness

**Files:**
- Modify: `packages/contract/src/index.ts:37-42` (add the cap constant), `:187-190` (RegisterBody.custom), `:439-447` (hostQuestions)
- Modify: `apps/backend/src/routes/router.ts:1173-1184` (createEvent's host-question insert)
- Create: `apps/backend/src/test/harness.ts`
- Test: `apps/backend/src/contract-limits.test.ts`, `apps/backend/src/routes/create-event.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MAX_CUSTOM_QUESTIONS: number` (= 34) exported from `@scottylabs-invites/contract`.
  - `CreateEventBody.hostQuestions[].required?: boolean` — the server defaults it to `false`.
  - `RegisterBody.custom` now caps at 40 entries.
  - From `apps/backend/src/test/harness.ts`:
    - `startTestServer(): Promise<FastifyInstance>`
    - `makeCommittee(): Promise<{ id: string; slug: string; name: string; color: string; isAllClub: boolean; sort: number }>`
    - `makeUser(opts?: { admin?: { committeeId: string; role?: "admin" | "super_admin" } }): Promise<{ user: {...}; email: string; cookie: string }>`
    - `createEventBody(committeeId: string, over?: Record<string, unknown>): Record<string, unknown>`
    - `multipartUpload(filename: string, contentType: string, data: Buffer): { body: Buffer; contentType: string }`
    - `setControlsReturningPrevious(patch: Partial<QuestionControls>): Promise<QuestionControls>` — flips global controls and returns the snapshot from **before** the patch, which is what a test's `finally` block has to restore.

- [ ] **Step 1: Write the failing DB-free test**

Create `apps/backend/src/contract-limits.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_QUESTIONS, RegisterBody, CreateEventBody } from "@scottylabs-invites/contract";

const answers = (n: number) => Array.from({ length: n }, () => ({ questionId: randomUUID(), value: "x" }));

describe("contract limits stay consistent with each other", () => {
  it("lets a guest answer every question one event can carry, plus phone and t-shirt", () => {
    const most = MAX_CUSTOM_QUESTIONS + 2;
    expect(RegisterBody.safeParse({ fullName: "Jane Tartan", custom: answers(most) }).success).toBe(true);
  });

  it("still rejects an absurd answer payload", () => {
    expect(RegisterBody.safeParse({ fullName: "Jane Tartan", custom: answers(41) }).success).toBe(false);
  });

  it("accepts required on a host question at create time", () => {
    const parsed = CreateEventBody.shape.hostQuestions.safeParse([
      { label: "GitHub handle", type: "short", required: true },
      { label: "Track", type: "select", options: ["Web", "ML"], required: false },
    ]);
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the DB-free test to verify it fails**

Run: `cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/contract-limits.test.ts`

Expected: FAIL — `MAX_CUSTOM_QUESTIONS` is not exported, and the `required` key is stripped/rejected.

- [ ] **Step 3: Write the integration test harness**

Create `apps/backend/src/test/harness.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { QuestionControls } from "@scottylabs-invites/contract";
import { db, schema } from "../db/client";
import { sha256 } from "../lib/crypto";
import { buildServer } from "../server";
import { getQuestionControls, setQuestionControl } from "../services/settings";

/** The real server, wired exactly as production wires it. Drive it with app.inject(). */
export async function startTestServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.ready();
  return app;
}

export async function makeCommittee() {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const rows = await db
    .insert(schema.committees)
    .values({ slug, name: `Test ${slug}`, color: "#0e96d1" })
    .returning();
  return rows[0];
}

/**
 * A signed-in user. Sessions are looked up by sha256(token), so inserting the row
 * directly is equivalent to going through the magic-link flow — and far quicker.
 */
export async function makeUser(opts: { admin?: { committeeId: string; role?: "admin" | "super_admin" } } = {}) {
  const email = `test-${randomUUID().slice(0, 12)}@andrew.cmu.edu`;
  const user = (
    await db.insert(schema.users).values({ email, name: "Test Person", andrewId: email.split("@")[0] }).returning()
  )[0];
  if (opts.admin) {
    await db
      .insert(schema.admins)
      .values({ email, committeeId: opts.admin.committeeId, role: opts.admin.role ?? "admin" });
  }
  const token = `${randomUUID()}${randomUUID()}`;
  await db.insert(schema.sessions).values({
    userId: user.id,
    tokenHash: sha256(token),
    persistent: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { user, email, cookie: `sl_invites_session=${token}` };
}

/** A valid CreateEventBody with every capture off. Override what the test cares about. */
export function createEventBody(committeeId: string, over: Record<string, unknown> = {}) {
  const startAt = new Date(Date.now() + 7 * 86_400_000);
  const endAt = new Date(startAt.getTime() + 2 * 3_600_000);
  return {
    title: `Test event ${randomUUID().slice(0, 6)}`,
    description: "",
    committeeId,
    category: "Workshops",
    audience: "cmu",
    model: "instant",
    capacity: null,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    location: "Tepper 2612",
    captures: { major_year: false, dietary: false, resume: false, source: false, phone: false, tshirt: false },
    hostQuestions: [],
    artwork: "cool",
    passStyle: "dark",
    stampCommittee: true,
    allowPlusOne: false,
    updatesEmail: "test@scottylabs.org",
    contactEmail: "test@scottylabs.org",
    digest: "daily",
    ...over,
  };
}

/** POST /api/files is multipart and outside the contract, so build the body by hand. */
export function multipartUpload(filename: string, contentType: string, data: Buffer) {
  const boundary = `----harness${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The global question controls are ONE row in app_settings, shared by the whole
 * database. Any test that flips them must restore them, and the suite must run
 * with --no-file-parallelism.
 *
 * Returns the controls as they were BEFORE the patch — that is the snapshot a
 * `finally` block needs. `setQuestionControl` returns the controls AFTER its own
 * write (services/settings.ts:14-22), so handing its result back would make every
 * restore a no-op: `setControls({phone:true})` would report `phone: true` as the
 * "previous" value, the finally block would re-set it to true, and the control
 * would stay on for every test file that runs after this one — which is exactly
 * how Task 8's `refuses to switch on a standard field the club has disabled`
 * would start returning 200 instead of 400. Sequential files, one database: that
 * is a deterministic failure, not a flake.
 */
export async function setControlsReturningPrevious(patch: Partial<QuestionControls>): Promise<QuestionControls> {
  const before = await getQuestionControls();
  for (const [key, value] of Object.entries(patch)) {
    await setQuestionControl(key as keyof QuestionControls, value as boolean);
  }
  return before;
}
```

- [ ] **Step 4: Write the failing integration test**

Create `apps/backend/src/routes/create-event.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/client";
import { createEventBody, makeCommittee, makeUser, startTestServer } from "../test/harness";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

describe("POST /api/org/events — host question flags", () => {
  it("persists required and options on the questions it inserts", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });

    const res = await app.inject({
      method: "POST",
      url: "/api/org/events",
      headers: { cookie: organizer.cookie },
      payload: createEventBody(committee.id, {
        hostQuestions: [
          { label: "Track", type: "select", options: ["Web", "ML"], required: true },
          { label: "GitHub handle", type: "short" },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);

    const { id } = res.json() as { id: string };
    const rows = await db
      .select()
      .from(schema.eventQuestions)
      .where(eq(schema.eventQuestions.eventId, id))
      .orderBy(asc(schema.eventQuestions.sort));

    const custom = rows.filter((q) => q.kind === "custom");
    expect(custom.map((q) => q.label)).toEqual(["Track", "GitHub handle"]);
    expect(custom[0].required).toBe(true);
    expect(custom[0].options).toEqual(["Web", "ML"]);
    expect(custom[1].required).toBe(false);
    expect(custom[1].options).toBeNull();
  });
});
```

- [ ] **Step 5: Run the integration test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx tsx src/db/migrate.ts && npx vitest run --no-file-parallelism src/routes/create-event.test.ts
```

Expected: FAIL with `expected false to be true` on `custom[0].required` — `createEvent` never writes the column, so it defaults to `false`.

- [ ] **Step 6: Change the contract**

In `packages/contract/src/index.ts`, immediately after the `QuestionType` export (line 37-38), add the cap constant:

```ts
export const QuestionType = z.enum(["short", "long", "select", "file"]);
export type QuestionType = z.infer<typeof QuestionType>;

/**
 * How many custom questions one event may carry after publishing. Registration
 * sends one answer per answerable question (every custom question plus phone and
 * t-shirt), so `RegisterBody.custom`'s cap must stay above this + 2 — otherwise a
 * generous organizer makes every signup fail zod, and a zod failure reaches the
 * guest as an unreadable body with no `message` field.
 */
export const MAX_CUSTOM_QUESTIONS = 34;
```

Raise the answer cap (was `.max(20)`):

```ts
  custom: z
    .array(z.object({ questionId: z.string().uuid(), value: z.string().max(4000) }))
    .max(40)
    .optional(),
```

Add `required` to host questions:

```ts
  hostQuestions: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        type: QuestionType,
        options: z.array(z.string().max(120)).max(20).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(10),
```

- [ ] **Step 7: Honour `required` in createEvent**

In `apps/backend/src/routes/router.ts`, the host-question insert loop (currently lines 1173-1184) becomes:

```ts
      for (const q of body.hostQuestions) {
        questionRows.push({
          eventId: event.id,
          kind: "custom",
          key: null,
          label: q.label,
          type: q.type,
          options: q.options ?? null,
          required: q.required ?? false,
          visible: true,
          sort: sort++,
        });
      }
```

- [ ] **Step 8: Run both tests to verify they pass**

Run:
```bash
cd apps/backend && DATABASE_URL="postgres://nobody@127.0.0.1:1/none" npx vitest run src/contract-limits.test.ts
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/create-event.test.ts
```

Expected: PASS for both.

- [ ] **Step 9: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors. `CreateEventPage.tsx:65` still compiles because `required` is optional.

- [ ] **Step 10: Commit**

```bash
git add packages/contract/src/index.ts apps/backend/src/routes/router.ts apps/backend/src/test/harness.ts apps/backend/src/contract-limits.test.ts apps/backend/src/routes/create-event.test.ts
git commit -m "Persist required on host questions, raise the answer cap, add a test harness"
```

---

### Task 3: The question builder gains the controls it implies

**Files:**
- Modify: `apps/web/src/components/EventForm.tsx:19-23` (DraftQuestion), `:51-84` (emptyEventForm + validateEventForm), `:163` (delete `nextQid`), `:366-413` (the questions card)
- Modify: `apps/web/src/components/icons.tsx` (append two icons)
- Modify: `apps/web/src/pages/CreateEventPage.tsx:40-41` (run the question rules too), `:65` (send options and required)

**Interfaces:**
- Consumes: nothing from earlier tasks. The create screen's question cap is `CreateEventBody.hostQuestions`'s own `.max(10)`, so this task hardcodes `10`; `MAX_CUSTOM_QUESTIONS` (Task 2) does not become live until Task 9, where questions become editable after publish. Do **not** import it here.
- Produces, all exported from `apps/web/src/components/EventForm.tsx`:
  - `interface DraftQuestion { id: number; qid: string | null; kind: "standard" | "custom"; key: StandardQuestionKey | null; text: string; type: QuestionType; options: string[]; required: boolean; visible: boolean; answerCount: number }`
  - `blankQuestion(existing: DraftQuestion[]): DraftQuestion` — a new empty custom row with a collision-free local id.
  - `validateQuestions(questions: DraftQuestion[], maxCustom?: number): string | null` — the **full** question rules (count, label length, select options). Called by the create screen before publishing and, from Task 9, by the edit screen's Save questions button.
  - `validateEventForm(v: EventFormValues, opts?: { maxCustomQuestions?: number }): string | null` — the scalar rules plus the question **count** rule only. It gates both screens' primary save button, and the edit screen's Save changes must not be blocked by a rule about a payload it cannot send.
  - `QuestionsCard({ questions, onChange, isEdit, actions }: { questions: DraftQuestion[]; onChange: (next: DraftQuestion[]) => void; isEdit: boolean; actions?: React.ReactNode })`
- Also produces: `ChevronUpIcon`, `ChevronDownIcon` from `apps/web/src/components/icons.tsx`.

- [ ] **Step 1: Add the two icons**

Append to `apps/web/src/components/icons.tsx` (after `CameraIcon`):

```tsx
export const ChevronUpIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <polyline points="18 15 12 9 6 15" />
  </svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
```

- [ ] **Step 2: Widen `DraftQuestion` and the form seed**

In `apps/web/src/components/EventForm.tsx`, replace the type at lines 19-23 and update the imports at the top of the file:

```tsx
import { useMemo, useState } from "react";
import type {
  Artwork,
  Committee,
  Digest,
  EventAudience,
  EventCategory,
  EventModel,
  EventQuestion,
  PassStyle,
  QuestionControls,
  QuestionType,
  StandardQuestionKey,
} from "@scottylabs-invites/contract";
import { EVENT_CATEGORIES } from "@scottylabs-invites/contract";
import { ChevronDownIcon, ChevronUpIcon, GripIcon, LockIcon, PlusIcon, XIcon } from "./icons";
import { GRADIENTS } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

export interface DraftQuestion {
  /** Local React key and reorder identity. Never sent to the server. */
  id: number;
  /** The server row's uuid, or null for a row that has never been saved. */
  qid: string | null;
  kind: "standard" | "custom";
  key: StandardQuestionKey | null;
  /** The label. Named `text` because that is what the create screen has always called it. */
  text: string;
  type: QuestionType;
  options: string[];
  required: boolean;
  visible: boolean;
  /** Server-computed. Above zero, the type and options are frozen. */
  answerCount: number;
}

/** A fresh custom row whose local id cannot collide with anything already in the list. */
export function blankQuestion(existing: DraftQuestion[]): DraftQuestion {
  return {
    id: Math.max(0, ...existing.map((q) => q.id)) + 1,
    qid: null,
    kind: "custom",
    key: null,
    text: "",
    type: "short",
    options: [],
    required: false,
    visible: true,
    answerCount: 0,
  };
}
```

`EventQuestion` stays in that import list. It is still the type of the `existingQuestions?: EventQuestion[]` prop at `apps/web/src/components/EventForm.tsx:134`, which this task deliberately leaves in place (see Step 5), and which is read at `:157`, `:330` and `:333`. Task 9 Step 2 deletes the prop and the import together.

In `emptyEventForm` (line 65) seed the single blank row through the helper:

```ts
    captures: { major_year: true, dietary: false, resume: false, source: true, phone: false, tshirt: false },
    questions: [blankQuestion([])],
```

- [ ] **Step 3: Extend validation**

Replace `validateEventForm` (lines 78-84) with:

```ts
/** Rows that carry a real question. Blank-label rows are ignored everywhere, exactly
 *  as the create payload silently drops them, so the seeded empty row from
 *  `emptyEventForm` can never block a save. */
function realCustomQuestions(questions: DraftQuestion[]): DraftQuestion[] {
  return questions.filter((q) => q.kind === "custom" && q.text.trim());
}

/** The count rule on its own — the only question rule the scalar save enforces. */
function questionCountProblem(questions: DraftQuestion[], maxCustom: number): string | null {
  const n = realCustomQuestions(questions).length;
  if (n > maxCustom) return `That's ${n} questions — a signup form carries at most ${maxCustom}.`;
  return null;
}

/**
 * The rules for the primary save button on both screens: the scalars, plus the
 * question COUNT — and deliberately not the per-row question rules.
 *
 * This runs on the edit screen too (EditEventPage's `save`), where the request it
 * guards is `PATCH /api/org/events/:id` — and `UpdateEventBody` cannot carry
 * questions at all (packages/contract/src/index.ts:459). Every custom `select` in
 * the database today has `options: null`, because `CreateEventPage.tsx:65` has
 * never sent options, and `toDraftQuestion` (Task 9) maps that to `options: []`.
 * A "select needs at least one option" rule here would therefore refuse to let an
 * organizer fix a typo in the title of any such event, over a payload the request
 * does not even send. Question rules belong to the thing that saves questions.
 */
export function validateEventForm(v: EventFormValues, opts: { maxCustomQuestions?: number } = {}): string | null {
  if (!v.title.trim()) return "Give the event a name.";
  if (!v.date) return "Pick a date.";
  if (!v.location.trim()) return "Where is it happening?";
  if (!v.updatesEmail.trim() || !v.contactEmail.trim()) return "Add the updates and contact emails.";
  return questionCountProblem(v.questions, opts.maxCustomQuestions ?? 10);
}

/**
 * The full question rules, run by whatever is about to SEND questions: the create
 * screen's Publish (which posts `hostQuestions`) and, from Task 9, the edit
 * screen's Save questions button (which PUTs the whole list).
 * Standard rows are skipped: `major_year`, `dietary` and `source` really are
 * stored as type "select" with no options, and a blanket rule would trip on
 * every event that exists.
 */
export function validateQuestions(questions: DraftQuestion[], maxCustom = 10): string | null {
  const count = questionCountProblem(questions, maxCustom);
  if (count) return count;
  for (const q of realCustomQuestions(questions)) {
    const label = q.text.trim();
    if (label.length > 300) return `"${label.slice(0, 30)}…" is too long — keep a question under 300 characters.`;
    if (q.type !== "select") continue;
    const options = q.options.map((o) => o.trim()).filter(Boolean);
    if (options.length === 0) return `Add at least one option to "${label}", or change it to short text.`;
    if (options.length > 20) return `"${label}" has ${options.length} options — 20 is the maximum.`;
    const tooLong = options.find((o) => o.length > 120);
    if (tooLong) return `The option "${tooLong.slice(0, 30)}…" is too long — keep options under 120 characters.`;
  }
  return null;
}
```

- [ ] **Step 4: Write the builder card**

In `apps/web/src/components/EventForm.tsx`, add these two helpers just below `validateQuestions`:

```tsx
function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const FILE_HINT = "Guests upload a PDF or Word document, up to 5 MB.";
```

Then add the card component (place it after the `Card`/`Switch`/`seg` helpers, before `AUDIENCE_NOTES`):

```tsx
/**
 * The question builder, shared by create and edit. `questions` may contain the
 * event's standard rows (edit mode) — those are rendered by the "Data to capture"
 * card, not here, so this component only ever touches the custom slice and always
 * re-emits [standard…, live custom…, hidden custom…] so `sort` stays coherent and
 * retired rows land at the tail.
 */
export function QuestionsCard({
  questions,
  onChange,
  isEdit,
  actions,
}: {
  questions: DraftQuestion[];
  onChange: (next: DraftQuestion[]) => void;
  isEdit: boolean;
  actions?: React.ReactNode;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [handleHeld, setHandleHeld] = useState<number | null>(null);

  const standard = questions.filter((q) => q.kind === "standard");
  const customs = questions.filter((q) => q.kind === "custom");
  /**
   * A custom question that people have answered is never deleted — deleting it
   * cascades its answers away (answers.question_id is ON DELETE CASCADE), so the
   * server keeps it as visible:false instead. Those rows must still travel in
   * every later save, or the next PUT reads as a fresh attempt to remove them; but
   * they must not sit in the live list either, or "remove" would look like it did
   * nothing the moment the server's list came back. Two lists, one array.
   *
   * In create mode `hidden` is always empty — `blankQuestion` sets visible:true and
   * nothing can hide a row that has never been saved.
   */
  const live = customs.filter((q) => q.visible);
  const hidden = customs.filter((q) => !q.visible);
  const commit = (nextLive: DraftQuestion[], nextHidden: DraftQuestion[] = hidden) =>
    onChange([...standard, ...nextLive, ...nextHidden]);
  const patch = (id: number, fields: Partial<DraftQuestion>) =>
    commit(live.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  const clearDrag = () => {
    setDragId(null);
    setOverId(null);
    setHandleHeld(null);
  };

  return (
    <Card title="Your questions" sub="Guests see them in this order on the signup form. Drag the handle, or use the arrows.">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        {live.map((q, i) => {
          const locked = isEdit && q.answerCount > 0;
          return (
            <div
              key={q.id}
              draggable={handleHeld === q.id}
              onDragStart={(e) => {
                // Firefox refuses to start a drag unless setData is called here.
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(q.id));
                setDragId(q.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragId !== null && dragId !== q.id) setOverId(q.id);
              }}
              onDragLeave={(e) => {
                // dragleave also fires for children (the inputs, the buttons), so
                // only clear when the pointer really left this row.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setOverId((cur) => (cur === q.id ? null : cur));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = live.findIndex((x) => x.id === dragId);
                if (from >= 0 && from !== i) commit(move(live, from, i));
                clearDrag();
              }}
              onDragEnd={clearDrag}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "12px 14px",
                background: "var(--panel)",
                borderTop: overId === q.id ? "2px solid var(--blue)" : undefined,
                opacity: dragId === q.id ? 0.45 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  aria-label="Drag to reorder"
                  onMouseDown={() => setHandleHeld(q.id)}
                  onMouseUp={() => setHandleHeld(null)}
                  style={{ all: "unset", cursor: "grab", color: "#aebdcc", display: "flex" }}
                >
                  <GripIcon size={13} />
                </button>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <button
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => commit(move(live, i, i - 1))}
                    style={{ all: "unset", cursor: i === 0 ? "default" : "pointer", display: "flex", color: i === 0 ? "#d9e1e7" : "var(--muted-3)" }}
                  >
                    <ChevronUpIcon size={11} />
                  </button>
                  <button
                    aria-label="Move down"
                    disabled={i === live.length - 1}
                    onClick={() => commit(move(live, i, i + 1))}
                    style={{ all: "unset", cursor: i === live.length - 1 ? "default" : "pointer", display: "flex", color: i === live.length - 1 ? "#d9e1e7" : "var(--muted-3)" }}
                  >
                    <ChevronDownIcon size={11} />
                  </button>
                </div>
                <input
                  value={q.text}
                  onChange={(e) => patch(q.id, { text: e.target.value })}
                  placeholder="Ask anything — e.g. GitHub handle, team size"
                  style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-ui)", fontSize: 13.5, color: "var(--text)" }}
                />
                <button
                  onClick={() => patch(q.id, { required: !q.required })}
                  aria-label="Required"
                  style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: "none" }}
                >
                  <Switch on={q.required} />
                  <span style={{ fontSize: 11.5, color: "var(--muted-3)" }}>Required</span>
                </button>
                <select
                  value={q.type}
                  disabled={locked}
                  onChange={(e) => patch(q.id, { type: e.target.value as QuestionType })}
                  style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--muted-1)", background: "#fff", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 6px", outline: "none" }}
                >
                  {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <button
                  // An answered question cannot be deleted, so hide it locally and
                  // let it drop into the Hidden list right away — the alternative is
                  // a row that vanishes on click and reappears after the save.
                  onClick={() => (locked ? patch(q.id, { visible: false }) : commit(live.filter((x) => x.id !== q.id)))}
                  aria-label={locked ? "Hide question" : "Remove question"}
                  style={{ all: "unset", cursor: "pointer", color: "var(--muted-3)", display: "flex" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-3)")}
                >
                  <XIcon size={14} />
                </button>
              </div>

              {q.type === "select" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 27 }}>
                  {q.options.map((opt, oi) => (
                    <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        className="input"
                        style={{ padding: "6px 10px", fontSize: 12.5, maxWidth: 280 }}
                        value={opt}
                        disabled={locked}
                        placeholder={`Option ${oi + 1}`}
                        onChange={(e) => patch(q.id, { options: q.options.map((o, k) => (k === oi ? e.target.value : o)) })}
                      />
                      {!locked && (
                        <button className="quiet-link" onClick={() => patch(q.id, { options: q.options.filter((_, k) => k !== oi) })}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {!locked && (
                    <button
                      className="dropzone"
                      style={{ padding: 8, fontSize: 12, maxWidth: 280 }}
                      onClick={() => patch(q.id, { options: [...q.options, ""] })}
                    >
                      <PlusIcon size={12} />
                      Add option
                    </button>
                  )}
                </div>
              )}

              {q.type === "file" && (
                <div style={{ paddingLeft: 27, fontSize: 11.5, color: "var(--muted-3)" }}>{FILE_HINT}</div>
              )}

              {locked && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 27, fontSize: 11.5, color: "var(--muted-3)" }}>
                  <LockIcon size={11} />
                  {q.answerCount} {q.answerCount === 1 ? "person has" : "people have"} answered this — its type and options are fixed, removing
                  it moves it to Hidden below instead of deleting it, and rewording it changes the prompt shown next to their existing answers.
                </div>
              )}
            </div>
          );
        })}
        <button className="dropzone" style={{ padding: 12, fontWeight: 500 }} onClick={() => commit([...live, blankQuestion(questions)])}>
          <PlusIcon size={14} />
          Add a question
        </button>

        {hidden.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: "var(--muted-3)" }}>
              <LockIcon size={11} />
              Hidden — answers kept
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted-3)", lineHeight: 1.5 }}>
              Guests no longer see these, and they keep their CSV column and every answer already given.
            </div>
            {hidden.map((q) => (
              <div
                key={q.id}
                style={{ display: "flex", alignItems: "center", gap: 10, border: "1px dashed #d9e1e7", borderRadius: 8, padding: "10px 14px", background: "var(--canvas-muted)" }}
              >
                <span style={{ fontSize: 13, color: "var(--muted-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)", flex: "none" }}>
                  {q.answerCount} {q.answerCount === 1 ? "answer" : "answers"}
                </span>
                <button
                  className="quiet-link"
                  style={{ flex: "none" }}
                  onClick={() => commit([...live, { ...q, visible: true }], hidden.filter((x) => x.id !== q.id))}
                >
                  Show again
                </button>
              </div>
            ))}
          </div>
        )}

        {actions}
      </div>
    </Card>
  );
}
```

- [ ] **Step 5: Use the card on the create screen and delete the dead state**

In `apps/web/src/components/EventForm.tsx`, delete the `nextQid` state line (currently line 163) entirely — `blankQuestion` derives a safe id from the current list, so no mount-only counter can go stale.

Replace the whole create-only "Your questions" card (currently lines 366-413) with:

```tsx
            <QuestionsCard questions={v.questions} onChange={(next) => set("questions", next)} isEdit={false} />
```

Leave the `isEdit` branch (lines 327-342) and the "Data to capture" card untouched for now — Task 9 replaces them.

- [ ] **Step 6: Send the new fields from the create screen**

In `apps/web/src/pages/CreateEventPage.tsx`, add `validateQuestions` to the import from `../components/EventForm` and replace lines 40-41 — publishing is the moment the questions are actually sent, so it is where the question rules belong:

```ts
      const problem = validateEventForm(values) ?? validateQuestions(values.questions);
      if (problem) throw new Error(problem);
```

Then replace line 65:

```ts
          hostQuestions: values.questions
            .filter((q) => q.kind === "custom" && q.text.trim())
            .map((q) => ({
              label: q.text.trim(),
              type: q.type,
              options: q.type === "select" ? q.options.map((o) => o.trim()).filter(Boolean) : undefined,
              required: q.required,
            })),
```

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors in any of the three packages. `EventQuestion` is still imported and still used by the `existingQuestions` prop this task leaves alone.

- [ ] **Step 8: Manual QA**

Start Postgres, then `pnpm dev` from the repo root (the backend reads `.env`; this worktree has none, so export `DATABASE_URL`, `MAIL_MODE=console` and `SEED_SUPER_ADMIN_EMAILS=<your andrew email>` first). Sign in at `http://localhost:5173/signin` (the code prints to the backend console) and open `/create`.

- [ ] Add a question, set its type to **Select** — an options editor appears beneath the row.
- [ ] Click "Add option" twice, fill in `Web` and `ML`.
- [ ] Toggle **Required** on that row — the switch turns blue.
- [ ] Add a second question; click its up-arrow — it swaps with the first. The first row's up-arrow and the last row's down-arrow are greyed out.
- [ ] Press and hold the grip dots on the second row and drag it above the first — a blue line marks the drop target and the row lands there.
- [ ] Set a third question's type to **File** — the caption "Guests upload a PDF or Word document, up to 5 MB." appears.
- [ ] Empty every option on the select question and click **Publish event** — publishing is refused with `Add at least one option to "…", or change it to short text.`
- [ ] Restore the options and publish. In psql: `select label, type, options, required, sort from event_questions where event_id = '<new id>' order by sort;` shows the select question with `["Web","ML"]`, `required = t`, and the row order you dragged into.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/EventForm.tsx apps/web/src/components/icons.tsx apps/web/src/pages/CreateEventPage.tsx
git commit -m "Real question builder: options, required, reorder"
```

---

### Task 4: One guest renderer

**Files:**
- Modify: `apps/web/src/pages/EventPage.tsx:111-116` (state), `:118-122` (the four `show*` flags), `:136` (the register body's `custom`), `:150-165` (the uploader), `:351-457` (the form body below the name grid), `:481-484` (the submit handler)

**Interfaces:**
- Consumes: nothing from earlier tasks at compile time; the questions this renders only carry real `options`/`required` once Task 3 has shipped.
- Produces: no exported symbols. The behavioural contract other tasks rely on: for every question where `kind === "custom" || key === "phone" || key === "tshirt"`, the page sends `{ questionId, value }` in `RegisterBody.custom`, and a `file` question's value is the uploaded file's UUID.

- [ ] **Step 1: Widen the answer state and generalise the uploader**

In `apps/web/src/pages/EventPage.tsx`, replace the state block at lines **111-116** (line 111 is `const [plusOne, setPlusOne] = useState(false);` and it is the first line of the replacement below — start the replacement there, or the file ends up with two `plusOne` declarations) and the `uploadResume` function at lines 150-165:

```tsx
  const [plusOne, setPlusOne] = useState(false);
  /** Keyed by question id. `filename` is display-only — a file answer sends `value`, the file's UUID. */
  const [custom, setCustom] = useState<Record<string, { value: string; filename?: string }>>({});
  /** Per-question upload spinners. One shared flag would disable every uploader at once. */
  const [uploads, setUploads] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const answerInputs = useRef<Record<string, HTMLInputElement | null>>({});
```

```tsx
  /** The one upload path. `kind` tells the server whether this is the resume or an answer. */
  async function uploadFile(file: File, kind: "resume" | "answer"): Promise<{ id: string; filename: string }> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/files?kind=${kind}`, { method: "POST", body: form, credentials: "include" });
    const body = (await res.json()) as { id?: string; filename?: string; message?: string };
    if (!res.ok || !body.id) throw new Error(body.message ?? "Upload failed");
    return { id: body.id, filename: body.filename ?? file.name };
  }

  async function uploadResume(file: File) {
    setUploading(true);
    setError(null);
    try {
      setResume(await uploadFile(file, "resume"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
```

- [ ] **Step 2: Derive the answerable set and validate on submit**

Replace lines 118-122 (the four `show*` flags plus `customQuestions`) with:

```tsx
  const showMajorYear = detail.questions.some((q) => q.key === "major_year");
  const showDietary = detail.questions.some((q) => q.key === "dietary");
  const showResume = detail.questions.some((q) => q.key === "resume");
  const showSource = detail.questions.some((q) => q.key === "source");
  /**
   * Everything that submits through RegisterBody.custom: host questions plus the
   * two standard keys the backend accepts there. major_year / dietary / resume /
   * source keep their bespoke widgets and their own top-level body fields.
   */
  const answerable = detail.questions.filter((q) => q.kind === "custom" || q.key === "phone" || q.key === "tshirt");
```

Change the register body's `custom` line (line 136) to:

```tsx
          custom: answerable.map((q) => ({ questionId: q.id, value: custom[q.id]?.value ?? "" })).filter((a) => a.value.trim()),
```

Add the validator right after `uploadResume`:

```tsx
  /**
   * `required` applies only to the questions that travel through `custom`. The
   * four bespoke standards are excluded deliberately and the builder never offers
   * a Required toggle for them: major, class year and source are pre-selected to
   * non-empty defaults so "required" is unobservable, and "no dietary
   * restrictions" is a legitimate empty answer. The server draws the same line.
   */
  function validateAnswers(): boolean {
    const errs: Record<string, string> = {};
    for (const q of answerable) {
      if (!q.required) continue;
      if (!(custom[q.id]?.value ?? "").trim()) errs[q.id] = "This one's required.";
    }
    setFieldErrors(errs);
    const first = answerable.find((q) => errs[q.id]);
    if (first) {
      setError(`“${first.label}” is required.`);
      return false;
    }
    return true;
  }
```

And change the submit handler (line 481-484) to run it:

```tsx
                  onClick={() => {
                    setError(null);
                    if (!validateAnswers()) return;
                    registerMutation.mutate();
                  }}
```

- [ ] **Step 3: Replace the four hardcoded blocks with one loop**

Replace everything from the `{showMajorYear && (` fragment inside the name grid (line 351) through the closing of the source block (line 457) with the markup below.

The grid `<div>` at line 335 and the two labels inside it, `apps/web/src/pages/EventPage.tsx:336-350`, are **unchanged** — they are reproduced verbatim below so there is no doubt about where the grid now ends. What changes is only that the grid stops being a container for the major/class-year selects: it closes right after the Andrew ID label, and the loop follows it.

```tsx
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="field-label">Full name</span>
                  <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Tartan" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="field-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    Andrew ID <LockIcon size={11} style={{ color: "var(--muted-3)" }} />
                  </span>
                  <div className="mono" style={{ display: "flex", alignItems: "center", fontSize: 13, color: "var(--muted-2)", padding: "10px 12px", border: "1px solid #d9e1e7", borderRadius: 6, background: "var(--canvas-muted)" }}>
                    {me.user.andrewId ?? me.user.email.split("@")[0]}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--muted-3)" }}>
                      {me.user.andrewId ? "via andrew sign-in" : "via email sign-in"}
                    </span>
                  </div>
                </label>
              </div>

              {/*
                One loop, in the server's sort order. The four bespoke keys keep
                their own widgets because their UI (two dropdowns, chips, an
                uploader) is not expressible as a generic type, and because their
                stored `type` is unreliable — `resume` is seeded as "short" and
                three of them are "select" with null options. Everything else is
                routed by `type`.
              */}
              {detail.questions.map((q) => {
                if (q.key === "major_year") {
                  return (
                    <div key={q.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span className="field-label">Major</span>
                        <select className="input" value={major} onChange={(e) => setMajor(e.target.value)}>
                          {MAJOR_OPTIONS.map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span className="field-label">Class year</span>
                        <select className="input" value={classYear} onChange={(e) => setClassYear(e.target.value)}>
                          {CLASS_YEAR_OPTIONS.map((y) => (
                            <option key={y}>{y}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  );
                }

                if (q.key === "dietary") {
                  return (
                    <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span className="field-label">Dietary restrictions</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {DIETARY_OPTIONS.map((dt) => {
                          const on = diets.includes(dt);
                          return (
                            <button
                              key={dt}
                              className={`diet-chip ${on ? "diet-chip-on" : "diet-chip-off"}`}
                              onClick={() => setDiets(on ? diets.filter((x) => x !== dt) : [...diets, dt])}
                            >
                              {dt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                if (q.key === "resume") {
                  return (
                    <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span className="field-label">
                        Resume <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>— optional, shared with {detail.committee.name} mentors only</span>
                      </span>
                      {!resume ? (
                        <>
                          <button className="dropzone" disabled={uploading} onClick={() => fileInput.current?.click()}>
                            <UploadIcon size={16} />
                            {uploading ? "Uploading…" : "Drop your resume here, or click to browse"}
                          </button>
                          <input
                            ref={fileInput}
                            type="file"
                            accept=".pdf,.doc,.docx,application/pdf"
                            style={{ display: "none" }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void uploadResume(f);
                              e.target.value = "";
                            }}
                          />
                        </>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--success-border)", background: "var(--success-bg)", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "var(--success-text)" }}>
                          <CheckIcon size={15} style={{ color: "var(--success)" }} />
                          {resume.filename}
                          <button className="quiet-link" style={{ marginLeft: "auto" }} onClick={() => setResume(null)}>
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }

                if (q.key === "source") {
                  return (
                    <label key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 280 }}>
                      <span className="field-label">How did you hear about this?</span>
                      <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                        {SOURCE_OPTIONS.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                  );
                }

                const answer = custom[q.id];
                const err = fieldErrors[q.id];
                const cls = `input${err ? " input-error" : ""}`;
                const setValue = (value: string) => setCustom({ ...custom, [q.id]: { value } });
                const clearError = () =>
                  setFieldErrors((cur) => {
                    if (!cur[q.id]) return cur;
                    const next = { ...cur };
                    delete next[q.id];
                    return next;
                  });

                return (
                  <label key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">
                      {q.label}
                      {q.required && <span style={{ color: "var(--danger)" }}> *</span>}
                      {q.kind === "custom" && <span style={{ fontWeight: 400, color: "var(--muted-3)" }}> — host question</span>}
                    </span>

                    {q.type === "long" ? (
                      <textarea
                        className={cls}
                        rows={2}
                        placeholder="A sentence or two is plenty"
                        value={answer?.value ?? ""}
                        onChange={(e) => {
                          clearError();
                          setValue(e.target.value);
                        }}
                      />
                    ) : q.type === "select" && q.options?.length ? (
                      <select
                        className={cls}
                        value={answer?.value ?? ""}
                        onChange={(e) => {
                          clearError();
                          setValue(e.target.value);
                        }}
                      >
                        <option value="">Choose…</option>
                        {q.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : q.type === "file" ? (
                      !answer?.value ? (
                        <>
                          <button className="dropzone" disabled={!!uploads[q.id]} onClick={() => answerInputs.current[q.id]?.click()}>
                            <UploadIcon size={16} />
                            {uploads[q.id] ? "Uploading…" : "PDF or Word document, up to 5 MB"}
                          </button>
                          <input
                            ref={(el) => {
                              answerInputs.current[q.id] = el;
                            }}
                            type="file"
                            accept=".pdf,.doc,.docx,application/pdf"
                            style={{ display: "none" }}
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              e.target.value = "";
                              if (!f) return;
                              clearError();
                              setUploads((u) => ({ ...u, [q.id]: true }));
                              try {
                                const up = await uploadFile(f, "answer");
                                setCustom((c) => ({ ...c, [q.id]: { value: up.id, filename: up.filename } }));
                              } catch (uploadError) {
                                setFieldErrors((fe) => ({ ...fe, [q.id]: (uploadError as Error).message }));
                              } finally {
                                setUploads((u) => ({ ...u, [q.id]: false }));
                              }
                            }}
                          />
                        </>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--success-border)", background: "var(--success-bg)", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "var(--success-text)" }}>
                          <CheckIcon size={15} style={{ color: "var(--success)" }} />
                          {answer.filename ?? "Uploaded"}
                          <button
                            className="quiet-link"
                            style={{ marginLeft: "auto" }}
                            onClick={() =>
                              setCustom((c) => {
                                const next = { ...c };
                                delete next[q.id];
                                return next;
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      )
                    ) : (
                      // Reached by `short` AND by a `select` with no options — the
                      // latter is what pre-builder events stored, and a plain text
                      // box preserves the answers already collected there. An empty
                      // dropdown could not be satisfied if the question were required.
                      <input
                        className={cls}
                        value={answer?.value ?? ""}
                        onChange={(e) => {
                          clearError();
                          setValue(e.target.value);
                        }}
                      />
                    )}

                    {err && <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{err}</span>}
                  </label>
                );
              })}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors.

- [ ] **Step 5: Manual QA**

Question rows are frozen at creation (`visible` is decided once, at `router.ts:1169`), so this cannot be demonstrated on an existing event. Create a fresh one.

- [ ] As a super admin, open `/admin` and switch **Phone number** and **T-shirt size** on.
- [ ] Create a new event with every capture on, plus three host questions: a required short one, a select with options, and a file one.
- [ ] Open the event page as a guest. Every question renders in the order the builder showed, `How did you hear about this?` now sits above the host questions, and Phone number and T-shirt size appear for the first time.
- [ ] The select renders as a real dropdown with your options and a leading `Choose…`.
- [ ] Click **Sign up** with the required question blank — the field gets a red border, an inline "This one's required." appears under it, the red summary line names the question, and no request is sent (confirm in the Network tab).
- [ ] Upload a PDF to the file question — the row shows the filename with a green tick while the resume dropzone stays independently usable.
- [ ] Submit. In psql: `select q.label, a.value from answers a join event_questions q on q.id = a.question_id where a.registration_id = '<id>';` shows the phone, t-shirt, text and select answers, and the file answer as a lower-case UUID.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/EventPage.tsx
git commit -m "Render the signup form from the question list the API already sends"
```

---

### Task 5: Server-side answer validation

**Files:**
- Modify: `apps/backend/src/routes/router.ts:444-490` (the register handler's validation region and the `getQuestionControls` call site)
- Test: `apps/backend/src/routes/register.test.ts`

**Interfaces:**
- Consumes: `createEventBody`, `makeCommittee`, `makeUser`, `startTestServer`, `setControlsReturningPrevious` from `apps/backend/src/test/harness.ts` (Task 2); `CreateEventBody.hostQuestions[].required` (Task 2).
- Produces: three new error codes on `POST /api/events/:code/register`, all returned **before** the destructive block: `answer_required`, `answer_option`, `answer_file`, plus the existing `bad_file` now covering file answers as well as the resume.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/routes/register.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/client";
import { createEventBody, makeCommittee, makeUser, setControlsReturningPrevious, startTestServer } from "../test/harness";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

/** Publishes an event and returns it with its question rows, in sort order. */
async function publish(cookie: string, committeeId: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/org/events",
    headers: { cookie },
    payload: createEventBody(committeeId, over),
  });
  expect(res.statusCode).toBe(200);
  const created = res.json() as { id: string; shortCode: string };
  const questions = await db
    .select()
    .from(schema.eventQuestions)
    .where(eq(schema.eventQuestions.eventId, created.id))
    .orderBy(asc(schema.eventQuestions.sort));
  return { ...created, questions };
}

/** A prior cancelled registration — the row every new 400 must leave alone. */
async function seedCancelled(eventId: string, userId: string) {
  const rows = await db
    .insert(schema.registrations)
    .values({ eventId, userId, status: "cancelled", fullName: "Jane Tartan" })
    .returning();
  return rows[0];
}

describe("POST /api/events/:code/register — answer validation", () => {
  it("rejects a blank required answer by name, and leaves the prior registration standing", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      hostQuestions: [{ label: "GitHub handle", type: "short", required: true }],
    });
    const guest = await makeUser();
    const prior = await seedCancelled(event.id, guest.user.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "answer_required" });
    expect((res.json() as { message: string }).message).toContain("GitHub handle");
    const still = await db.select().from(schema.registrations).where(eq(schema.registrations.id, prior.id));
    expect(still).toHaveLength(1);
  });

  it("rejects a select answer that is not one of the options", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      hostQuestions: [{ label: "Track", type: "select", options: ["Web", "ML"] }],
    });
    const question = event.questions.find((q) => q.label === "Track")!;
    const guest = await makeUser();
    const prior = await seedCancelled(event.id, guest.user.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [{ questionId: question.id, value: "Robotics" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "answer_option" });
    const still = await db.select().from(schema.registrations).where(eq(schema.registrations.id, prior.id));
    expect(still).toHaveLength(1);
  });

  it("rejects a file answer that names someone else's upload", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      hostQuestions: [{ label: "Portfolio", type: "file" }],
    });
    const question = event.questions.find((q) => q.label === "Portfolio")!;
    const stranger = await makeUser();
    const strangerFile = (
      await db
        .insert(schema.files)
        .values({
          ownerUserId: stranger.user.id,
          kind: "answer",
          filename: "secret.pdf",
          contentType: "application/pdf",
          size: 3,
          data: Buffer.from("pdf"),
        })
        .returning()
    )[0];
    const guest = await makeUser();
    const prior = await seedCancelled(event.id, guest.user.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [{ questionId: question.id, value: strangerFile.id }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "bad_file" });
    const still = await db.select().from(schema.registrations).where(eq(schema.registrations.id, prior.id));
    expect(still).toHaveLength(1);
  });

  it("stores a phone answer and ignores a question id that is no longer answerable", async () => {
    const before = await setControlsReturningPrevious({ phone: true });
    try {
      const committee = await makeCommittee();
      const organizer = await makeUser({ admin: { committeeId: committee.id } });
      const event = await publish(organizer.cookie, committee.id, {
        captures: { major_year: false, dietary: false, resume: false, source: false, phone: true, tshirt: false },
        hostQuestions: [{ label: "GitHub handle", type: "short" }],
      });
      const phone = event.questions.find((q) => q.key === "phone")!;
      const hidden = event.questions.find((q) => q.key === "tshirt")!; // visible = false
      const guest = await makeUser();

      const res = await app.inject({
        method: "POST",
        url: `/api/events/${event.shortCode}/register`,
        headers: { cookie: guest.cookie },
        payload: {
          fullName: "Jane Tartan",
          custom: [
            { questionId: phone.id, value: "  4125551234  " },
            { questionId: hidden.id, value: "XL" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const { registrationId } = res.json() as { registrationId: string };
      const answers = await db.select().from(schema.answers).where(eq(schema.answers.registrationId, registrationId));
      expect(answers).toHaveLength(1);
      expect(answers[0].questionId).toBe(phone.id);
      // Stored trimmed — an untrimmed value would fail any later options check.
      expect(String(answers[0].value)).toBe("4125551234");
    } finally {
      // `before` is the PRE-patch snapshot, so this really does put the shared
      // app_settings row back the way the next test file expects to find it.
      await setControlsReturningPrevious({ phone: before.phone });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/register.test.ts
```

Expected: FAIL — the first three cases return `200` instead of `400` (the handler silently drops what it does not understand), and the fourth stores the untrimmed `"  4125551234  "`.

- [ ] **Step 3: Rewrite the validation region**

In `apps/backend/src/routes/router.ts`, replace lines 444-467 (from the `// Validate custom answers…` comment through the end of the resume-ownership check) with:

```ts
      // The global question controls gate the public form (see the events.get
      // handler), so they gate what we accept too — otherwise an organizer could
      // restore collection of a field a super admin switched off club-wide. This
      // read used to happen further down, AFTER the destructive block; it has to
      // be here, because required-enforcement needs it.
      const controls = await getQuestionControls();

      // Everything from here to the destructive block below is validation. A 400
      // returned after that block deletes a returning guest's prior registration
      // and unlinks their ticket with nothing recreated, so nothing below may fail.
      const questions = await db
        .select()
        .from(schema.eventQuestions)
        .where(and(eq(schema.eventQuestions.eventId, event.id), eq(schema.eventQuestions.visible, true)))
        .orderBy(asc(schema.eventQuestions.sort));

      // Fold the payload down first: blanks never occupy a slot, last non-blank
      // wins, and one entry per question satisfies the answers unique index.
      const submitted = new Map<string, string>();
      for (const a of body.custom ?? []) {
        const trimmed = a.value.trim();
        if (trimmed.length > 0) submitted.set(a.questionId, trimmed);
      }

      // Iterate the questions, not the payload: an id that is no longer answerable
      // (hidden, deleted, or another event's) is ignored rather than rejected, so a
      // form left open while the organizer edits the questions still submits.
      const customAnswers: { questionId: string; value: string }[] = [];
      const fileAnswerIds: string[] = [];
      for (const q of questions) {
        if (q.kind !== "custom" && !(q.key && controls[q.key as keyof QuestionControls])) continue;
        // major_year / dietary / resume / source arrive in their own body fields.
        if (q.kind === "standard" && q.key !== "phone" && q.key !== "tshirt") continue;

        const value = submitted.get(q.id);
        if (!value) {
          if (q.required) {
            return { status: 400, body: { error: "answer_required", message: `“${q.label}” is required.` } };
          }
          continue;
        }
        if (q.type === "select" && (q.options ?? []).length > 0 && !(q.options ?? []).includes(value)) {
          return { status: 400, body: { error: "answer_option", message: `Pick one of the listed options for “${q.label}”.` } };
        }
        if (q.type === "file") {
          if (!isUuid(value)) {
            return { status: 400, body: { error: "answer_file", message: `Upload a file for “${q.label}” before submitting.` } };
          }
          // Lower-cased at write time: GET /api/files/:id matches lower-case only,
          // so an upper-case answer would produce an organizer link that 404s.
          const fileId = value.toLowerCase();
          fileAnswerIds.push(fileId);
          customAnswers.push({ questionId: q.id, value: fileId });
          continue;
        }
        customAnswers.push({ questionId: q.id, value });
      }

      // Validate every referenced upload BEFORE any destructive mutation. One
      // projected query covers the resume and all file answers; the old check
      // selected the whole row and dragged a 5 MB bytea into memory to read one
      // column.
      const referenced = [
        ...new Set([...(body.resumeFileId ? [body.resumeFileId.toLowerCase()] : []), ...fileAnswerIds]),
      ];
      if (referenced.length > 0) {
        const owned = await db
          .select({ id: schema.files.id })
          .from(schema.files)
          .where(and(inArray(schema.files.id, referenced), eq(schema.files.ownerUserId, ctx.user.id)));
        if (owned.length !== referenced.length) {
          return { status: 400, body: { error: "bad_file", message: "That upload doesn't belong to you." } };
        }
      }
```

- [ ] **Step 4: Remove the now-duplicate controls read**

Further down the same handler, delete the line `const controls = await getQuestionControls();` (currently line 478, immediately before the `createRegistration` call). The hoisted `const controls` above now serves both uses; leaving both is a redeclaration and will not compile.

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/register.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Read the handler top to bottom and confirm the ordering**

Run: `grep -n "status: 400" apps/backend/src/routes/router.ts | sed -n '1,40p'`

Expected: confirm by eye that no `return { status: 400 … }` exists between the `await db.delete(schema.answers)` line and the `return { status: 200 …}` at the end of the register handler.

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/router.ts apps/backend/src/routes/register.test.ts
git commit -m "Validate signup answers server-side, before anything destructive"
```

---

### Task 6: File answers the organizer can actually open

**Files:**
- Modify: `apps/backend/src/server.ts:8` (import `sql`), `:171-194` (POST /api/files), `:199-227` (GET /api/files/:id)
- Test: `apps/backend/src/files.test.ts`

**Interfaces:**
- Consumes: `startTestServer`, `makeCommittee`, `makeUser`, `multipartUpload` from the harness (Task 2).
- Produces: `POST /api/files?kind=answer` stores `files.kind = "answer"` (anything else stores `"resume"`); `GET /api/files/:id` additionally authorises a committee admin when the id is the value of a `file`-typed answer on one of that committee's events.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/files.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "./db/client";
import { createEventBody, makeCommittee, makeUser, multipartUpload, startTestServer } from "./test/harness";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

async function publishWithQuestion(cookie: string, committeeId: string, question: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/org/events",
    headers: { cookie },
    payload: createEventBody(committeeId, { hostQuestions: [question] }),
  });
  const created = res.json() as { id: string; shortCode: string };
  const questions = await db
    .select()
    .from(schema.eventQuestions)
    .where(eq(schema.eventQuestions.eventId, created.id))
    .orderBy(asc(schema.eventQuestions.sort));
  return { ...created, question: questions.find((q) => q.kind === "custom")! };
}

describe("uploads for question answers", () => {
  it("tags an answer upload so it is distinguishable from a resume", async () => {
    const guest = await makeUser();
    const part = multipartUpload("portfolio.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    const res = await app.inject({
      method: "POST",
      url: "/api/files?kind=answer",
      headers: { cookie: guest.cookie, "content-type": part.contentType },
      payload: part.body,
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: string };
    const rows = await db.select().from(schema.files).where(eq(schema.files.id, id));
    expect(rows[0].kind).toBe("answer");
  });

  it("lets the committee admin who asked the question read the file, and nobody else's", async () => {
    const mine = await makeCommittee();
    const theirs = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: mine.id } });
    const outsider = await makeUser({ admin: { committeeId: theirs.id } });
    const event = await publishWithQuestion(organizer.cookie, mine.id, { label: "Portfolio", type: "file" });

    const guest = await makeUser();
    const part = multipartUpload("portfolio.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    const upload = await app.inject({
      method: "POST",
      url: "/api/files?kind=answer",
      headers: { cookie: guest.cookie, "content-type": part.contentType },
      payload: part.body,
    });
    const fileId = (upload.json() as { id: string }).id;

    const registered = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [{ questionId: event.question.id, value: fileId }] },
    });
    expect(registered.statusCode).toBe(200);

    const asOrganizer = await app.inject({ method: "GET", url: `/api/files/${fileId}`, headers: { cookie: organizer.cookie } });
    expect(asOrganizer.statusCode).toBe(200);

    const asOutsider = await app.inject({ method: "GET", url: `/api/files/${fileId}`, headers: { cookie: outsider.cookie } });
    expect(asOutsider.statusCode).toBe(403);
  });

  it("does not hand out a file just because someone typed its id into a text question", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publishWithQuestion(organizer.cookie, committee.id, { label: "Anything", type: "short" });

    const stranger = await makeUser();
    const strangerFile = (
      await db
        .insert(schema.files)
        .values({
          ownerUserId: stranger.user.id,
          kind: "answer",
          filename: "private.pdf",
          contentType: "application/pdf",
          size: 3,
          data: Buffer.from("pdf"),
        })
        .returning()
    )[0];

    const guest = await makeUser();
    const registered = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [{ questionId: event.question.id, value: strangerFile.id }] },
    });
    expect(registered.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/api/files/${strangerFile.id}`, headers: { cookie: organizer.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("404s a malformed file id instead of 500ing on the uuid cast", async () => {
    const guest = await makeUser();
    const res = await app.inject({ method: "GET", url: `/api/files/${"-".repeat(36)}`, headers: { cookie: guest.cookie } });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/files.test.ts
```

Expected: FAIL — the upload stores `kind: "resume"`, the organizer gets `403` on their own applicant's file, and the 36-dash id 500s.

- [ ] **Step 3: Accept a `kind` on upload**

In `apps/backend/src/server.ts` add `sql` to the drizzle import on line 8:

```ts
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
```

Replace the body of `POST /api/files` (lines 171-194):

```ts
  // Uploads (multipart) — signed-in users only. Resumes and question answers use
  // the same endpoint and the same PDF/Word allowlist; `kind` only records which
  // one it was.
  app.post("/api/files", async (request, reply) => {
    if (!request.authCtx) return reply.status(401).send({ error: "unauthorized", message: "Sign in first." });
    // `kind` rides in the query string rather than a multipart field: @fastify/multipart
    // only exposes fields that arrived BEFORE the file part, so a field-based flag is
    // silently lost by any caller that appends the file first.
    const kind = (request.query as { kind?: string }).kind === "answer" ? "answer" : "resume";
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no_file", message: "Attach a file." });
    if (!RESUME_TYPES.has(file.mimetype)) {
      return reply.status(400).send({ error: "type", message: "PDF or Word documents only." });
    }
    const data = await file.toBuffer();
    if (data.length > MAX_RESUME_BYTES) {
      return reply.status(400).send({ error: "size", message: "Keep it under 5 MB." });
    }
    const inserted = await db
      .insert(schema.files)
      .values({
        ownerUserId: request.authCtx.user.id,
        kind,
        filename: file.filename.slice(0, 200) || (kind === "answer" ? "upload.pdf" : "resume.pdf"),
        contentType: file.mimetype,
        size: data.length,
        data,
      })
      .returning({ id: schema.files.id, filename: schema.files.filename });
    return reply.send({ id: inserted[0].id, filename: inserted[0].filename, url: `${env.apiUrl}/api/files/${inserted[0].id}` });
  });
```

- [ ] **Step 4: Extend the read ACL**

Replace the id guard and the committee-admin branch of `GET /api/files/:id` (lines 202-221):

```ts
    const { id: rawId } = request.params as { id: string };
    // Lower-cased and strictly shaped: the old pattern also matched 36 dashes,
    // which reached Postgres as a uuid cast error and surfaced as a 500.
    const id = rawId.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      return reply.status(404).send({ error: "not_found", message: "No such file." });
    }
    const rows = await db.select().from(schema.files).where(eq(schema.files.id, id));
    const file = rows[0];
    if (!file) return reply.status(404).send({ error: "not_found", message: "No such file." });

    let allowed = file.ownerUserId === ctx.user.id;
    if (!allowed && ctx.admin) {
      if (ctx.admin.row.role === "super_admin") {
        allowed = true;
      } else {
        // Two routes to a committee: the file is the resume on a registration for
        // one of their events, or it is the value of a `file`-typed answer on one.
        const scoped = await db
          .select({ committeeId: schema.events.committeeId })
          .from(schema.registrations)
          .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
          .where(eq(schema.registrations.resumeFileId, id));

        // The type filter is load-bearing: without it, a guest typing a UUID into a
        // plain text question would hand an admin read access to whatever file that
        // UUID names. Pinning the question to the registration's own event and the
        // uploader to the file's owner closes the same hole from the other side.
        // The comparison happens in SQL because the jsonb value is decoded twice on
        // the way into JS and can arrive as a number or an object.
        const viaAnswer = await db
          .select({ committeeId: schema.events.committeeId })
          .from(schema.answers)
          .innerJoin(schema.eventQuestions, eq(schema.answers.questionId, schema.eventQuestions.id))
          .innerJoin(schema.registrations, eq(schema.answers.registrationId, schema.registrations.id))
          .innerJoin(schema.events, eq(schema.registrations.eventId, schema.events.id))
          .where(
            and(
              eq(schema.eventQuestions.type, "file"),
              eq(schema.eventQuestions.eventId, schema.registrations.eventId),
              eq(schema.registrations.userId, file.ownerUserId),
              sql`jsonb_typeof(${schema.answers.value}) = 'string' and ${schema.answers.value} #>> '{}' = ${id}`,
            ),
          );

        allowed = [...scoped, ...viaAnswer].some((r) => r.committeeId === ctx.admin!.row.committeeId);
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/files.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/server.ts apps/backend/src/files.test.ts
git commit -m "Let organizers read the files they asked for"
```

---

### Task 7: The organizer question DTO

**Files:**
- Modify: `packages/contract/src/index.ts:137` (add `OrgEventQuestion`), `:347-348` (retype `OrgEventDetail.questions`)
- Modify: `apps/backend/src/routes/router.ts` (new `orgQuestions` helper; `getEvent` uses it)
- Test: `apps/backend/src/routes/org-questions.test.ts`

**Interfaces:**
- Consumes: the harness (Task 2).
- Produces:
  - `OrgEventQuestion` (zod schema + type) exported from `@scottylabs-invites/contract`: `EventQuestion` plus `visible: boolean`, `sort: number`, `answerCount: number`.
  - `OrgEventDetail.questions: OrgEventQuestion[]`.
  - `orgQuestions(eventId: string): Promise<OrgEventQuestion[]>` — a module-level helper in `apps/backend/src/routes/router.ts`, reused by Task 8.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/routes/org-questions.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/client";
import { createEventBody, makeCommittee, makeUser, startTestServer } from "../test/harness";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

describe("GET /api/org/events/:id — question DTO", () => {
  it("reports visibility, order and how many people have answered", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/org/events",
        headers: { cookie: organizer.cookie },
        payload: createEventBody(committee.id, {
          captures: { major_year: true, dietary: false, resume: false, source: false, phone: false, tshirt: false },
          hostQuestions: [{ label: "GitHub handle", type: "short" }],
        }),
      })
    ).json() as { id: string; shortCode: string };

    const rows = await db
      .select()
      .from(schema.eventQuestions)
      .where(eq(schema.eventQuestions.eventId, created.id))
      .orderBy(asc(schema.eventQuestions.sort));
    const github = rows.find((q) => q.label === "GitHub handle")!;

    const guest = await makeUser();
    const registration = (
      await db
        .insert(schema.registrations)
        .values({ eventId: created.id, userId: guest.user.id, status: "approved", fullName: "Jane Tartan" })
        .returning()
    )[0];
    await db.insert(schema.answers).values({ registrationId: registration.id, questionId: github.id, value: "octocat" });

    const res = await app.inject({ method: "GET", url: `/api/org/events/${created.id}`, headers: { cookie: organizer.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: { key: string | null; label: string; visible: boolean; sort: number; answerCount: number }[] };

    const majorYear = body.questions.find((q) => q.key === "major_year")!;
    const dietary = body.questions.find((q) => q.key === "dietary")!;
    const custom = body.questions.find((q) => q.label === "GitHub handle")!;
    expect(majorYear.visible).toBe(true);
    expect(dietary.visible).toBe(false);
    expect(custom.answerCount).toBe(1);
    expect(majorYear.answerCount).toBe(0);
    expect(body.questions.map((q) => q.sort)).toEqual([...body.questions].map((q) => q.sort).sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: FAIL with `Cannot read properties of undefined (reading 'visible')` — the DTO carries no `visible`, `sort` or `answerCount`.

- [ ] **Step 3: Add the org-only schema**

In `packages/contract/src/index.ts`, directly after the `EventQuestion` export (line 137):

```ts
/**
 * The organizer's view of a question. Three fields the public page must never
 * carry: whether the question is switched on for this event, where it sits, and
 * how many people have already answered it — which is what freezes its type and
 * options. Widening `EventQuestion` itself would leak all three into the public
 * `EventDetail`, so this extends it instead, the same way `deletable` is a
 * server-computed affordance on `OrgEventDetail`.
 */
export const OrgEventQuestion = EventQuestion.extend({
  visible: z.boolean(),
  sort: z.number(),
  answerCount: z.number(),
});
export type OrgEventQuestion = z.infer<typeof OrgEventQuestion>;
```

And retype the field on `OrgEventDetail` (lines 347-348):

```ts
  /** Editable through PUT /api/org/events/:id/questions, not through PATCH. */
  questions: z.array(OrgEventQuestion),
```

- [ ] **Step 4: Build the DTO server-side**

In `apps/backend/src/routes/router.ts`, add `OrgEventQuestion` to the type import from the contract at the top of the file, and add this helper next to `buildGuestRows`:

```ts
/** Every question on an event, in sort order, with the answer count that locks it. */
async function orgQuestions(eventId: string): Promise<OrgEventQuestion[]> {
  const rows = await db
    .select()
    .from(schema.eventQuestions)
    .where(eq(schema.eventQuestions.eventId, eventId))
    .orderBy(asc(schema.eventQuestions.sort));
  if (rows.length === 0) return [];

  const counts = await db
    .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
    .from(schema.answers)
    .where(
      inArray(
        schema.answers.questionId,
        rows.map((q) => q.id),
      ),
    )
    .groupBy(schema.answers.questionId);
  const countById = new Map(counts.map((c) => [c.questionId, c.count]));

  return rows.map((q) => ({
    id: q.id,
    kind: q.kind,
    key: (q.key as OrgEventQuestion["key"]) ?? null,
    label: q.label,
    type: q.type,
    options: q.options ?? null,
    required: q.required,
    visible: q.visible,
    sort: q.sort,
    answerCount: countById.get(q.id) ?? 0,
  }));
}
```

In the `getEvent` handler, delete the local `questions` query (lines 870-874) and the inline `questions.map(...)` in the response (lines 918-926), replacing them with:

```ts
      const questions = await orgQuestions(e.id);
```

and, in the response body:

```ts
          questions,
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors. `EventForm`'s `existingQuestions?: EventQuestion[]` still accepts the widened array.

- [ ] **Step 7: Commit**

```bash
git add packages/contract/src/index.ts apps/backend/src/routes/router.ts apps/backend/src/routes/org-questions.test.ts
git commit -m "Give the organizer screen the question fields it needs"
```

---

### Task 8: `PUT /api/org/events/:id/questions`

**Files:**
- Modify: `packages/contract/src/index.ts` (add `QuestionDraft`, `UpdateQuestionsBody`, the `org.updateQuestions` route)
- Modify: `apps/backend/src/services/registrations.ts:38` (export `lockEvent`)
- Modify: `apps/backend/src/routes/router.ts` (new `updateQuestions` handler, after `updateEvent`)
- Test: `apps/backend/src/routes/org-questions.test.ts` (append)

**Interfaces:**
- Consumes: `orgQuestions(eventId)` and `OrgEventQuestion` (Task 7); `MAX_CUSTOM_QUESTIONS` (Task 2); `getQuestionControls()` from `apps/backend/src/services/settings.ts`.
- Produces:
  - `QuestionDraft` = `{ id?: string (uuid); label: string; type: QuestionType; options?: string[] | null; required: boolean; visible: boolean }` — `id` absent means "create this one".
  - `UpdateQuestionsBody` = `{ questions: QuestionDraft[] }`, max 40 entries.
  - Route `org.updateQuestions`: `PUT /api/org/events/:id/questions` → `200 { ok: true, questions: OrgEventQuestion[] }`, or `400` (`unknown_question`, `missing_standard`, `too_many`, `options`, `globally_off`) / `401` / `403` / `404` / `409` (`locked`).
  - `lockEvent(tx, eventId)` exported from `apps/backend/src/services/registrations.ts`.

**Decision recorded here because the spec and the area reports disagreed:** an attempt to change the `type` or `options` of a question that already has answers returns **409 `locked`** (the approved spec's table), not 400. `409: ErrorBody` is declared explicitly on this route; no other org route declares it.

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/src/routes/org-questions.test.ts`:

```ts
type Draft = {
  id?: string;
  label: string;
  type: string;
  options?: string[] | null;
  required: boolean;
  visible: boolean;
};

/** Turn the GET payload straight back into a PUT payload — what the edit screen does. */
function draftsOf(questions: { id: string; label: string; type: string; options: string[] | null; required: boolean; visible: boolean }[]): Draft[] {
  return questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required, visible: q.visible }));
}

describe("PUT /api/org/events/:id/questions", () => {
  async function setup(hostQuestions: Record<string, unknown>[] = [{ label: "GitHub handle", type: "short" }]) {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/org/events",
        headers: { cookie: organizer.cookie },
        payload: createEventBody(committee.id, { hostQuestions }),
      })
    ).json() as { id: string; shortCode: string };
    const detail = (
      await app.inject({ method: "GET", url: `/api/org/events/${created.id}`, headers: { cookie: organizer.cookie } })
    ).json() as { questions: Parameters<typeof draftsOf>[0] };
    return { committee, organizer, event: created, questions: detail.questions };
  }

  const put = (cookie: string, id: string, questions: Draft[]) =>
    app.inject({ method: "PUT", url: `/api/org/events/${id}/questions`, headers: { cookie }, payload: { questions } });

  it("renames, reorders, requires and adds — and hands back the server ids", async () => {
    const { organizer, event, questions } = await setup();
    const drafts = draftsOf(questions);
    const github = drafts.find((d) => d.label === "GitHub handle")!;
    github.label = "GitHub username";
    github.required = true;
    drafts.push({ label: "Team size", type: "short", required: false, visible: true });

    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; questions: { id: string; label: string; required: boolean; sort: number }[] };
    const renamed = body.questions.find((q) => q.label === "GitHub username")!;
    const added = body.questions.find((q) => q.label === "Team size")!;
    expect(renamed.required).toBe(true);
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.sort).toBeGreaterThan(renamed.sort);
  });

  it("hides an answered question instead of deleting it, and keeps the answers", async () => {
    const { organizer, event, questions } = await setup();
    const github = questions.find((q) => q.label === "GitHub handle")!;
    const guest = await makeUser();
    const registration = (
      await db
        .insert(schema.registrations)
        .values({ eventId: event.id, userId: guest.user.id, status: "approved", fullName: "Jane Tartan" })
        .returning()
    )[0];
    await db.insert(schema.answers).values({ registrationId: registration.id, questionId: github.id, value: "octocat" });

    const res = await put(organizer.cookie, event.id, draftsOf(questions).filter((d) => d.label !== "GitHub handle"));
    expect(res.statusCode).toBe(200);

    const row = (await db.select().from(schema.eventQuestions).where(eq(schema.eventQuestions.id, github.id)))[0];
    expect(row.visible).toBe(false);
    const answers = await db.select().from(schema.answers).where(eq(schema.answers.questionId, github.id));
    expect(answers).toHaveLength(1);
  });

  it("really deletes an unanswered question", async () => {
    const { organizer, event, questions } = await setup();
    const github = questions.find((q) => q.label === "GitHub handle")!;
    const res = await put(organizer.cookie, event.id, draftsOf(questions).filter((d) => d.label !== "GitHub handle"));
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(schema.eventQuestions).where(eq(schema.eventQuestions.id, github.id));
    expect(rows).toHaveLength(0);
  });

  it("409s a type change once people have answered", async () => {
    const { organizer, event, questions } = await setup();
    const github = questions.find((q) => q.label === "GitHub handle")!;
    const guest = await makeUser();
    const registration = (
      await db
        .insert(schema.registrations)
        .values({ eventId: event.id, userId: guest.user.id, status: "approved", fullName: "Jane Tartan" })
        .returning()
    )[0];
    await db.insert(schema.answers).values({ registrationId: registration.id, questionId: github.id, value: "octocat" });

    const drafts = draftsOf(questions);
    drafts.find((d) => d.id === github.id)!.type = "long";
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "locked" });
  });

  it("refuses a payload that drops a standard row", async () => {
    const { organizer, event, questions } = await setup();
    const res = await put(organizer.cookie, event.id, draftsOf(questions).filter((d) => d.label !== "Phone number"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_standard" });
  });

  it("refuses to switch on a standard field the club has disabled", async () => {
    const { organizer, event, questions } = await setup();
    const drafts = draftsOf(questions);
    // phone is off club-wide by default (services/settings.ts DEFAULT_CONTROLS).
    drafts.find((d) => d.label === "Phone number")!.visible = true;
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "globally_off" });
  });

  it("refuses a select with no options", async () => {
    const { organizer, event, questions } = await setup();
    const drafts = draftsOf(questions);
    const github = drafts.find((d) => d.label === "GitHub handle")!;
    github.type = "select";
    github.options = [];
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "options" });
  });

  it("is committee-scoped", async () => {
    const { event, questions } = await setup();
    const other = await makeCommittee();
    const outsider = await makeUser({ admin: { committeeId: other.id } });
    const res = await put(outsider.cookie, event.id, draftsOf(questions));
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: FAIL — every PUT returns `404` because the route does not exist.

- [ ] **Step 3: Add the contract route**

In `packages/contract/src/index.ts`, after `UpdateEventBody` (line 462):

```ts
/** One row of the organizer's question list. `id` absent means "create this one". */
export const QuestionDraft = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(300),
  type: QuestionType,
  options: z.array(z.string().min(1).max(120)).max(20).nullable().optional(),
  required: z.boolean(),
  visible: z.boolean(),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

/** The full desired list. The server reconciles it against what exists. */
export const UpdateQuestionsBody = z.object({ questions: z.array(QuestionDraft).max(40) });
export type UpdateQuestionsBody = z.infer<typeof UpdateQuestionsBody>;
```

And in the `org` block of the contract, immediately after `updateEvent` (line 676):

```ts
      updateQuestions: {
        method: "PUT",
        path: "/api/org/events/:id/questions",
        body: UpdateQuestionsBody,
        responses: {
          200: z.object({ ok: z.literal(true), questions: z.array(OrgEventQuestion) }),
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
        },
        summary: "Replace an event's question set without destroying answers",
      },
```

- [ ] **Step 4: Export the advisory lock**

In `apps/backend/src/services/registrations.ts`, line 38:

```ts
/** Serializes capacity/numbering decisions per event. Must be called inside a transaction. */
export async function lockEvent(tx: Tx, eventId: string): Promise<void> {
```

- [ ] **Step 5: Implement the handler**

In `apps/backend/src/routes/router.ts`, add `lockEvent` to the import from `../services/registrations` and `MAX_CUSTOM_QUESTIONS` to the contract import, then add this handler in the `org` block immediately after `updateEvent`:

```ts
    updateQuestions: async ({ params, body, request }) => {
      const ctx = ctxOf(request);
      if (!ctx) return unauthorized;
      if (!ctx.admin) return forbidden;
      const scoped = await loadScopedEvent(ctx, params.id);
      if (scoped === null) return { status: 404, body: { error: "not_found", message: "Event not found" } };
      if (scoped === "forbidden") return forbidden;

      const existing = await db
        .select()
        .from(schema.eventQuestions)
        .where(eq(schema.eventQuestions.eventId, params.id))
        .orderBy(asc(schema.eventQuestions.sort));
      const existingById = new Map(existing.map((q) => [q.id, q]));

      const counts = existing.length
        ? await db
            .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
            .from(schema.answers)
            .where(
              inArray(
                schema.answers.questionId,
                existing.map((q) => q.id),
              ),
            )
            .groupBy(schema.answers.questionId)
        : [];
      // Every answer counts, including a cancelled registration's — those rows
      // survive until the guest re-registers. This snapshot is good enough to
      // REJECT with (a stale 409 just asks the organizer to reload); it is NOT
      // good enough to DELETE with. The apply phase re-reads it under the lock.
      const answered = new Map(counts.map((c) => [c.questionId, c.count]));
      const controls = await getQuestionControls();
      const trim = (options: string[] | null | undefined) => (options ?? []).map((o) => o.trim()).filter(Boolean);

      // ---- validate the whole payload before mutating anything ----------------
      const seen = new Set<string>();
      for (const draft of body.questions) {
        if (!draft.id) continue;
        if (!existingById.has(draft.id) || seen.has(draft.id)) {
          return {
            status: 400,
            body: { error: "unknown_question", message: "That list doesn't match this event's questions any more — reload the page and try again." },
          };
        }
        seen.add(draft.id);
      }
      for (const row of existing) {
        // A payload of custom rows only would otherwise hide or delete all six
        // standard rows and cascade away every phone and t-shirt answer.
        if (row.kind === "standard" && !seen.has(row.id)) {
          return {
            status: 400,
            body: { error: "missing_standard", message: "The standard fields can be switched off but not removed — reload the page and try again." },
          };
        }
      }
      const customCount = body.questions.filter((d) => !d.id || existingById.get(d.id)?.kind === "custom").length;
      if (customCount > MAX_CUSTOM_QUESTIONS) {
        return {
          status: 400,
          body: { error: "too_many", message: `That's ${customCount} questions — a signup form carries at most ${MAX_CUSTOM_QUESTIONS}.` },
        };
      }
      for (const draft of body.questions) {
        const row = draft.id ? existingById.get(draft.id)! : null;
        if (row?.kind === "standard") {
          // A standard field's label, type and options are ours, not the
          // organizer's — only `visible` and position come from the payload. And a
          // key the super admin disabled club-wide cannot be switched back on here,
          // or "off everywhere" would mean nothing.
          if (draft.visible && !row.visible && row.key && !controls[row.key as keyof QuestionControls]) {
            return {
              status: 400,
              body: { error: "globally_off", message: `“${row.label}” is switched off for the whole club — a super admin has to turn it back on first.` },
            };
          }
          continue;
        }
        const options = trim(draft.options);
        if (draft.type === "select" && options.length === 0) {
          return { status: 400, body: { error: "options", message: `Add at least one option to “${draft.label}”, or change it to short text.` } };
        }
        const n = row ? (answered.get(row.id) ?? 0) : 0;
        if (n > 0 && (row!.type !== draft.type || JSON.stringify(trim(row!.options)) !== JSON.stringify(options))) {
          return {
            status: 409,
            body: {
              error: "locked",
              message: `“${row!.label}” already has ${n} answer${n === 1 ? "" : "s"} — you can't change its type or options once people have answered.`,
            },
          };
        }
      }

      // ---- apply --------------------------------------------------------------
      await db.transaction(async (tx) => {
        // The same lock registrations take (createRegistration calls this inside
        // its own transaction). Everything the apply phase decides is re-read HERE,
        // inside the lock: the reads above happened before it, and a signup that
        // commits in between is invisible to them. Delete on a stale zero-answer
        // count and answers.question_id's ON DELETE CASCADE destroys that guest's
        // answer with no trace. Rejections may run on the stale snapshot; deletes
        // may not.
        await lockEvent(tx, params.id);

        const live = await tx
          .select()
          .from(schema.eventQuestions)
          .where(eq(schema.eventQuestions.eventId, params.id))
          .orderBy(asc(schema.eventQuestions.sort));
        const liveById = new Map(live.map((q) => [q.id, q]));
        const liveCounts = live.length
          ? await tx
              .select({ questionId: schema.answers.questionId, count: sql<number>`count(*)::int` })
              .from(schema.answers)
              .where(
                inArray(
                  schema.answers.questionId,
                  live.map((q) => q.id),
                ),
              )
              .groupBy(schema.answers.questionId)
          : [];
        const liveAnswered = new Map(liveCounts.map((c) => [c.questionId, c.count]));

        for (const [i, draft] of body.questions.entries()) {
          const row = draft.id ? (liveById.get(draft.id) ?? null) : null;
          // The row was deleted by a concurrent save between the validation read
          // and this lock. Do not resurrect it — an id we no longer have is not
          // ours to re-create.
          if (draft.id && !row) continue;
          if (!row) {
            await tx.insert(schema.eventQuestions).values({
              eventId: params.id,
              kind: "custom",
              key: null,
              label: draft.label,
              type: draft.type,
              options: draft.type === "select" ? trim(draft.options) : null,
              required: draft.required,
              visible: draft.visible,
              sort: i,
            });
            continue;
          }
          if (row.kind === "standard") {
            await tx.update(schema.eventQuestions).set({ visible: draft.visible, sort: i }).where(eq(schema.eventQuestions.id, row.id));
            continue;
          }
          await tx
            .update(schema.eventQuestions)
            .set({
              label: draft.label,
              type: draft.type,
              options: draft.type === "select" ? trim(draft.options) : null,
              required: draft.required,
              visible: draft.visible,
              sort: i,
            })
            .where(eq(schema.eventQuestions.id, row.id));
        }

        // A custom question the organizer dropped. Deleting cascades its answers,
        // so that is only safe at zero; otherwise hide it, which keeps the answers
        // and keeps its CSV column. Retired rows sort after everything live.
        //
        // `live` and `liveAnswered`, not `existing` and `answered`: this is the
        // decision the lock exists to protect, so it reads the state the lock is
        // holding. `seen` is derived from the payload, so it needs no re-read.
        let tail = body.questions.length;
        for (const row of live) {
          if (row.kind !== "custom" || seen.has(row.id)) continue;
          if ((liveAnswered.get(row.id) ?? 0) > 0) {
            await tx.update(schema.eventQuestions).set({ visible: false, sort: tail++ }).where(eq(schema.eventQuestions.id, row.id));
          } else {
            await tx.delete(schema.eventQuestions).where(eq(schema.eventQuestions.id, row.id));
          }
        }
      });

      // Hand the refreshed list back so the builder can write the new rows' server
      // ids into its own state — without them a second save re-creates them.
      return { status: 200, body: { ok: true, questions: await orgQuestions(params.id) } };
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: PASS — 9 tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors. The web client picks the route up automatically as `api.org.updateQuestions({ params: { id }, body })`.

- [ ] **Step 8: Commit**

```bash
git add packages/contract/src/index.ts apps/backend/src/routes/router.ts apps/backend/src/services/registrations.ts apps/backend/src/routes/org-questions.test.ts
git commit -m "Add answer-safe question editing after publish"
```

---

### Task 9: Editing questions from the edit screen

**Files:**
- Modify: `apps/web/src/components/EventForm.tsx` (`toDraftQuestion`, `MAX_CUSTOM_QUESTIONS` re-export, the capture card in edit mode, drop `existingQuestions`, add `questionsActions`)
- Modify: `apps/web/src/pages/EditEventPage.tsx:18-42` (`toFormValues`), `:75-118` (add the questions mutation), `:214-222` (props)
- Modify: `apps/web/src/pages/AdminPage.tsx:205-207` (the global-controls copy)

**Interfaces:**
- Consumes: `OrgEventQuestion` (Task 7); `api.org.updateQuestions` (Task 8); `QuestionsCard`, `DraftQuestion`, `validateQuestions`, `validateEventForm(v, opts)` (Task 3).
- Produces: `toDraftQuestion(q: OrgEventQuestion, index: number): DraftQuestion`, exported from `apps/web/src/components/EventForm.tsx`.

**Decision recorded here:** in edit mode the "Data to capture" toggles write `visible` on the event's own standard `DraftQuestion` rows. `EventFormValues.captures` is create-only and is not derived from the server at all — one representation of visibility, not two that can drift.

- [ ] **Step 1: Map a server question to a draft**

In `apps/web/src/components/EventForm.tsx`, add `OrgEventQuestion` to the contract type import (leave `EventQuestion` alone for now — Step 2 deletes it together with the prop that still uses it), re-export the cap, and add the mapper next to `blankQuestion`:

```tsx
export { MAX_CUSTOM_QUESTIONS } from "@scottylabs-invites/contract";

/** A server question becomes a builder row. `id` is positional and local only. */
export function toDraftQuestion(q: OrgEventQuestion, index: number): DraftQuestion {
  return {
    id: index + 1,
    qid: q.id,
    kind: q.kind,
    key: q.key,
    text: q.label,
    type: q.type,
    options: q.options ?? [],
    required: q.required,
    visible: q.visible,
    answerCount: q.answerCount,
  };
}
```

- [ ] **Step 2: Replace the read-only card with the builder**

In `apps/web/src/components/EventForm.tsx`:

- Delete the `existingQuestions?: EventQuestion[]` prop from `EventFormProps` (line 134) and from the destructured parameter list (line 157), and add `questionsActions?: React.ReactNode` with the comment `/** Edit mode: the Save questions button, which posts to its own endpoint. */`.
- In the **same** edit, delete `EventQuestion` from the contract type import at the top of the file. That prop was its last use in `apps/web`; `OrgEventQuestion` (Step 1) replaces it.
- Replace the whole `isEdit ? … : …` conditional — both branches: the read-only "Signup questions" card, and the "Data to capture" card plus the one-line `<QuestionsCard … />` Task 3 left in the create branch. (Task 3 already collapsed the old 366-413 card, so go by the shape of the ternary, not by the original line numbers.) The replacement renders one capture card and one builder for both modes:

```tsx
        <Card
          title="Data to capture"
          sub={
            isEdit
              ? "Switching one off hides it from the signup form immediately. Answers already collected are kept."
              : "Andrew ID and name come free with andrew sign-in. Ask only for what this event needs."
          }
        >
          <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)", opacity: 0.65 }}>
              <Switch on />
              <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>Andrew ID + name</span>
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>always on</span>
            </div>

            {isEdit
              ? // Edit mode reads the event's OWN standard rows, not the global
                // control list: a key the super admin has since switched off
                // club-wide still shows here, disabled, so the organizer can see
                // why the field vanished instead of it silently disappearing.
                v.questions
                  .filter((q) => q.kind === "standard")
                  .map((q) => {
                    const globallyOff = !!q.key && !!controls && !controls[q.key];
                    return (
                      <button
                        key={q.id}
                        disabled={globallyOff}
                        onClick={() =>
                          set(
                            "questions",
                            v.questions.map((x) => (x.id === q.id ? { ...x, visible: !x.visible } : x)),
                          )
                        }
                        style={{ all: "unset", cursor: globallyOff ? "default" : "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)", opacity: globallyOff ? 0.55 : 1 }}
                      >
                        <Switch on={q.visible && !globallyOff} />
                        <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{q.text}</span>
                        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>
                          {globallyOff
                            ? "off club-wide"
                            : q.answerCount > 0
                              ? `${q.answerCount} ${q.answerCount === 1 ? "answer" : "answers"}`
                              : "standard field"}
                        </span>
                      </button>
                    );
                  })
              : captureDefs.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => set("captures", { ...v.captures, [c.key]: !v.captures[c.key] })}
                    style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)" }}
                  >
                    <Switch on={!!v.captures[c.key]} />
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{c.label}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>{c.note}</span>
                  </button>
                ))}
          </div>
        </Card>

        <QuestionsCard
          questions={v.questions}
          onChange={(next) => set("questions", next)}
          isEdit={isEdit}
          actions={questionsActions}
        />
```

- [ ] **Step 3: Derive the form's questions from the server event**

In `apps/web/src/pages/EditEventPage.tsx`, extend the imports and rewrite `toFormValues` (lines 18-42):

```tsx
import EventForm, {
  Card,
  MAX_CUSTOM_QUESTIONS,
  asCategory,
  emptyEventForm,
  toDraftQuestion,
  validateEventForm,
  validateQuestions,
  type EventFormValues,
} from "../components/EventForm";
```

```tsx
function toFormValues(e: OrgEventDetail): EventFormValues {
  const start = utcToNyWallClock(e.startAt);
  const end = utcToNyWallClock(e.endAt);
  return {
    ...emptyEventForm(e.committee.id),
    category: e.category,
    title: e.title,
    description: e.description,
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    location: e.location,
    audience: e.audience,
    model: e.model,
    capacity: e.capacity !== null ? String(e.capacity) : "40",
    updatesEmail: e.updatesEmail,
    contactEmail: e.contactEmail,
    digest: e.digest,
    artwork: e.artwork,
    passStyle: e.passStyle,
    stampCommittee: e.stampCommittee,
    flagship: e.flagship,
    allowPlusOne: e.allowPlusOne,
    // Without this the edit screen inherits emptyEventForm's placeholders — one
    // blank question and the create-time capture defaults — which is harmless
    // while the card is read-only and destroys the real question set the moment
    // it is not. `captures` stays untouched: in edit mode the standard rows'
    // `visible` flags are the only source of truth.
    questions: e.questions.map(toDraftQuestion),
  };
}
```

- [ ] **Step 4: Add the questions mutation**

In `apps/web/src/pages/EditEventPage.tsx`, add state and a mutation next to `save`:

```tsx
  const [questionsSaved, setQuestionsSaved] = useState(false);

  const saveQuestions = useMutation({
    mutationFn: async (v: EventFormValues) => {
      const problem = validateQuestions(v.questions, MAX_CUSTOM_QUESTIONS);
      if (problem) throw new Error(problem);
      return unwrap(
        await api.org.updateQuestions({
          params: { id },
          body: {
            questions: v.questions
              .filter((q) => q.kind === "standard" || q.text.trim())
              .map((q) => ({
                id: q.qid ?? undefined,
                label: q.text.trim(),
                type: q.type,
                options: q.type === "select" ? q.options.map((o) => o.trim()).filter(Boolean) : undefined,
                required: q.required,
                visible: q.visible,
              })),
          },
        }),
        200,
      );
    },
    onSuccess: async (data) => {
      setError(null);
      // The prefill effect is keyed on the event id, so a refetch does NOT re-seed
      // this form. Write the server's ids back by hand, or the rows just created
      // still carry qid: null and a second save duplicates every one of them.
      setValues((cur) => (cur ? { ...cur, questions: data.questions.map(toDraftQuestion) } : cur));
      setQuestionsSaved(true);
      setTimeout(() => setQuestionsSaved(false), 2400);
      await qc.invalidateQueries({ queryKey: ["orgEvent", id] });
      void qc.invalidateQueries({ queryKey: ["dashboard", id] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (e: Error) => setError(e.message),
  });
```

Change the scalar `save` mutation's validation call so a published event carrying more than ten questions cannot block a title edit:

```tsx
      const problem = validateEventForm(v, { maxCustomQuestions: MAX_CUSTOM_QUESTIONS });
```

That is the only question rule `save` enforces, by design (Task 3, Step 3): `PATCH /api/org/events/:id` cannot carry questions at all, and the per-row rules — a select needs an option, a label fits in 300 characters — run in `saveQuestions` above, which is the mutation that actually sends them. Wiring the per-row rules into `save` would refuse a title edit on every event whose selects were created before this feature and therefore have no options.

- [ ] **Step 5: Wire the props**

In `apps/web/src/pages/EditEventPage.tsx`, delete `existingQuestions={event.questions}` from the `<EventForm>` props (line 222) and add:

```tsx
          questionsActions={
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
              <button
                className="pill pill-blue"
                style={{ fontSize: 13, padding: "9px 20px" }}
                disabled={saveQuestions.isPending}
                onClick={() => {
                  setError(null);
                  saveQuestions.mutate(values);
                }}
              >
                {saveQuestions.isPending ? "Saving…" : "Save questions"}
              </button>
              <span style={{ fontSize: 11.5, color: "var(--muted-3)", flex: "1 1 220px", lineHeight: 1.5 }}>
                {questionsSaved
                  ? "Questions saved — the signup form updated immediately."
                  : "Questions save on their own, separately from Save changes."}
              </span>
            </div>
          }
```

- [ ] **Step 6: Correct the super-admin copy**

In `apps/web/src/pages/AdminPage.tsx`, replace the sub-line at lines 205-207:

```tsx
                <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>
                  The standard fields event admins can offer. Turning one off hides it everywhere at once — new events can't add it, live
                  events stop collecting it, and organizers can't switch it back on for their own event.
                </div>
```

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors. Step 2 already removed `EventQuestion` along with the prop that used it, so nothing should be reported as missing or unused.

- [ ] **Step 8: Manual QA**

Open `/organize/<id>/edit` for the event created in Task 4's QA.

- [ ] The "Data to capture" card shows the event's real standard fields with the switches in the state you published them in — not the create-time defaults.
- [ ] The "Your questions" card shows your real host questions with their real types, options and Required states.
- [ ] Rename a question that has no answers, reorder two rows, click **Save questions** — the confirmation appears, and reloading the page shows the new order and wording.
- [ ] Click **Save questions** a second time without reloading — the question count stays the same (no duplicates), proving the server ids were written back.
- [ ] Switch **Dietary restrictions** off and save; open the public event page — the chips are gone.
- [ ] Sign up as a guest answering the select question, return to the edit screen: that row now shows a lock line, its type dropdown and options editor are disabled, and its X is labelled "Hide question".
- [ ] Delete that answered question and save — it leaves the live list and the guest form, and reappears under **Hidden — answers kept** with its answer count. `select visible from event_questions where id = '…'` is `f` and its answers still exist.
- [ ] Reload the page. The question is still in the Hidden list, not back in the live one — that is `visible` driving the builder rather than row existence.
- [ ] Click **Show again** on it and save — it returns to the live list, the guest form asks it again, and the answers already collected are still attached to it.
- [ ] As a super admin, switch **T-shirt size** off in `/admin`, then reload the edit screen — the T-shirt row is greyed with "off club-wide" and cannot be toggled.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/EventForm.tsx apps/web/src/pages/EditEventPage.tsx apps/web/src/pages/AdminPage.tsx
git commit -m "Edit questions after publish from the edit screen"
```

---

### Task 10: Hiding a field actually stops collecting it

**Files:**
- Modify: `apps/backend/src/routes/router.ts:479-490` (the `createRegistration` call in the register handler)
- Test: `apps/backend/src/routes/register.test.ts` (append)

**Interfaces:**
- Consumes: the `questions` and `controls` locals hoisted in Task 5; the harness (Task 2).
- Produces: no new symbols. Behaviour: `major`, `classYear`, `dietary`, `resumeFileId` and `source` are stored only when the global control **and** the event's own question row both allow it.

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/src/routes/register.test.ts`:

```ts
describe("POST /api/events/:code/register — the four standard values", () => {
  it("stores nothing for a standard field this event does not ask for", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      // Every capture off: the rows exist but are invisible.
      captures: { major_year: false, dietary: false, resume: false, source: false, phone: false, tshirt: false },
    });
    const guest = await makeUser();
    const own = (
      await db
        .insert(schema.files)
        .values({
          ownerUserId: guest.user.id,
          kind: "resume",
          filename: "cv.pdf",
          contentType: "application/pdf",
          size: 3,
          data: Buffer.from("pdf"),
        })
        .returning()
    )[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: {
        fullName: "Jane Tartan",
        major: "Computer Science",
        classYear: "2027",
        dietary: ["Vegan"],
        resumeFileId: own.id,
        source: "Slack",
      },
    });
    expect(res.statusCode).toBe(200);

    const { registrationId } = res.json() as { registrationId: string };
    const row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationId)))[0];
    expect(row.major).toBeNull();
    expect(row.classYear).toBeNull();
    expect(row.dietary).toEqual([]);
    expect(row.resumeFileId).toBeNull();
    expect(row.source).toBeNull();
  });

  it("stores them when the event does ask", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      captures: { major_year: true, dietary: true, resume: false, source: true, phone: false, tshirt: false },
    });
    const guest = await makeUser();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", major: "Computer Science", classYear: "2027", dietary: ["Vegan"], source: "Slack" },
    });
    expect(res.statusCode).toBe(200);

    const { registrationId } = res.json() as { registrationId: string };
    const row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationId)))[0];
    expect(row.major).toBe("Computer Science");
    expect(row.dietary).toEqual(["Vegan"]);
    expect(row.source).toBe("Slack");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/register.test.ts
```

Expected: FAIL — the first case stores `major = "Computer Science"`, `dietary = ["Vegan"]`, `source = "Slack"` and the resume id, because those five are gated on the global controls only.

- [ ] **Step 3: Gate on the event's own rows too**

In `apps/backend/src/routes/router.ts`, just above the `createRegistration` call in the register handler:

```ts
      /**
       * The global controls say what the club collects at all; the event's own
       * question rows say what THIS event collects. A value has to clear both, or
       * an organizer's "hide Resume upload" toggle would stop the field rendering
       * while the server carried on storing resume_file_id — a switch labelled
       * hide that keeps collecting. `questions` is already filtered to visible
       * rows, so presence is the test.
       */
      const asks = (key: keyof QuestionControls) => controls[key] && questions.some((q) => q.key === key);
```

and change the call's five gated fields:

```ts
      const outcome = await createRegistration({
        event,
        user: ctx.user,
        fullName: body.fullName,
        major: asks("major_year") ? (body.major ?? null) : null,
        classYear: asks("major_year") ? (body.classYear ?? null) : null,
        dietary: asks("dietary") ? (body.dietary ?? []) : [],
        // Lower-cased for the same reason file answers are: the organizer's
        // download link has to match a route that only accepts lower-case ids.
        resumeFileId: asks("resume") ? (body.resumeFileId?.toLowerCase() ?? null) : null,
        source: asks("source") ? (body.source ?? null) : null,
        plusOne: body.plusOne ?? false,
        customAnswers,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/register.test.ts
```

Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/router.ts apps/backend/src/routes/register.test.ts
git commit -m "Stop storing standard values an event no longer asks for"
```

---

### Task 11: Every answer, on the dashboard

**Files:**
- Modify: `apps/backend/src/lib/answers.ts` (add `loadAnswers`)
- Modify: `packages/contract/src/index.ts:265-293` (`GuestAnswer`, `GuestRow.answers`, drop `PendingItem.answer`), `:357-372` (`Dashboard.event.questions`)
- Modify: `apps/backend/src/routes/router.ts` (`buildGuestRows`, the `dashboard` handler)
- Modify: `apps/web/src/pages/OrganizePage.tsx:310-373` (guest table), `:393-410` (pending cards)

**Interfaces:**
- Consumes: `answerText` (Task 1).
- Produces:
  - `loadAnswers(registrationIds: string[]): Promise<Map<string, LoadedAnswer[]>>` from `apps/backend/src/lib/answers.ts`, where `LoadedAnswer = { registrationId: string; questionId: string; label: string; type: string; value: string; fileUrl: string | null; fileName: string | null }`, keyed by registration id, each list in question `sort` order.
  - `GuestAnswer` = `{ questionId: string; value: string; fileUrl: string | null; fileName: string | null }` in the contract.
  - `GuestRow.answers: GuestAnswer[]`; `Dashboard.event.questions: EventQuestion[]`; `PendingItem.answer` **removed**.

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/src/routes/org-questions.test.ts`:

```ts
describe("GET /api/org/events/:id/dashboard — answers", () => {
  it("carries every answer on the guest row, including phone, and repeats none on the pending card", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/org/events",
        headers: { cookie: organizer.cookie },
        payload: createEventBody(committee.id, {
          model: "approval",
          hostQuestions: [
            { label: "GitHub handle", type: "short" },
            { label: "Why this event?", type: "long" },
          ],
        }),
      })
    ).json() as { id: string; shortCode: string };

    const rows = await db
      .select()
      .from(schema.eventQuestions)
      .where(eq(schema.eventQuestions.eventId, created.id))
      .orderBy(asc(schema.eventQuestions.sort));
    const github = rows.find((q) => q.label === "GitHub handle")!;
    const why = rows.find((q) => q.label === "Why this event?")!;

    const guest = await makeUser();
    const registered = await app.inject({
      method: "POST",
      url: `/api/events/${created.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: {
        fullName: "Jane Tartan",
        custom: [
          { questionId: github.id, value: "octocat" },
          { questionId: why.id, value: "I want to learn." },
        ],
      },
    });
    expect(registered.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/api/org/events/${created.id}/dashboard`, headers: { cookie: organizer.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      event: { questions: { id: string; label: string }[] };
      guests: { registrationId: string; answers: { questionId: string; value: string }[] }[];
      pending: Record<string, unknown>[];
    };

    expect(body.guests[0].answers.map((a) => a.value)).toEqual(["octocat", "I want to learn."]);
    expect(body.event.questions.some((q) => q.label === "Why this event?")).toBe(true);
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).not.toHaveProperty("answer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: FAIL — `body.guests[0].answers` is `undefined`.

- [ ] **Step 3: Add the answer loader**

`apps/backend/src/lib/answers.ts` has had no imports until now. Put these three at the **top** of the file, above the `answerText` doc comment — do not append them at the bottom next to the code that uses them:

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
```

Then append the loader below `answerText`:

```ts
export interface LoadedAnswer {
  registrationId: string;
  questionId: string;
  label: string;
  type: string;
  value: string;
  /** Set only for a file question whose value really names a file we hold. */
  fileUrl: string | null;
  fileName: string | null;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Every answer for a set of registrations, in the order the guest saw the
 * questions. Hidden questions are deliberately NOT filtered out: an answer only
 * exists because the question was live when it was given, and hiding a question
 * must never erase what it already collected.
 */
export async function loadAnswers(registrationIds: string[]): Promise<Map<string, LoadedAnswer[]>> {
  const byRegistration = new Map<string, LoadedAnswer[]>();
  if (registrationIds.length === 0) return byRegistration;

  const rows = await db
    .select({
      registrationId: schema.answers.registrationId,
      questionId: schema.answers.questionId,
      value: schema.answers.value,
      label: schema.eventQuestions.label,
      type: schema.eventQuestions.type,
    })
    .from(schema.answers)
    .innerJoin(schema.eventQuestions, eq(schema.answers.questionId, schema.eventQuestions.id))
    .where(inArray(schema.answers.registrationId, registrationIds))
    .orderBy(asc(schema.eventQuestions.sort));

  const fileIds = [
    ...new Set(
      rows
        .filter((r) => r.type === "file")
        .map((r) => answerText(r.value).toLowerCase())
        .filter((v) => FILE_ID.test(v)),
    ),
  ];
  const files = fileIds.length
    ? await db.select({ id: schema.files.id, filename: schema.files.filename }).from(schema.files).where(inArray(schema.files.id, fileIds))
    : [];
  const fileById = new Map(files.map((f) => [f.id, f]));

  for (const r of rows) {
    const value = answerText(r.value);
    // A file-typed question that predates the uploader holds arbitrary free text,
    // so only rewrite to a link when the value names a file that exists.
    const file = r.type === "file" ? fileById.get(value.toLowerCase()) : undefined;
    const list = byRegistration.get(r.registrationId) ?? [];
    list.push({
      registrationId: r.registrationId,
      questionId: r.questionId,
      label: r.label,
      type: r.type,
      value,
      fileUrl: file ? `${env.apiUrl}/api/files/${file.id}` : null,
      fileName: file?.filename ?? null,
    });
    byRegistration.set(r.registrationId, list);
  }
  return byRegistration;
}
```

- [ ] **Step 4: Change the contract**

In `packages/contract/src/index.ts`, above `GuestRow` (line 265):

```ts
export const GuestAnswer = z.object({
  questionId: z.string(),
  /** Already normalized from jsonb. Long answers are truncated — the CSV is complete. */
  value: z.string(),
  fileUrl: z.string().nullable(),
  fileName: z.string().nullable(),
});
export type GuestAnswer = z.infer<typeof GuestAnswer>;
```

Add the field to `GuestRow` after `createdAt` (line 281):

```ts
  createdAt: z.string(),
  answers: z.array(GuestAnswer),
```

Remove `answer: z.string().nullable(),` from `PendingItem` (line 290) — every pending registration also appears in `guests`, so the card reads its answers from there instead of shipping them twice.

Add the question list to the dashboard event (after `questionControls`, line 371):

```ts
    questionControls: QuestionControls,
    /** Labels and types for every answer on this page, sent once instead of per guest. */
    questions: z.array(EventQuestion),
```

- [ ] **Step 5: Attach answers server-side**

In `apps/backend/src/routes/router.ts`, import the loader:

```ts
import { answerText, loadAnswers } from "../lib/answers";
```

In `buildGuestRows`, after the `fileById` map is built, add:

```ts
  const answersByReg = await loadAnswers(regIds);

  /**
   * The dashboard re-fetches every 30 s and ships every guest's answers to every
   * committee admin, uncompressed. Cap what the UI needs; the CSV export carries
   * the full text.
   */
  const DASHBOARD_ANSWER_MAX = 500;
```

and add the field to each `GuestRow`:

```ts
      createdAt: r.createdAt.toISOString(),
      answers: (answersByReg.get(r.id) ?? []).map((a) => ({
        questionId: a.questionId,
        value: a.value.length > DASHBOARD_ANSWER_MAX ? `${a.value.slice(0, DASHBOARD_ANSWER_MAX)}…` : a.value,
        fileUrl: a.fileUrl,
        fileName: a.fileName,
      })),
```

In the `dashboard` handler, delete the whole first-answer-only block (lines 803-816: the `pendingIds` query, `answerRows`, and `answerByReg`) and the `answer:` line from the `PendingItem` mapping, keeping the rest:

```ts
      const pendingRegs = regs.filter((r) => r.status === "pending").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const guestByReg = new Map(guests.map((g) => [g.registrationId, g]));
      const pending: PendingItem[] = pendingRegs.map((r) => ({
        registrationId: r.id,
        name: r.fullName,
        initials: initialsOf(r.fullName),
        andrewId: guestByReg.get(r.id)?.andrewId ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
```

Add the question list to the response body, next to `questionControls`:

```ts
          questionControls: controls,
          questions: (await orgQuestions(e.id)).map((q) => ({
            id: q.id,
            kind: q.kind,
            key: q.key,
            label: q.label,
            type: q.type,
            options: q.options,
            required: q.required,
          })),
```

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/routes/org-questions.test.ts
```

Expected: PASS — 10 tests.

- [ ] **Step 7: Show the answers on the dashboard**

In `apps/web/src/pages/OrganizePage.tsx`, add `ChevronDownIcon` to the icon import, add state and two lookups next to `filteredGuests`:

```tsx
  const [openRow, setOpenRow] = useState<string | null>(null);
```

```tsx
  // Expansion state lives outside the query data: the dashboard refetches every
  // 30 s and react-query replaces `d` wholesale, which would collapse the rows.
  const questionById = useMemo(() => new Map((d?.event.questions ?? []).map((q) => [q.id, q])), [d]);
  const guestByReg = useMemo(() => new Map((d?.guests ?? []).map((g) => [g.registrationId, g])), [d]);
```

Add an answer-list renderer above `DashboardBody`:

```tsx
function AnswerList({
  answers,
  questionById,
}: {
  answers: Dashboard["guests"][number]["answers"];
  questionById: Map<string, { label: string }>;
}) {
  if (answers.length === 0) return <span style={{ fontSize: 12, color: "var(--muted-3)" }}>No answers.</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {answers.map((a) => (
        <div key={a.questionId} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted-2)", minWidth: 140 }}>
            {questionById.get(a.questionId)?.label ?? "Question"}
          </span>
          {a.fileUrl ? (
            <a href={a.fileUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--blue-hover)", fontSize: 12.5, fontWeight: 500 }}>
              <FileTextIcon size={13} />
              {a.fileName ?? "Download"}
            </a>
          ) : (
            <span style={{ fontSize: 12.5, color: "#38424b", whiteSpace: "pre-wrap", flex: "1 1 200px", minWidth: 0 }}>{a.value}</span>
          )}
        </div>
      ))}
    </div>
  );
}
```

Replace the pending card's single-answer line (line 400) with:

```tsx
                <AnswerList answers={guestByReg.get(p.registrationId)?.answers ?? []} questionById={questionById} />
```

Make the guest rows expandable. Widen `minWidth: 780` to `minWidth: 820` (line 311), add a trailing `28px` column to **both** grid templates (lines 312 and 327 — they must stay identical), add an empty header cell (`<div />`) after `Source · Status` at line 319, and wrap each row.

The seven existing cells, `apps/web/src/pages/OrganizePage.tsx:331-363`, are unchanged and are reproduced verbatim below; the only thing that happens to them is that their row `<div>` gains a trailing grid column and a `Fragment` wrapper around it:

```tsx
              {filteredGuests.slice(0, shown).map((g, i) => {
                const [bg, fg] = AVATAR_PALETTES[i % 5].split(",");
                const chip = STATUS_CHIP[g.status];
                const open = openRow === g.registrationId;
                return (
                  <Fragment key={g.registrationId}>
                    <div
                      style={{ display: "grid", gridTemplateColumns: "1.5fr 0.9fr 1.1fr 0.55fr 1fr 0.7fr 1fr 28px", gap: 10, padding: "12px 20px", borderBottom: open ? "none" : "1px solid var(--border-subtle)", fontSize: 13, color: "#38424b", alignItems: "center" }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--panel)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <div style={{ fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ flex: "none", width: 24, height: 24, borderRadius: 100, background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }}>
                          {g.initials}
                        </div>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                        {g.plusOne && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--blue-pressed)", background: "var(--blue-subtle)", borderRadius: 4, padding: "2px 6px", flex: "none" }}>
                            +1
                          </span>
                        )}
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: "var(--muted-1)" }}>{g.andrewId ?? "—"}</div>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.major ?? "—"}</div>
                      <div>{g.classYear ?? "—"}</div>
                      <div style={{ color: "var(--muted-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.dietary.length ? g.dietary.join(", ") : "—"}
                      </div>
                      <div>
                        {g.resumeUrl ? (
                          <a href={g.resumeUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--blue-hover)", fontSize: 12, fontWeight: 500 }}>
                            <FileTextIcon size={13} />
                            PDF
                          </a>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ color: "var(--muted-2)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.source ?? "—"}</span>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: chip.color, background: chip.background, borderRadius: 100, padding: "3px 10px", marginLeft: "auto", flex: "none" }}>
                          {STATUS_LABEL[g.status]}
                        </span>
                      </div>
                      <button
                        aria-expanded={open}
                        aria-label={open ? "Hide answers" : "Show answers"}
                        onClick={() => setOpenRow(open ? null : g.registrationId)}
                        style={{ all: "unset", cursor: "pointer", display: "flex", color: "var(--muted-3)", transform: open ? "rotate(180deg)" : undefined, transition: "transform 140ms var(--ease)" }}
                      >
                        <ChevronDownIcon size={14} />
                      </button>
                    </div>
                    {open && (
                      <div className="fade-in" style={{ padding: "12px 20px 16px 52px", borderBottom: "1px solid var(--border-subtle)", background: "var(--panel)" }}>
                        <AnswerList answers={g.answers} questionById={questionById} />
                      </div>
                    )}
                  </Fragment>
                );
              })}
```

Import `Fragment` from `react` at the top of the file.

- [ ] **Step 8: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors. The removal of `PendingItem.answer` shows up here or nowhere — there is no runtime response validation.

- [ ] **Step 9: Manual QA**

- [ ] Open `/organize/<id>` for the approval event from Task 4's QA. The pending card lists **every** answer, each labelled, not just the first.
- [ ] Click the caret at the end of a guest row — a panel opens beneath it listing every answer, with the file answer as a clickable link.
- [ ] Click the file link — the document downloads (this is Task 6's ACL doing its job; before it, this 403'd).
- [ ] Wait 30 s for the auto-refetch — the row stays open.
- [ ] Click "Load more" if the event has more than 25 guests — the open row stays open and correct.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/lib/answers.ts packages/contract/src/index.ts apps/backend/src/routes/router.ts apps/web/src/pages/OrganizePage.tsx apps/backend/src/routes/org-questions.test.ts
git commit -m "Show every answer on the dashboard, not just the first"
```

---

### Task 12: CSV and MCP tell the same story

**Files:**
- Create: `apps/backend/src/lib/guest-export.ts`, `apps/backend/src/lib/guest-export.test.ts`
- Modify: `apps/backend/src/server.ts:230-318` (the CSV route)
- Modify: `apps/backend/src/mcp/main.ts:120-201` (`guest_list`, `pending_reviews`, `export_csv`)

**Interfaces:**
- Consumes: `answerText`, `loadAnswers` (Tasks 1 and 11); `createEventBody`, `makeCommittee`, `makeUser`, `multipartUpload`, `setControlsReturningPrevious`, `startTestServer` from the harness (Task 2); `isUuid` exported from `apps/backend/src/routes/router.ts`.
- Produces: `buildGuestCsv(eventId: string): Promise<{ headers: string[]; rows: (string | number)[][] }>` from `apps/backend/src/lib/guest-export.ts` — the single definition of the guest export, used by the HTTP route and by MCP.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/lib/guest-export.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/client";
import { buildGuestCsv } from "./guest-export";
import { createEventBody, makeCommittee, makeUser, multipartUpload, setControlsReturningPrevious, startTestServer } from "../test/harness";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

describe("buildGuestCsv", () => {
  it("emits a column per answerable question, a URL for a file answer, and a phone number that survived jsonb", async () => {
    const before = await setControlsReturningPrevious({ phone: true });
    try {
      const committee = await makeCommittee();
      const organizer = await makeUser({ admin: { committeeId: committee.id } });
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/org/events",
          headers: { cookie: organizer.cookie },
          payload: createEventBody(committee.id, {
            captures: { major_year: false, dietary: false, resume: false, source: false, phone: true, tshirt: false },
            hostQuestions: [{ label: "Portfolio", type: "file" }],
          }),
        })
      ).json() as { id: string; shortCode: string };

      const questions = await db
        .select()
        .from(schema.eventQuestions)
        .where(eq(schema.eventQuestions.eventId, created.id))
        .orderBy(asc(schema.eventQuestions.sort));
      const phone = questions.find((q) => q.key === "phone")!;
      const portfolio = questions.find((q) => q.label === "Portfolio")!;

      const guest = await makeUser();
      const part = multipartUpload("portfolio.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
      const fileId = (
        (
          await app.inject({
            method: "POST",
            url: "/api/files?kind=answer",
            headers: { cookie: guest.cookie, "content-type": part.contentType },
            payload: part.body,
          })
        ).json() as { id: string }
      ).id;

      const registered = await app.inject({
        method: "POST",
        url: `/api/events/${created.shortCode}/register`,
        headers: { cookie: guest.cookie },
        payload: {
          fullName: "Jane Tartan",
          custom: [
            { questionId: phone.id, value: "4125551234" },
            { questionId: portfolio.id, value: fileId },
          ],
        },
      });
      expect(registered.statusCode).toBe(200);

      const { headers, rows } = await buildGuestCsv(created.id);
      expect(headers).toContain("Phone number");
      expect(headers).toContain("Portfolio");
      const row = rows[0];
      // The stored "4125551234" comes back from jsonb as a NUMBER — answerText is
      // what stops this cell reading 4125551234 as something other than a string.
      expect(row[headers.indexOf("Phone number")]).toBe("4125551234");
      expect(String(row[headers.indexOf("Portfolio")])).toContain(`/api/files/${fileId}`);
    } finally {
      // `before` is the PRE-patch snapshot — see the harness comment. Restoring
      // the post-patch value would leave phone switched on for every later file.
      await setControlsReturningPrevious({ phone: before.phone });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/lib/guest-export.test.ts
```

Expected: FAIL with `Failed to resolve import "./guest-export"`.

- [ ] **Step 3: Extract the export**

Create `apps/backend/src/lib/guest-export.ts`:

```ts
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { loadAnswers } from "./answers";

/**
 * The guest export, defined once. The HTTP route and the MCP `export_csv` tool
 * both render this, so the tool's "same columns as the dashboard export" claim is
 * true by construction rather than by hope.
 */
export async function buildGuestCsv(eventId: string): Promise<{ headers: string[]; rows: (string | number)[][] }> {
  const regs = await db
    .select({ registration: schema.registrations, user: schema.users })
    .from(schema.registrations)
    .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
    .where(eq(schema.registrations.eventId, eventId))
    .orderBy(asc(schema.registrations.createdAt));

  const regIds = regs.map((r) => r.registration.id);
  const ticketRows = regIds.length
    ? await db.select().from(schema.tickets).where(inArray(schema.tickets.registrationId, regIds))
    : [];
  const ticketByReg = new Map(ticketRows.filter((t) => !t.revokedAt).map((t) => [t.registrationId, t]));

  const checkinRows = regIds.length
    ? await db
        .select()
        .from(schema.checkins)
        .where(and(eq(schema.checkins.eventId, eventId), eq(schema.checkins.result, "ok")))
    : [];
  const checkinByTicket = new Map(checkinRows.map((c) => [c.ticketId, c]));

  // Hidden questions keep their column: hiding a question must never drop the
  // answers it already collected out of the export.
  const allQuestions = await db
    .select()
    .from(schema.eventQuestions)
    .where(eq(schema.eventQuestions.eventId, eventId))
    .orderBy(asc(schema.eventQuestions.sort));
  const questions = allQuestions.filter((q) => q.kind === "custom" || q.key === "phone" || q.key === "tshirt");

  const answersByReg = await loadAnswers(regIds);

  const headers = [
    "Name",
    "Andrew ID",
    "Email",
    "Status",
    "Serial",
    "Number",
    "Major",
    "Class year",
    "Dietary",
    "Resume",
    "Source",
    "Plus one",
    "Checked in at",
    "Registered at",
    ...questions.map((q) => q.label),
  ];

  const rows = regs.map(({ registration: r, user: u }) => {
    const ticket = ticketByReg.get(r.id);
    const checkin = ticket ? checkinByTicket.get(ticket.id) : undefined;
    const byQuestion = new Map((answersByReg.get(r.id) ?? []).map((a) => [a.questionId, a]));
    return [
      r.fullName,
      u.andrewId ?? "",
      u.email,
      r.status,
      ticket?.serial ?? "",
      ticket?.number ?? "",
      r.major ?? "",
      r.classYear ?? "",
      ((r.dietary as string[]) ?? []).join("; "),
      r.resumeFileId ? `${env.apiUrl}/api/files/${r.resumeFileId}` : "",
      r.source ?? "",
      r.plusOne ? "yes" : "no",
      checkin ? checkin.createdAt.toISOString() : "",
      r.createdAt.toISOString(),
      ...questions.map((q) => {
        const answer = byQuestion.get(q.id);
        if (!answer) return "";
        return answer.fileUrl ?? answer.value;
      }),
    ];
  });

  return { headers, rows };
}
```

- [ ] **Step 4: Point the HTTP route at it**

In `apps/backend/src/server.ts`, add `isUuid` to the import from `./routes/router` and `buildGuestCsv` from `./lib/guest-export`, then replace the CSV route body (lines 230-318).

Only `isUuid` is borrowed from the router, not `loadScopedEvent`: `loadScopedEvent` is module-private at `apps/backend/src/routes/router.ts:145` and takes an `AuthContext`, which this plain Fastify route never builds — it has `request.authCtx` and nothing else. `isUuid` is already exported (`router.ts:141`). The hand-rolled committee comparison below is therefore kept exactly as it is today; the only thing being fixed here is the missing id-shape guard.

```ts
  // CSV export — one query surface, committee-scoped.
  app.get("/api/org/events/:id/export.csv", async (request, reply) => {
    const ctx = request.authCtx;
    if (!ctx?.admin) return reply.status(401).send({ error: "unauthorized", message: "Organizers only." });
    const { id } = request.params as { id: string };
    // A non-uuid id reaches Postgres as a cast error and surfaces as a 500.
    if (!isUuid(id)) return reply.status(404).send({ error: "not_found", message: "Event not found" });
    const events = await db.select().from(schema.events).where(eq(schema.events.id, id));
    const event = events[0];
    if (!event) return reply.status(404).send({ error: "not_found", message: "Event not found" });
    if (ctx.admin.row.role !== "super_admin" && ctx.admin.row.committeeId !== event.committeeId) {
      return reply.status(403).send({ error: "forbidden", message: "Not your committee's event." });
    }

    const { headers, rows } = await buildGuestCsv(id);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${event.title.replace(/[^\w.\- ]/g, "_").slice(0, 60)} guests.csv"`,
    );
    return reply.send(toCsv(headers, rows));
  });
```

Then tidy the drizzle import on line 8. The CSV route was the only user of `inArray` (lines 250 and 269), so it is now unused; `isNull` is unused already, today, before this change. `asc` survives on line 339 and `gte` on line 338, both in the calendar route, and `sql` was added in Task 6 for the file ACL. The typechecker will **not** flag either dead import — `apps/backend/tsconfig.json` sets neither `noUnusedLocals` nor `noUnusedParameters` — so make the edit deliberately rather than waiting to be told:

```ts
import { and, asc, eq, gte, sql } from "drizzle-orm";
```

- [ ] **Step 5: Give MCP the same answers**

In `apps/backend/src/mcp/main.ts`, import the shared pieces:

```ts
import { loadAnswers } from "../lib/answers";
import { buildGuestCsv } from "../lib/guest-export";
```

Append answers to each `guest_list` line (replacing the `lines` mapping at :138-141):

```ts
      const answersByReg = await loadAnswers(regIds);
      const lines = regs.map(({ registration: r, user: u }) => {
        const t = ticketByReg.get(r.id);
        const answers = (answersByReg.get(r.id) ?? [])
          .map((a) => `\n    ${a.label}: ${a.fileUrl ?? a.value}`)
          .join("");
        return `• ${r.fullName} (${u.andrewId ?? u.email}) — ${r.status}${t ? ` · ${t.serial}` : ""}${r.major ? ` · ${r.major}` : ""}${r.classYear ? ` '${r.classYear.slice(-2)}` : ""}${(r.dietary as string[])?.length ? ` · diet: ${(r.dietary as string[]).join(", ")}` : ""}${r.source ? ` · via ${r.source}` : ""}${r.plusOne ? " · +1" : ""}${answers}`;
      });
```

and update its description (line 122):

```ts
    "Full guest list for one event (name, andrew ID, status, major, dietary, source, serial) plus every signup-question answer. File answers are links a signed-in organizer opens in a browser — they need the session cookie, so they can't be fetched from here.",
```

Do the same for `pending_reviews` (replacing its `lines` mapping at :159-162), which has exactly the defect the dashboard queue had:

```ts
    const answersByReg = await loadAnswers(pending.map((p) => p.registration.id));
    const titleById = new Map(events.map((e) => [e.event.id, e.event.title]));
    const lines = pending.map(({ registration: r, user: u }) => {
      const hours = Math.round((Date.now() - r.createdAt.getTime()) / 3_600_000);
      const answers = (answersByReg.get(r.id) ?? []).map((a) => `\n    ${a.label}: ${a.fileUrl ?? a.value}`).join("");
      return `• ${r.fullName} (${u.andrewId ?? u.email}) — ${titleById.get(r.eventId)} · waiting ${hours}h${answers}`;
    });
```

Replace the whole body of `export_csv` (lines 170-200) with:

```ts
      const auth = requireAuth();
      const found = await findScopedEvent(auth, event);
      if (!found) return text(`No event matching “${event}” in your scope. Try list_events.`);
      const { headers, rows } = await buildGuestCsv(found.event.id);
      return text(toCsv(headers, rows));
```

The description at line 168 is finally true, so leave it — but note in it that file answers are URLs:

```ts
    "Export one event's guest list as CSV text — the same columns as the dashboard export, including every signup-question answer. File answers are browser-authenticated URLs.",
```

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism src/lib/guest-export.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the whole backend suite**

Run:
```bash
cd apps/backend && export DATABASE_URL="postgres://postgres:postgres@localhost:5433/scottylabs_invites" && npx vitest run --no-file-parallelism
```

Expected: PASS — every file, including the pre-existing `src/auth/service.test.ts`.

- [ ] **Step 8: Typecheck**

Run: `pnpm -r typecheck`

Expected: no errors.

- [ ] **Step 9: Manual QA**

- [ ] From the dashboard, click **Export CSV**. The file has a column per host question plus `Phone number`, the phone cell reads as the number the guest typed, and the Portfolio cell is a full `https://…/api/files/<uuid>` URL.
- [ ] Paste that URL into the browser while signed in as the committee admin — the file downloads.
- [ ] A question you hid in Task 9's QA still has its column, with its old answers intact.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/lib/guest-export.ts apps/backend/src/lib/guest-export.test.ts apps/backend/src/server.ts apps/backend/src/mcp/main.ts
git commit -m "One guest export, shared by CSV and MCP, with answers"
```

---

## Known limits, recorded on purpose

- **Claimed +1 guests are never asked anything.** `claimTransfer` issues a ticket with `registrationId: null` and creates no registration, so a +1 holder has no answers, no guest row and no CSV line. Marking a question required therefore still yields nothing for them. Pre-existing, out of scope, and stated here so nobody reads "required" as a guarantee.
- **Existing events are not backfilled.** `visible` was frozen at creation, so every event that exists today has its `phone` and `tshirt` rows hidden. No migration switches them on; organizers turn them on per event through the new PUT.
- **Question order changes for existing events.** Unifying the renderer puts "How did you hear about this?" above the host questions instead of below them, and drops phone and t-shirt between them. That is the order the builder shows, and the two have to agree.
- **Multi-select is not possible.** `RegisterBody.custom[].value` is a single string; dietary restrictions stay a bespoke chip list.
- **CSV headers are not deduplicated.** Two questions with the same label produce two identically named columns. Pre-existing, and post-publish relabelling makes it slightly easier to hit.

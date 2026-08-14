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

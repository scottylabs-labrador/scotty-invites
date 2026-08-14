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

  it("rejects a non-UUID value for a file answer", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      hostQuestions: [{ label: "Portfolio", type: "file" }],
    });
    const question = event.questions.find((q) => q.label === "Portfolio")!;
    const guest = await makeUser();
    const prior = await seedCancelled(event.id, guest.user.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${event.shortCode}/register`,
      headers: { cookie: guest.cookie },
      payload: { fullName: "Jane Tartan", custom: [{ questionId: question.id, value: "not-a-uuid" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "answer_file" });
    const still = await db.select().from(schema.registrations).where(eq(schema.registrations.id, prior.id));
    expect(still).toHaveLength(1);
  });

  // The plan calls this out by name: major_year/dietary/source are seeded as
  // type "select" with options: null (see the createEvent handler's `standard`
  // literal). Without the router's guard at the top of the per-question loop
  // ("major_year / dietary / resume / source arrive in their own body fields"),
  // these questions would fall through into the same value/select-option checks
  // as a host question. Real answers for these three never travel through
  // `custom` — EventPage's `answerable` filter only ever sends `custom` entries
  // for `kind: "custom"` questions plus `phone`/`tshirt` — so the only way to
  // reach the guarded branch at all is a payload that spoofs a `custom` entry
  // keyed to one of these standard question ids.
  it("keeps registering guests once major_year, dietary and source are captured, and ignores a spoofed custom answer for one of them", async () => {
    const before = await setControlsReturningPrevious({ major_year: true, dietary: true, source: true });
    try {
      const committee = await makeCommittee();
      const organizer = await makeUser({ admin: { committeeId: committee.id } });
      const event = await publish(organizer.cookie, committee.id, {
        captures: { major_year: true, dietary: true, resume: false, source: true, phone: false, tshirt: false },
      });
      const majorYear = event.questions.find((q) => q.key === "major_year")!;
      expect(majorYear.options).toBeNull();

      const plainGuest = await makeUser();
      const plain = await app.inject({
        method: "POST",
        url: `/api/events/${event.shortCode}/register`,
        headers: { cookie: plainGuest.cookie },
        payload: { fullName: "Jane Tartan", custom: [] },
      });
      expect(plain.statusCode).toBe(200);

      const spoofingGuest = await makeUser();
      const spoofed = await app.inject({
        method: "POST",
        url: `/api/events/${event.shortCode}/register`,
        headers: { cookie: spoofingGuest.cookie },
        payload: { fullName: "Jane Tartan", custom: [{ questionId: majorYear.id, value: "Not a real option" }] },
      });
      expect(spoofed.statusCode).toBe(200);
      const { registrationId } = spoofed.json() as { registrationId: string };
      const answers = await db.select().from(schema.answers).where(eq(schema.answers.registrationId, registrationId));
      // The guard must have skipped the standard question entirely — no answer
      // row at all, not even a rejected/coerced one.
      expect(answers).toHaveLength(0);
    } finally {
      await setControlsReturningPrevious({ major_year: before.major_year, dietary: before.dietary, source: before.source });
    }
  });
});

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

  // The two cases above never actually exercise the `controls[key] &&` half of
  // the gate, because createEvent bakes `visible: controls[key] && captures[key]`
  // into the row at publish time — so a gate that checked only row presence
  // (ignoring `controls` entirely) would already pass both. This proves the
  // global-control half is live at register time too, not just baked into the
  // row: the row stays visible from when the control was on; only the control
  // itself flips afterward.
  it("still blocks the value when a super admin turns the global control off after the event's row was already made visible", async () => {
    const before = await setControlsReturningPrevious({ major_year: true });
    try {
      const committee = await makeCommittee();
      const organizer = await makeUser({ admin: { committeeId: committee.id } });
      const event = await publish(organizer.cookie, committee.id, {
        captures: { major_year: true, dietary: false, resume: false, source: false, phone: false, tshirt: false },
      });
      const majorYear = event.questions.find((q) => q.key === "major_year")!;
      expect(majorYear.visible).toBe(true);

      // Flip the global control off. The event's own row is untouched.
      await setControlsReturningPrevious({ major_year: false });

      const guest = await makeUser();
      const res = await app.inject({
        method: "POST",
        url: `/api/events/${event.shortCode}/register`,
        headers: { cookie: guest.cookie },
        payload: { fullName: "Jane Tartan", major: "Computer Science", classYear: "2027" },
      });
      expect(res.statusCode).toBe(200);

      const { registrationId } = res.json() as { registrationId: string };
      const row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationId)))[0];
      expect(row.major).toBeNull();
      expect(row.classYear).toBeNull();
    } finally {
      await setControlsReturningPrevious({ major_year: before.major_year });
    }
  });

  // The two cases above never store a resume file id on the positive path
  // either (both leave `resume` off). Cover it explicitly so "both on" is
  // proven for all four fields, not just three of them.
  it("stores the resume file id when the event does ask and the global control allows it", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const event = await publish(organizer.cookie, committee.id, {
      captures: { major_year: false, dietary: false, resume: true, source: false, phone: false, tshirt: false },
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
      payload: { fullName: "Jane Tartan", resumeFileId: own.id },
    });
    expect(res.statusCode).toBe(200);

    const { registrationId } = res.json() as { registrationId: string };
    const row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationId)))[0];
    expect(row.resumeFileId).toBe(own.id);
  });
});

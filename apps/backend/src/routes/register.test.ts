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

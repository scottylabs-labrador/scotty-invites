import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/client";
import { createEventBody, makeCommittee, makeUser, startTestServer } from "../test/harness";
import { createRegistration } from "./registrations";

let app: FastifyInstance;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await app.close();
});

describe("createRegistration — a question deleted after the caller read it", () => {
  // Composed sequence this proves the narrower half of: the register handler
  // reads `event_questions` and validates against it BEFORE createRegistration
  // takes the advisory lock (router.ts). In between, an organizer's questions
  // PUT can hard-delete an unanswered custom question — updateQuestions is the
  // one destructive path in this codebase that removes a live event_questions
  // row. Inserting an answer for an id that's gone by the time createRegistration
  // runs is an FK violation (answers.question_id references event_questions),
  // which without a fix rolls back the WHOLE transaction — including the
  // registration row itself — and surfaces as a 500. Dropping just that one
  // answer, the way the caller would have if the question had never existed,
  // is the correct outcome.
  it("drops the answer instead of failing the whole registration", async () => {
    const committee = await makeCommittee();
    const organizer = await makeUser({ admin: { committeeId: committee.id } });
    const created = await app.inject({
      method: "POST",
      url: "/api/org/events",
      headers: { cookie: organizer.cookie },
      payload: createEventBody(committee.id, {
        hostQuestions: [{ label: "GitHub handle", type: "short" }],
      }),
    });
    expect(created.statusCode).toBe(200);
    const { id: eventId } = created.json() as { id: string };

    const eventRow = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0];
    const question = (
      await db.select().from(schema.eventQuestions).where(eq(schema.eventQuestions.eventId, eventId))
    ).find((q) => q.kind === "custom")!;

    // Simulate the interleave directly: a concurrent organizer PUT hard-deletes
    // the unanswered custom question between the handler's read and this call.
    await db.delete(schema.eventQuestions).where(eq(schema.eventQuestions.id, question.id));

    const guest = await makeUser();
    const outcome = await createRegistration({
      event: eventRow,
      user: guest.user,
      fullName: "Jane Tartan",
      major: null,
      classYear: null,
      dietary: [],
      resumeFileId: null,
      source: null,
      plusOne: false,
      customAnswers: [{ questionId: question.id, value: "octocat" }],
    });

    // The registration itself must still exist — the whole point is that the
    // stale answer doesn't take the rest of the transaction down with it.
    const stillThere = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.id, outcome.registration.id));
    expect(stillThere).toHaveLength(1);

    const answers = await db
      .select()
      .from(schema.answers)
      .where(eq(schema.answers.registrationId, outcome.registration.id));
    expect(answers).toHaveLength(0);
  });
});

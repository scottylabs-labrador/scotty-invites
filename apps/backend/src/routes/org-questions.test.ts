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

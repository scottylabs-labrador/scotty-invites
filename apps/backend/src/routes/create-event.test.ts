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

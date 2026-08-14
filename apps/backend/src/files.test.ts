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

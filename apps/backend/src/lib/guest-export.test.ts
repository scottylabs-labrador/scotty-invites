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

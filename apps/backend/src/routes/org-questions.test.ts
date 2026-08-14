import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { MAX_CUSTOM_QUESTIONS } from "@scottylabs-invites/contract";
import { db, schema } from "../db/client";
import { createEventBody, makeCommittee, makeUser, setControlsReturningPrevious, startTestServer } from "../test/harness";

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

  it("surfaces the live global controls so a frozen visible:true doesn't lie about what guests see", async () => {
    const previous = await setControlsReturningPrevious({ dietary: true });
    try {
      const committee = await makeCommittee();
      const organizer = await makeUser({ admin: { committeeId: committee.id } });
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/org/events",
          headers: { cookie: organizer.cookie },
          payload: createEventBody(committee.id, {
            captures: { major_year: false, dietary: true, resume: false, source: false, phone: false, tshirt: false },
          }),
        })
      ).json() as { id: string };

      // Super admin globally disables dietary AFTER the event was created — the
      // event's own question row still says visible: true, it's just no longer
      // enforced for guests.
      await setControlsReturningPrevious({ dietary: false });

      const res = await app.inject({ method: "GET", url: `/api/org/events/${created.id}`, headers: { cookie: organizer.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        questions: { key: string | null; visible: boolean }[];
        questionControls: { dietary: boolean };
      };

      const dietary = body.questions.find((q) => q.key === "dietary")!;
      expect(dietary.visible).toBe(true);
      expect(body.questionControls.dietary).toBe(false);
    } finally {
      await setControlsReturningPrevious(previous);
    }
  });
});

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
    // phone is off club-wide by default (services/settings.ts DEFAULT_CONTROLS), but
    // this suite shares one app_settings row with every other test file and with
    // manual dev-server use — pin it explicitly rather than trust ambient state.
    const previous = await setControlsReturningPrevious({ phone: false });
    try {
      const { organizer, event, questions } = await setup();
      const drafts = draftsOf(questions);
      drafts.find((d) => d.label === "Phone number")!.visible = true;
      const res = await put(organizer.cookie, event.id, drafts);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "globally_off" });
    } finally {
      await setControlsReturningPrevious(previous);
    }
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

  // -- reconciliation-table cells the tests above don't reach directly ------

  it("relabels and re-requires a question that already has answers, as long as type and options don't change", async () => {
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
    const draft = drafts.find((d) => d.id === github.id)!;
    draft.label = "GitHub username (updated)";
    draft.required = true;
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: { id: string; label: string; required: boolean }[] };
    const updated = body.questions.find((q) => q.id === github.id)!;
    expect(updated.label).toBe("GitHub username (updated)");
    expect(updated.required).toBe(true);
  });

  it("allows changing type and options on a question nobody has answered yet", async () => {
    const { organizer, event, questions } = await setup();
    const github = questions.find((q) => q.label === "GitHub handle")!;
    const drafts = draftsOf(questions);
    const draft = drafts.find((d) => d.id === github.id)!;
    draft.type = "select";
    draft.options = ["Yes", "No"];
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: { id: string; type: string; options: string[] | null }[] };
    const updated = body.questions.find((q) => q.id === github.id)!;
    expect(updated.type).toBe("select");
    expect(updated.options).toEqual(["Yes", "No"]);
  });

  it("switches on a standard field the club has enabled club-wide", async () => {
    const previous = await setControlsReturningPrevious({ major_year: true });
    try {
      const { organizer, event, questions } = await setup();
      const drafts = draftsOf(questions);
      drafts.find((d) => d.label === "Major + class year")!.visible = true;
      const res = await put(organizer.cookie, event.id, drafts);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { questions: { label: string; visible: boolean }[] };
      expect(body.questions.find((q) => q.label === "Major + class year")!.visible).toBe(true);
    } finally {
      await setControlsReturningPrevious(previous);
    }
  });

  it("reorders two questions without touching anything else about them", async () => {
    const { organizer, event, questions } = await setup([
      { label: "GitHub handle", type: "short" },
      { label: "Team size", type: "short" },
    ]);
    const drafts = draftsOf(questions);
    const github = drafts.find((d) => d.label === "GitHub handle")!;
    const team = drafts.find((d) => d.label === "Team size")!;
    const i = drafts.indexOf(github);
    const j = drafts.indexOf(team);
    [drafts[i], drafts[j]] = [drafts[j], drafts[i]];

    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: { id: string; label: string; required: boolean; visible: boolean; sort: number }[] };
    const newGithub = body.questions.find((q) => q.id === github.id)!;
    const newTeam = body.questions.find((q) => q.id === team.id)!;
    expect(newTeam.sort).toBeLessThan(newGithub.sort);
    expect(newGithub.label).toBe("GitHub handle");
    expect(newGithub.required).toBe(github.required);
    expect(newGithub.visible).toBe(github.visible);
  });

  it("rejects a draft whose id belongs to a different event", async () => {
    const { organizer, event, questions } = await setup();
    const other = await setup();
    const foreignId = other.questions.find((q) => q.label === "GitHub handle")!.id;
    const drafts = draftsOf(questions);
    drafts.find((d) => d.label === "GitHub handle")!.id = foreignId;
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_question" });
  });

  it("rejects a payload that lists the same question id twice", async () => {
    const { organizer, event, questions } = await setup();
    const drafts = draftsOf(questions);
    const github = drafts.find((d) => d.label === "GitHub handle")!;
    drafts.push({ ...github });
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_question" });
  });

  it("rejects an empty question list because the standard fields would vanish", async () => {
    const { organizer, event } = await setup();
    const res = await put(organizer.cookie, event.id, []);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_standard" });
  });

  it("accepts exactly MAX_CUSTOM_QUESTIONS custom questions", async () => {
    const { organizer, event, questions } = await setup([]);
    const drafts = draftsOf(questions);
    for (let i = 0; i < MAX_CUSTOM_QUESTIONS; i++) {
      drafts.push({ label: `Custom ${i}`, type: "short", required: false, visible: true });
    }
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: { kind: string }[] };
    expect(body.questions.filter((q) => q.kind === "custom")).toHaveLength(MAX_CUSTOM_QUESTIONS);
  });

  it("one more than MAX_CUSTOM_QUESTIONS is rejected", async () => {
    const { organizer, event, questions } = await setup([]);
    const drafts = draftsOf(questions);
    for (let i = 0; i < MAX_CUSTOM_QUESTIONS + 1; i++) {
      drafts.push({ label: `Custom ${i}`, type: "short", required: false, visible: true });
    }
    const res = await put(organizer.cookie, event.id, drafts);
    expect(res.statusCode).toBe(400);
  });
});

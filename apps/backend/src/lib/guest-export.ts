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

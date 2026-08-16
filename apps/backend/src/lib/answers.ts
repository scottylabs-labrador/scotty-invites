import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";

/**
 * `answers.value` is a jsonb column, and the read path decodes it TWICE:
 * node-postgres JSON.parses the column text (pg-types registers JSON.parse for
 * OID 3802), then Drizzle's jsonb mapper JSON.parses the result again when it is
 * still a string. A stored "4125551234" therefore comes back as the NUMBER
 * 4125551234, a stored "true" as the boolean true, and a stored "null" as null —
 * which `String(v ?? "")` silently renders as an empty cell.
 *
 * Every surface that prints an answer (dashboard, CSV, MCP) goes through this one
 * function, or the three of them will disagree about what a phone number is.
 */
export function answerText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => answerText(v)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface LoadedAnswer {
  registrationId: string;
  questionId: string;
  label: string;
  type: string;
  value: string;
  /** Set only for a file question whose value really names a file we hold. */
  fileUrl: string | null;
  fileName: string | null;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Every answer for a set of registrations, in the order the guest saw the
 * questions. Hidden questions are deliberately NOT filtered out: an answer only
 * exists because the question was live when it was given, and hiding a question
 * must never erase what it already collected.
 */
export async function loadAnswers(registrationIds: string[]): Promise<Map<string, LoadedAnswer[]>> {
  const byRegistration = new Map<string, LoadedAnswer[]>();
  if (registrationIds.length === 0) return byRegistration;

  const rows = await db
    .select({
      registrationId: schema.answers.registrationId,
      questionId: schema.answers.questionId,
      value: schema.answers.value,
      label: schema.eventQuestions.label,
      type: schema.eventQuestions.type,
    })
    .from(schema.answers)
    .innerJoin(schema.eventQuestions, eq(schema.answers.questionId, schema.eventQuestions.id))
    .where(inArray(schema.answers.registrationId, registrationIds))
    .orderBy(asc(schema.eventQuestions.sort));

  const fileIds = [
    ...new Set(
      rows
        .filter((r) => r.type === "file")
        .map((r) => answerText(r.value).toLowerCase())
        .filter((v) => FILE_ID.test(v)),
    ),
  ];
  const files = fileIds.length
    ? await db.select({ id: schema.files.id, filename: schema.files.filename }).from(schema.files).where(inArray(schema.files.id, fileIds))
    : [];
  const fileById = new Map(files.map((f) => [f.id, f]));

  for (const r of rows) {
    const value = answerText(r.value);
    // A file-typed question that predates the uploader holds arbitrary free text,
    // so only rewrite to a link when the value names a file that exists.
    const file = r.type === "file" ? fileById.get(value.toLowerCase()) : undefined;
    const list = byRegistration.get(r.registrationId) ?? [];
    list.push({
      registrationId: r.registrationId,
      questionId: r.questionId,
      label: r.label,
      type: r.type,
      value,
      fileUrl: file ? `${env.apiUrl}/api/files/${file.id}` : null,
      fileName: file?.filename ?? null,
    });
    byRegistration.set(r.registrationId, list);
  }
  return byRegistration;
}

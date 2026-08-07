import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { QuestionControls } from "@scottylabs-invites/contract";

const DEFAULT_CONTROLS: QuestionControls = { major_year: true, dietary: true, resume: true, source: true, phone: false, tshirt: false };
const KEY = "question_controls";

export async function getQuestionControls(): Promise<QuestionControls> {
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY));
  if (!rows[0]) return { ...DEFAULT_CONTROLS };
  return { ...DEFAULT_CONTROLS, ...(rows[0].value as Partial<QuestionControls>) };
}

export async function setQuestionControl(key: keyof QuestionControls, enabled: boolean): Promise<QuestionControls> {
  const current = await getQuestionControls();
  const next = { ...current, [key]: enabled };
  await db
    .insert(schema.appSettings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } });
  return next;
}

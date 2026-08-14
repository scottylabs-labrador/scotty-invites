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

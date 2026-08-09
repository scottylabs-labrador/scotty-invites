import { randomBytes, createHash, timingSafeEqual, randomInt } from "node:crypto";

/** URL-safe random token (default 32 bytes → 43 chars). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Short human-friendly code for event short links (no ambiguous chars). */
export function newShortCode(length = 7): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function newSixDigitCode(): string {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

/**
 * Invite code for an invite-only event. Reuses the short-code alphabet (no
 * i/l/o/0/1) because people read these off a Slack message and type them on a
 * phone. ~31^8 ≈ 8.5e11 possibilities.
 */
export function newInviteCode(): string {
  return newShortCode(8);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function initialsOf(nameOrEmail: string): string {
  const source = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const parts = source
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

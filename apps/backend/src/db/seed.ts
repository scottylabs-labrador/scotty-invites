import { and, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "./client";
import { env, isCmuEmail } from "../env";
import { newInviteCode } from "../lib/crypto";

export const COMMITTEES: { slug: string; name: string; color: string; isAllClub?: boolean }[] = [
  { slug: "scottylabs", name: "ScottyLabs", color: "#1e1e1e", isAllClub: true },
  { slug: "events", name: "Events", color: "#d72444" },
  { slug: "tech", name: "Tech", color: "#0e96d1" },
  { slug: "design", name: "Design", color: "#6940c9" },
  { slug: "foundry", name: "Foundry", color: "#063f58" },
  { slug: "outreach", name: "Outreach", color: "#df6f3c" },
  { slug: "finance", name: "Finance", color: "#3a9a4c" },
  { slug: "labrador", name: "Labrador", color: "#e8b13a" },
  { slug: "bootcamp", name: "Bootcamp", color: "#5f6f7f" },
];

export async function seed(): Promise<void> {
  for (let i = 0; i < COMMITTEES.length; i++) {
    const c = COMMITTEES[i];
    await db
      .insert(schema.committees)
      .values({ slug: c.slug, name: c.name, color: c.color, isAllClub: c.isAllClub ?? false, sort: i })
      .onConflictDoUpdate({
        target: schema.committees.slug,
        set: { name: c.name, color: c.color, isAllClub: c.isAllClub ?? false, sort: i },
      });
  }

  if (env.seedSuperAdminEmails.length > 0) {
    const allClub = (await db.select().from(schema.committees).where(eq(schema.committees.slug, "scottylabs")))[0];
    for (const email of env.seedSuperAdminEmails) {
      await db
        .insert(schema.admins)
        .values({
          email,
          committeeId: allClub.id,
          role: "super_admin",
          domainExempt: !isCmuEmail(email),
          invitedByEmail: "seed",
        })
        .onConflictDoUpdate({ target: schema.admins.email, set: { role: "super_admin" } });
    }
    console.log(`[db] seeded super admins: ${env.seedSuperAdminEmails.join(", ")}`);
  }

  await backfillInviteCodes();
}

/**
 * Repairs invite-only events that have no invite code. Until the update handler
 * learned to mint one, switching an event to invite-only via PATCH left the code
 * NULL — and a NULL code matched an empty submission, so the gate let everyone in.
 * Idempotent: only touches rows that are actually broken.
 */
async function backfillInviteCodes(): Promise<void> {
  const broken = await db
    .select({ id: schema.events.id, shortCode: schema.events.shortCode })
    .from(schema.events)
    .where(and(eq(schema.events.model, "invite"), or(isNull(schema.events.inviteCode), eq(schema.events.inviteCode, ""))));
  if (broken.length === 0) return;

  for (const e of broken) {
    await db.update(schema.events).set({ inviteCode: newInviteCode(), listed: false }).where(eq(schema.events.id, e.id));
  }
  console.log(
    `[db] repaired ${broken.length} invite-only event(s) with no invite code: ${broken.map((e) => e.shortCode).join(", ")}`,
  );
}

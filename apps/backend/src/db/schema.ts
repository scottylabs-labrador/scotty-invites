import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  customType,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const committees = pgTable("committees", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  isAllClub: boolean("is_all_club").notNull().default(false),
  sort: integer("sort").notNull().default(0),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  name: text("name"),
  andrewId: text("andrew_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    persistent: boolean("persistent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    codeHash: text("code_hash").notNull(),
    keepSignedIn: boolean("keep_signed_in").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("magic_links_email_idx").on(t.email, t.createdAt)],
);

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  committeeId: uuid("committee_id")
    .notNull()
    .references(() => committees.id),
  role: text("role", { enum: ["admin", "super_admin"] })
    .notNull()
    .default("admin"),
  domainExempt: boolean("domain_exempt").notNull().default(false),
  invitedByEmail: text("invited_by_email"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().generatedAlwaysAsIdentity(),
    shortCode: text("short_code").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    committeeId: uuid("committee_id")
      .notNull()
      .references(() => committees.id),
    category: text("category").notNull(),
    audience: text("audience", { enum: ["cmu", "cmu_guests", "public"] }).notNull(),
    model: text("model", { enum: ["instant", "capacity", "approval", "invite"] }).notNull(),
    capacity: integer("capacity"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    location: text("location").notNull(),
    locationShort: text("location_short"),
    artwork: text("artwork").notNull().default("brand"),
    passStyle: text("pass_style", { enum: ["dark", "light"] }).notNull().default("dark"),
    stampCommittee: boolean("stamp_committee").notNull().default(true),
    allowPlusOne: boolean("allow_plus_one").notNull().default(false),
    flagship: boolean("flagship").notNull().default(false),
    listed: boolean("listed").notNull().default(true),
    inviteCode: text("invite_code"),
    updatesEmail: text("updates_email").notNull(),
    contactEmail: text("contact_email").notNull(),
    digest: text("digest", { enum: ["hourly", "daily", "weekly"] }).notNull().default("daily"),
    status: text("status", { enum: ["draft", "published", "cancelled"] })
      .notNull()
      .default("published"),
    createdByEmail: text("created_by_email").notNull(),
    lastDigestAt: timestamp("last_digest_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_start_idx").on(t.startAt), index("events_committee_idx").on(t.committeeId)],
);

export const eventQuestions = pgTable(
  "event_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["standard", "custom"] }).notNull(),
    key: text("key"),
    label: text("label").notNull(),
    type: text("type", { enum: ["short", "long", "select", "file"] }).notNull().default("short"),
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").notNull().default(false),
    visible: boolean("visible").notNull().default(true),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("event_questions_event_idx").on(t.eventId)],
);

export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", { enum: ["pending", "approved", "waitlisted", "declined", "cancelled"] })
      .notNull()
      .default("pending"),
    fullName: text("full_name").notNull(),
    major: text("major"),
    classYear: text("class_year"),
    dietary: jsonb("dietary").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    resumeFileId: uuid("resume_file_id"),
    source: text("source"),
    plusOne: boolean("plus_one").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("registrations_event_user_uq").on(t.eventId, t.userId),
    index("registrations_event_status_idx").on(t.eventId, t.status),
  ],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => eventQuestions.id, { onDelete: "cascade" }),
    value: jsonb("value").notNull(),
  },
  (t) => [uniqueIndex("answers_reg_question_uq").on(t.registrationId, t.questionId)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    registrationId: uuid("registration_id").references(() => registrations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: ["primary", "plus_one"] }).notNull().default("primary"),
    parentTicketId: uuid("parent_ticket_id"),
    number: integer("number").notNull(),
    serial: text("serial").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tickets_event_serial_uq").on(t.eventId, t.serial),
    uniqueIndex("tickets_registration_uq").on(t.registrationId),
    uniqueIndex("tickets_parent_uq").on(t.parentTicketId),
    index("tickets_user_idx").on(t.userId),
  ],
);

/**
 * +1 transfer links. No secret is stored: the shareable token is an HMAC over
 * (id, rotation) with TRANSFER_LINK_SECRET, so the owner's link can be
 * re-displayed any time yet nothing at rest can be stolen. Revoking bumps
 * status; regenerating bumps rotation (old links die immediately).
 */
export const ticketTransfers = pgTable(
  "ticket_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    rotation: integer("rotation").notNull().default(0),
    status: text("status", { enum: ["active", "claimed", "revoked"] }).notNull().default("active"),
    claimedByUserId: uuid("claimed_by_user_id").references(() => users.id),
    claimedTicketId: uuid("claimed_ticket_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("ticket_transfers_ticket_uq").on(t.ticketId)],
);

export const checkins = pgTable(
  "checkins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id),
    serialAttempted: text("serial_attempted"),
    result: text("result", { enum: ["ok", "duplicate", "denied"] }).notNull(),
    plusOne: boolean("plus_one").notNull().default(false),
    method: text("method", { enum: ["qr", "manual"] }).notNull().default("qr"),
    byEmail: text("by_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("checkins_event_idx").on(t.eventId, t.createdAt)],
);

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  email: citext("email").notNull(),
  scope: text("scope").notNull(), // "all" or a committee id
  label: text("label"),
  clientId: text("client_id"),
  refreshTokenHash: text("refresh_token_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** OAuth 2.1 public clients (dynamic registration, RFC 7591). */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Short-lived authorization codes (PKCE-bound, single use). */
export const oauthCodes = pgTable("oauth_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  email: citext("email").notNull(),
  scope: text("scope").notNull(), // "all" or a committee id
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull().default("resume"),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

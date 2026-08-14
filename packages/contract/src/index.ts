import { initContract } from "@ts-rest/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums & value objects
// ---------------------------------------------------------------------------

export const EVENT_CATEGORIES = ["Work sessions", "Workshops", "Socials", "Hackathons"] as const;
export const EventCategory = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof EventCategory>;

export const EVENT_AUDIENCES = ["cmu", "cmu_guests", "public"] as const;
export const EventAudience = z.enum(EVENT_AUDIENCES);
export type EventAudience = z.infer<typeof EventAudience>;

export const AUDIENCE_LABELS: Record<EventAudience, string> = {
  cmu: "CMU only",
  cmu_guests: "CMU + guests",
  public: "Public",
};

export const EVENT_MODELS = ["instant", "capacity", "approval", "invite"] as const;
export const EventModel = z.enum(EVENT_MODELS);
export type EventModel = z.infer<typeof EventModel>;

export const ARTWORKS = ["brand", "cool", "warm", "sunset"] as const;
export const Artwork = z.enum(ARTWORKS);
export type Artwork = z.infer<typeof Artwork>;

export const DIGESTS = ["hourly", "daily", "weekly"] as const;
export const Digest = z.enum(DIGESTS);
export type Digest = z.infer<typeof Digest>;

export const PassStyle = z.enum(["dark", "light"]);
export type PassStyle = z.infer<typeof PassStyle>;

export const QuestionType = z.enum(["short", "long", "select", "file"]);
export type QuestionType = z.infer<typeof QuestionType>;

/**
 * How many custom questions one event may carry after publishing. Registration
 * sends one answer per answerable question (every custom question plus phone and
 * t-shirt), so `RegisterBody.custom`'s cap must stay above this + 2 — otherwise a
 * generous organizer makes every signup fail zod, and a zod failure reaches the
 * guest as an unreadable body with no `message` field.
 */
export const MAX_CUSTOM_QUESTIONS = 34;

export const STANDARD_QUESTION_KEYS = ["major_year", "dietary", "resume", "source", "phone", "tshirt"] as const;
export const StandardQuestionKey = z.enum(STANDARD_QUESTION_KEYS);
export type StandardQuestionKey = z.infer<typeof StandardQuestionKey>;

export const RegistrationStatus = z.enum(["pending", "approved", "waitlisted", "declined", "cancelled"]);
export type RegistrationStatus = z.infer<typeof RegistrationStatus>;

export const DIETARY_OPTIONS = ["Vegetarian", "Vegan", "Halal", "Kosher", "Gluten-free", "Nut allergy"] as const;
export const SOURCE_OPTIONS = [
  "Slack",
  "Instagram",
  "A friend's +1 invite",
  "Poster on campus",
  "GBM",
  "Other",
] as const;
export const MAJOR_OPTIONS = ["Information Systems", "Computer Science", "ECE", "Design", "Business", "Other"] as const;
export const CLASS_YEAR_OPTIONS = ["2026", "2027", "2028", "2029", "2030", "Grad"] as const;

export const Committee = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string(),
  isAllClub: z.boolean(),
});
export type Committee = z.infer<typeof Committee>;

export const QuestionControls = z.object({
  major_year: z.boolean(),
  dietary: z.boolean(),
  resume: z.boolean(),
  source: z.boolean(),
  phone: z.boolean(),
  tshirt: z.boolean(),
});

export const TSHIRT_OPTIONS = ["S", "M", "L", "XL", "XXL"] as const;
export type QuestionControls = z.infer<typeof QuestionControls>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const Me = z.object({
  user: z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      andrewId: z.string().nullable(),
      initials: z.string(),
    })
    .nullable(),
  admin: z
    .object({
      role: z.enum(["admin", "super_admin"]),
      committee: Committee,
    })
    .nullable(),
});
export type Me = z.infer<typeof Me>;

// ---------------------------------------------------------------------------
// Events — browse & detail
// ---------------------------------------------------------------------------

export const BrowseEvent = z.object({
  shortCode: z.string(),
  title: z.string(),
  number: z.number(),
  startAt: z.string(),
  endAt: z.string(),
  location: z.string(),
  category: EventCategory,
  audience: EventAudience,
  model: EventModel,
  capacity: z.number().nullable(),
  approvedCount: z.number(),
  full: z.boolean(),
  flagship: z.boolean(),
  artwork: Artwork,
  committee: Committee,
  description: z.string(),
  myStatus: RegistrationStatus.nullable(),
});
export type BrowseEvent = z.infer<typeof BrowseEvent>;

export const EventQuestion = z.object({
  id: z.string(),
  kind: z.enum(["standard", "custom"]),
  key: StandardQuestionKey.nullable(),
  label: z.string(),
  type: QuestionType,
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
});
export type EventQuestion = z.infer<typeof EventQuestion>;

/**
 * The organizer's view of a question. Three fields the public page must never
 * carry: whether the question is switched on for this event, where it sits, and
 * how many people have already answered it — which is what freezes its type and
 * options. Widening `EventQuestion` itself would leak all three into the public
 * `EventDetail`, so this extends it instead, the same way `deletable` is a
 * server-computed affordance on `OrgEventDetail`.
 */
export const OrgEventQuestion = EventQuestion.extend({
  visible: z.boolean(),
  sort: z.number(),
  answerCount: z.number(),
});
export type OrgEventQuestion = z.infer<typeof OrgEventQuestion>;

export const EventDetail = z.object({
  id: z.string(),
  shortCode: z.string(),
  title: z.string(),
  description: z.string(),
  /** "cancelled" events still resolve by link — the page must say so rather than
   *  offering an RSVP button that 404s on submit. */
  status: z.enum(["published", "cancelled"]),
  /** Only populated for a scoped admin, so the organizer's "Copy invite link"
   *  works from the public page. Guests never receive it. */
  inviteCode: z.string().nullable(),
  number: z.number(),
  startAt: z.string(),
  endAt: z.string(),
  location: z.string(),
  locationShort: z.string(),
  category: EventCategory,
  audience: EventAudience,
  model: EventModel,
  capacity: z.number().nullable(),
  approvedCount: z.number(),
  full: z.boolean(),
  flagship: z.boolean(),
  artwork: Artwork,
  passStyle: PassStyle,
  stampCommittee: z.boolean(),
  allowPlusOne: z.boolean(),
  contactEmail: z.string(),
  committee: Committee,
  questions: z.array(EventQuestion),
  myRegistration: z
    .object({
      id: z.string(),
      status: RegistrationStatus,
      ticketNumber: z.number().nullable(),
    })
    .nullable(),
});
export type EventDetail = z.infer<typeof EventDetail>;

export const RegisterBody = z.object({
  fullName: z.string().min(1).max(120),
  major: z.string().max(80).optional(),
  classYear: z.string().max(20).optional(),
  dietary: z.array(z.string().max(40)).max(12).optional(),
  resumeFileId: z.string().uuid().optional(),
  source: z.string().max(80).optional(),
  plusOne: z.boolean().optional(),
  custom: z
    .array(z.object({ questionId: z.string().uuid(), value: z.string().max(4000) }))
    .max(40)
    .optional(),
  inviteCode: z.string().max(64).optional(),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export const TicketView = z.object({
  id: z.string().nullable(), // null while pending approval (no ticket issued yet)
  registrationId: z.string(),
  serial: z.string().nullable(),
  number: z.number().nullable(),
  kind: z.enum(["primary", "plus_one"]),
  status: z.enum(["pending", "approved", "checked_in"]),
  checkedInAt: z.string().nullable(),
  guestName: z.string(),
  plusOneOnPass: z.boolean(),
  event: z.object({
    shortCode: z.string(),
    title: z.string(),
    committeeName: z.string(),
    committeeColor: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    location: z.string(),
    locationShort: z.string(),
    artwork: Artwork,
    passStyle: PassStyle,
    stampCommittee: z.boolean(),
    contactEmail: z.string(),
  }),
  transfer: z
    .object({
      status: z.enum(["none", "active", "claimed", "revoked"]),
      url: z.string().nullable(),
      claimedByName: z.string().nullable(),
    })
    .nullable(), // null when the ticket has no +1 allowance
});
export type TicketView = z.infer<typeof TicketView>;

export const Stub = z.object({
  serial: z.string(),
  number: z.number(),
  title: z.string(),
  date: z.string(),
  artwork: Artwork,
  checkedIn: z.boolean(),
});
export type Stub = z.infer<typeof Stub>;

export const TransferPreview = z.object({
  status: z.enum(["active", "claimed", "revoked", "invalid"]),
  event: z
    .object({
      title: z.string(),
      startAt: z.string(),
      endAt: z.string(),
      location: z.string(),
      committeeName: z.string(),
      committeeColor: z.string(),
      artwork: Artwork,
      contactEmail: z.string(),
    })
    .nullable(),
  hostName: z.string().nullable(),
});
export type TransferPreview = z.infer<typeof TransferPreview>;

// ---------------------------------------------------------------------------
// Organizer
// ---------------------------------------------------------------------------

export const GuestRow = z.object({
  registrationId: z.string(),
  name: z.string(),
  initials: z.string(),
  andrewId: z.string().nullable(),
  email: z.string(),
  plusOne: z.boolean(),
  plusOneClaimed: z.boolean(),
  major: z.string().nullable(),
  classYear: z.string().nullable(),
  dietary: z.array(z.string()),
  resumeUrl: z.string().nullable(),
  resumeFilename: z.string().nullable(),
  source: z.string().nullable(),
  status: RegistrationStatus,
  serial: z.string().nullable(),
  createdAt: z.string(),
});
export type GuestRow = z.infer<typeof GuestRow>;

export const PendingItem = z.object({
  registrationId: z.string(),
  name: z.string(),
  initials: z.string(),
  andrewId: z.string().nullable(),
  answer: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingItem = z.infer<typeof PendingItem>;

export const EventStatus = z.enum(["draft", "published", "cancelled"]);
export type EventStatus = z.infer<typeof EventStatus>;

export const OrgEventSummary = z.object({
  id: z.string(),
  shortCode: z.string(),
  title: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  committeeName: z.string(),
  committeeColor: z.string(),
  pendingCount: z.number(),
  approvedCount: z.number(),
  capacity: z.number().nullable(),
  model: EventModel,
  status: EventStatus,
});
export type OrgEventSummary = z.infer<typeof OrgEventSummary>;

/**
 * Every field `PATCH /api/org/events/:id` can change, plus the read-only context
 * the edit screen needs to explain itself (committee, invite code, whether the
 * event still has a clean slate for deletion).
 */
export const OrgEventDetail = z.object({
  id: z.string(),
  shortCode: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string(),
  category: EventCategory,
  audience: EventAudience,
  model: EventModel,
  capacity: z.number().nullable(),
  startAt: z.string(),
  endAt: z.string(),
  location: z.string(),
  locationShort: z.string().nullable(),
  artwork: Artwork,
  passStyle: PassStyle,
  stampCommittee: z.boolean(),
  allowPlusOne: z.boolean(),
  flagship: z.boolean(),
  updatesEmail: z.string(),
  contactEmail: z.string(),
  digest: Digest,
  status: EventStatus,
  listed: z.boolean(),
  inviteCode: z.string().nullable(),
  /** Full shareable URL — carries ?code= for invite-only events. */
  shareUrl: z.string(),
  committee: Committee,
  /** Editable through PUT /api/org/events/:id/questions, not through PATCH. */
  questions: z.array(OrgEventQuestion),
  /**
   * The live, club-wide controls — not this event's snapshot. A standard
   * question's `visible` on `OrgEventQuestion` is frozen at creation time; a
   * super admin can switch its global control off afterward, which the public
   * page enforces at request time but the frozen `visible` never reflects. The
   * edit screen needs both to show "off because this event disabled it" vs.
   * "off because it's globally disabled" instead of quietly lying about what
   * guests actually see.
   */
  questionControls: QuestionControls,
  registrationCount: z.number(),
  /** Drives the edit form's warning before an organizer removes the cap. */
  waitlistCount: z.number(),
  /** False once anyone has signed up — the UI offers Cancel instead of Delete. */
  deletable: z.boolean(),
});
export type OrgEventDetail = z.infer<typeof OrgEventDetail>;

export const Dashboard = z.object({
  event: z.object({
    id: z.string(),
    shortCode: z.string(),
    title: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    location: z.string(),
    committeeName: z.string(),
    committeeColor: z.string(),
    model: EventModel,
    capacity: z.number().nullable(),
    inviteCode: z.string().nullable(),
    url: z.string(),
    questionControls: QuestionControls,
  }),
  kpis: z.object({
    requests: z.number(),
    requestsToday: z.number(),
    approved: z.number(),
    capacity: z.number().nullable(),
    waitlist: z.number(),
    plusOnesClaimed: z.number(),
    plusOnesInvited: z.number(),
  }),
  guests: z.array(GuestRow),
  pending: z.array(PendingItem),
  sources: z.array(z.object({ label: z.string(), count: z.number() })),
});
export type Dashboard = z.infer<typeof Dashboard>;

export const CheckinResult = z.object({
  result: z.enum(["ok", "plus_one", "duplicate", "denied"]),
  guestName: z.string().nullable(),
  serial: z.string().nullable(),
  plusOne: z.boolean(),
  hostName: z.string().nullable(),
  originalAt: z.string().nullable(),
  message: z.string(),
});
export type CheckinResult = z.infer<typeof CheckinResult>;

export const CheckinState = z.object({
  event: z.object({
    id: z.string(),
    title: z.string(),
    startAt: z.string(),
    committeeName: z.string(),
    capacity: z.number().nullable(),
    approvedCount: z.number(),
  }),
  stats: z.object({
    checkedIn: z.number(),
    plusOnes: z.number(),
    walkIns: z.number(),
    turnedAway: z.number(),
  }),
  recent: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      serial: z.string().nullable(),
      result: z.enum(["ok", "plus_one", "duplicate", "denied"]),
      at: z.string(),
    }),
  ),
});
export type CheckinState = z.infer<typeof CheckinState>;

export const CreateEventBody = z.object({
  title: z.string().min(1).max(140),
  description: z.string().max(8000),
  committeeId: z.string().uuid(),
  category: EventCategory,
  audience: EventAudience,
  model: EventModel,
  capacity: z.number().int().min(1).max(100000).nullable(),
  startAt: z.string(),
  endAt: z.string(),
  location: z.string().min(1).max(200),
  locationShort: z.string().max(40).optional(),
  captures: QuestionControls,
  hostQuestions: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        type: QuestionType,
        options: z.array(z.string().max(120)).max(20).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(10),
  artwork: Artwork,
  passStyle: PassStyle,
  stampCommittee: z.boolean(),
  allowPlusOne: z.boolean(),
  flagship: z.boolean().optional(),
  updatesEmail: z.string().email(),
  contactEmail: z.string().email(),
  digest: Digest,
});
export type CreateEventBody = z.infer<typeof CreateEventBody>;

export const UpdateEventBody = CreateEventBody.omit({ committeeId: true, captures: true, hostQuestions: true }).partial().extend({
  status: EventStatus.optional(),
});
export type UpdateEventBody = z.infer<typeof UpdateEventBody>;

/** One row of the organizer's question list. `id` absent means "create this one". */
export const QuestionDraft = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(300),
  type: QuestionType,
  options: z.array(z.string().min(1).max(120)).max(20).nullable().optional(),
  required: z.boolean(),
  visible: z.boolean(),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

/** The full desired list. The server reconciles it against what exists. */
export const UpdateQuestionsBody = z.object({ questions: z.array(QuestionDraft).max(40) });
export type UpdateQuestionsBody = z.infer<typeof UpdateQuestionsBody>;

// ---------------------------------------------------------------------------
// Admin portal
// ---------------------------------------------------------------------------

export const AdminRow = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  initials: z.string(),
  committee: Committee,
  role: z.enum(["admin", "super_admin"]),
  domainExempt: z.boolean(),
  status: z.enum(["active", "invited"]),
});
export type AdminRow = z.infer<typeof AdminRow>;

export const McpTokenRow = z.object({
  id: z.string(),
  label: z.string().nullable(),
  email: z.string(),
  scope: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type McpTokenRow = z.infer<typeof McpTokenRow>;

export const AdminOverview = z.object({
  admins: z.array(AdminRow),
  questionControls: QuestionControls,
  committees: z.array(Committee.extend({ adminCount: z.number(), upcomingCount: z.number() })),
  mcp: z.object({ url: z.string(), tokens: z.array(McpTokenRow) }),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

const c = initContract();

const ErrorBody = z.object({ error: z.string(), message: z.string() });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const contract = c.router(
  {
    auth: {
      start: {
        method: "POST",
        path: "/api/auth/start",
        body: z.object({
          email: z.string().email().max(254),
          keepSignedIn: z.boolean().optional(),
          transferToken: z.string().max(128).optional(),
        }),
        responses: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 429: ErrorBody, 502: ErrorBody },
        summary: "Start email verification (magic link + 6-digit code via Mailgun)",
      },
      verify: {
        method: "POST",
        path: "/api/auth/verify",
        body: z.object({
          email: z.string().email().max(254),
          code: z.string().regex(/^\d{6}$/),
        }),
        responses: { 200: Me, 400: ErrorBody, 429: ErrorBody },
      },
      me: {
        method: "GET",
        path: "/api/auth/me",
        responses: { 200: Me },
      },
      signOut: {
        method: "POST",
        path: "/api/auth/signout",
        body: z.object({}).optional(),
        responses: { 200: z.object({ ok: z.literal(true) }) },
      },
    },

    events: {
      list: {
        method: "GET",
        path: "/api/events",
        responses: { 200: z.object({ events: z.array(BrowseEvent) }) },
      },
      get: {
        method: "GET",
        path: "/api/events/:code",
        query: z.object({ inviteCode: z.string().optional() }),
        responses: { 200: EventDetail, 401: ErrorBody, 404: ErrorBody },
      },
      register: {
        method: "POST",
        path: "/api/events/:code/register",
        body: RegisterBody,
        responses: {
          200: z.object({
            registrationId: z.string(),
            status: RegistrationStatus,
            ticketNumber: z.number().nullable(),
          }),
          400: ErrorBody,
          401: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
        },
      },
      cancel: {
        method: "POST",
        path: "/api/registrations/:id/cancel",
        body: z.object({}).optional(),
        responses: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody, 404: ErrorBody },
      },
    },

    tickets: {
      mine: {
        method: "GET",
        path: "/api/me/tickets",
        responses: {
          200: z.object({ tickets: z.array(TicketView), stubs: z.array(Stub) }),
          401: ErrorBody,
        },
      },
      createTransfer: {
        method: "POST",
        path: "/api/tickets/:id/transfer",
        body: z.object({}).optional(),
        responses: {
          200: z.object({ url: z.string(), status: z.enum(["active"]) }),
          400: ErrorBody,
          401: ErrorBody,
          404: ErrorBody,
        },
      },
      revokeTransfer: {
        method: "POST",
        path: "/api/tickets/:id/transfer/revoke",
        body: z.object({}).optional(),
        responses: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody, 404: ErrorBody },
      },
      transferPreview: {
        method: "GET",
        path: "/api/transfers/:token",
        responses: { 200: TransferPreview },
      },
      claimTransfer: {
        method: "POST",
        path: "/api/transfers/:token/claim",
        body: z.object({}).optional(),
        responses: {
          200: z.object({ ticketId: z.string(), serial: z.string() }),
          400: ErrorBody,
          401: ErrorBody,
        },
      },
      googleWallet: {
        method: "GET",
        path: "/api/tickets/:id/google-wallet",
        responses: { 200: z.object({ saveUrl: z.string() }), 401: ErrorBody, 404: ErrorBody, 503: ErrorBody },
      },
    },

    org: {
      myEvents: {
        method: "GET",
        path: "/api/org/events",
        responses: { 200: z.object({ events: z.array(OrgEventSummary) }), 401: ErrorBody, 403: ErrorBody },
      },
      committees: {
        method: "GET",
        path: "/api/org/committees",
        responses: { 200: z.object({ committees: z.array(Committee), questionControls: QuestionControls }), 401: ErrorBody, 403: ErrorBody },
      },
      dashboard: {
        method: "GET",
        path: "/api/org/events/:id/dashboard",
        responses: { 200: Dashboard, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      getEvent: {
        method: "GET",
        path: "/api/org/events/:id",
        responses: { 200: OrgEventDetail, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        summary: "Full editable event for the organizer edit screen",
      },
      approve: {
        method: "POST",
        path: "/api/org/registrations/:id/approve",
        body: z.object({}).optional(),
        responses: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      decline: {
        method: "POST",
        path: "/api/org/registrations/:id/decline",
        body: z.object({}).optional(),
        responses: {
          200: z.object({ ok: z.literal(true), promoted: z.number() }),
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
        },
      },
      deleteEvent: {
        method: "DELETE",
        path: "/api/org/events/:id",
        responses: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      updateEvent: {
        method: "PATCH",
        path: "/api/org/events/:id",
        body: UpdateEventBody,
        responses: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      updateQuestions: {
        method: "PUT",
        path: "/api/org/events/:id/questions",
        body: UpdateQuestionsBody,
        responses: {
          200: z.object({ ok: z.literal(true), questions: z.array(OrgEventQuestion) }),
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
        },
        summary: "Replace an event's question set without destroying answers",
      },
      createEvent: {
        method: "POST",
        path: "/api/org/events",
        body: CreateEventBody,
        responses: {
          200: z.object({ id: z.string(), shortCode: z.string(), url: z.string(), inviteCode: z.string().nullable() }),
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
        },
      },
      checkin: {
        method: "POST",
        path: "/api/org/events/:id/checkin",
        body: z.object({
          serial: z.string().max(64).optional(),
          andrewId: z.string().max(64).optional(),
          method: z.enum(["qr", "manual"]).optional(),
        }),
        responses: { 200: CheckinResult, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      checkinState: {
        method: "GET",
        path: "/api/org/events/:id/checkins",
        responses: { 200: CheckinState, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
    },

    admin: {
      overview: {
        method: "GET",
        path: "/api/admin/overview",
        responses: { 200: AdminOverview, 401: ErrorBody, 403: ErrorBody },
      },
      inviteAdmin: {
        method: "POST",
        path: "/api/admin/admins",
        body: z.object({
          email: z.string().email().max(254),
          committeeId: z.string().uuid(),
          role: z.enum(["admin", "super_admin"]),
        }),
        responses: { 200: AdminRow, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody },
      },
      resendInvite: {
        method: "POST",
        path: "/api/admin/admins/:id/resend",
        body: z.object({}).optional(),
        responses: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      revokeAdmin: {
        method: "DELETE",
        path: "/api/admin/admins/:id",
        responses: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
      setQuestionControl: {
        method: "PATCH",
        path: "/api/admin/question-controls",
        body: z.object({ key: StandardQuestionKey, enabled: z.boolean() }),
        responses: { 200: QuestionControls, 401: ErrorBody, 403: ErrorBody },
      },
      revokeMcpToken: {
        method: "DELETE",
        path: "/api/admin/mcp-tokens/:id",
        responses: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
    },
  },
);

export type Contract = typeof contract;

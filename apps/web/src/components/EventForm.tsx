import { useMemo, useState } from "react";
import type {
  Artwork,
  Committee,
  Digest,
  EventAudience,
  EventCategory,
  EventModel,
  EventQuestion,
  PassStyle,
  QuestionControls,
  QuestionType,
} from "@scottylabs-invites/contract";
import { EVENT_CATEGORIES } from "@scottylabs-invites/contract";
import { LockIcon, PlusIcon, XIcon } from "./icons";
import { GRADIENTS } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

export interface DraftQuestion {
  id: number;
  text: string;
  type: QuestionType;
}

/** Everything both the create and edit screens collect. Dates are kept as the
 *  NY wall-clock pair the inputs use; callers convert with nyWallClockToUtc. */
export interface EventFormValues {
  committeeId: string;
  category: string;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  audience: EventAudience;
  model: EventModel;
  capacity: string;
  captures: Record<string, boolean>;
  questions: DraftQuestion[];
  updatesEmail: string;
  contactEmail: string;
  digest: Digest;
  artwork: Artwork;
  passStyle: PassStyle;
  stampCommittee: boolean;
  flagship: boolean;
  allowPlusOne: boolean;
}

export function emptyEventForm(committeeId = ""): EventFormValues {
  return {
    committeeId,
    category: EVENT_CATEGORIES[0],
    title: "",
    description: "",
    date: "",
    startTime: "19:00",
    endTime: "22:00",
    location: "",
    audience: "cmu",
    model: "instant",
    capacity: "40",
    captures: { major_year: true, dietary: false, resume: false, source: true, phone: false, tshirt: false },
    questions: [{ id: 1, text: "", type: "short" }],
    updatesEmail: "",
    contactEmail: "",
    digest: "daily",
    artwork: "cool",
    passStyle: "dark",
    stampCommittee: true,
    flagship: false,
    allowPlusOne: false,
  };
}

/** Shared client-side checks. Returns the first problem, or null. */
export function validateEventForm(v: EventFormValues): string | null {
  if (!v.title.trim()) return "Give the event a name.";
  if (!v.date) return "Pick a date.";
  if (!v.location.trim()) return "Where is it happening?";
  if (!v.updatesEmail.trim() || !v.contactEmail.trim()) return "Add the updates and contact emails.";
  return null;
}

const TYPE_LABELS: Record<QuestionType, string> = { short: "Short text", long: "Long text", select: "Select", file: "File" };

export function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px", boxShadow: "var(--shadow-sm)" }}>
      <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>{sub}</div>}
      {children}
    </div>
  );
}

export function Switch({ on }: { on: boolean }) {
  return (
    <div style={{ flex: "none", width: 34, height: 19, borderRadius: 100, background: on ? "var(--blue)" : "#aebdcc", position: "relative", transition: "background-color 180ms var(--ease)" }}>
      <div style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: 100, background: "#fff", transition: "left 180ms var(--ease)", boxShadow: "0 1px 2px rgba(30,30,30,0.2)" }} />
    </div>
  );
}

export function seg(on: boolean): React.CSSProperties {
  return on
    ? { all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 100, background: "#1e1e1e", color: "#fff", border: "1px solid #1e1e1e", fontFamily: "var(--font-ui)" }
    : { all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 500, padding: "8px 18px", borderRadius: 100, background: "#fff", color: "var(--muted-1)", border: "1px solid var(--border)", fontFamily: "var(--font-ui)" };
}

const AUDIENCE_NOTES: Record<EventAudience, string> = {
  cmu: "Guests must sign in with an andrew email. IDs verified automatically.",
  cmu_guests: "Andrew sign-in required, but approved guests can transfer a +1 to anyone.",
  public: "Anyone with the link can sign up with any email.",
};

const MODEL_DEFS: { key: EventModel; label: string; sub: string }[] = [
  { key: "instant", label: "Instant RSVP", sub: "One click and they're in. Best for worksessions and GBMs." },
  { key: "capacity", label: "Capacity + waitlist", sub: "Caps signups; the waitlist promotes in order." },
  { key: "approval", label: "Approval required", sub: "You review every request before an invite is issued." },
  { key: "invite", label: "Invite only", sub: "Private link or code. Nothing listed publicly." },
];

export interface EventFormProps {
  mode: "create" | "edit";
  values: EventFormValues;
  onChange: (next: EventFormValues) => void;
  committees: Committee[];
  myCommittee?: Committee | null;
  isSuper: boolean;
  controls?: QuestionControls;
  /** Edit mode: the event's live questions, shown read-only (PATCH can't change them). */
  existingQuestions?: EventQuestion[];
  /** Slot under the Registration card — the invite-link panel on the edit screen. */
  registrationExtra?: React.ReactNode;
  /** Slot at the bottom of the left column — the danger zone on the edit screen. */
  footerExtra?: React.ReactNode;
  /** Slot under the pass preview — publish button, or save/cancel. */
  railActions: React.ReactNode;
}

/**
 * The event form shared by Create and Edit. Both screens render the same cards
 * from the same state shape so they can't drift; `mode` only gates the fields
 * the API genuinely treats differently (committee and the question set are
 * fixed once an event exists, because PATCH cannot change them).
 */
export default function EventForm({
  mode,
  values: v,
  onChange,
  committees,
  myCommittee,
  isSuper,
  controls,
  existingQuestions,
  registrationExtra,
  footerExtra,
  railActions,
}: EventFormProps) {
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) => onChange({ ...v, [key]: value });
  const [nextQid, setNextQid] = useState(() => Math.max(0, ...v.questions.map((q) => q.id)) + 1);

  const isEdit = mode === "edit";
  const effectiveCommitteeId = v.committeeId || myCommittee?.id || "";
  const selectedCommittee = committees.find((c) => c.id === effectiveCommitteeId) ?? myCommittee;

  const captureDefs = useMemo(() => {
    const base = [
      { key: "major_year", label: "Major + class year", note: "two dropdowns" },
      { key: "dietary", label: "Dietary restrictions", note: "for food orders" },
      { key: "resume", label: "Resume upload", note: "PDF, optional for guests" },
      { key: "source", label: "How they heard about it", note: "source tracking" },
      { key: "phone", label: "Phone number", note: "off by default" },
      { key: "tshirt", label: "T-shirt size", note: "off by default" },
    ];
    if (!controls) return base.slice(0, 4);
    return base.filter((c) => controls[c.key as keyof QuestionControls]);
  }, [controls]);

  const previewStamp = v.date
    ? `${new Date(`${v.date}T${v.startTime}:00`).toLocaleString("en-US", { month: "short" }).toUpperCase()} ${String(new Date(`${v.date}T${v.startTime}:00`).getDate()).padStart(2, "0")} · ${v.startTime}`
    : "OCT 03 · 16:00";
  const previewLoc = (v.location || "Location TBD").split(",")[0].toUpperCase().slice(0, 18);
  const dark = v.passStyle === "dark";
  const mutedFg = dark ? "rgba(255,255,255,0.65)" : "#5f6f7f";

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 24, alignItems: "flex-start", fontFamily: "var(--font-ui)" }}>
      {/* Left column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: "1 1 480px", minWidth: 0 }}>
        <Card title="Basics">
          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", maxWidth: 280 }}>
                <span className="field-label">
                  Committee{" "}
                  <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>
                    {isEdit
                      ? "— fixed once the event exists"
                      : isSuper
                        ? "— pick ScottyLabs for all-club events like GBMs"
                        : "— stamped from your admin role"}
                  </span>
                </span>
                <select
                  className="input"
                  value={effectiveCommitteeId}
                  disabled={isEdit || !isSuper}
                  onChange={(e) => set("committeeId", e.target.value)}
                >
                  {(committees.length ? committees : myCommittee ? [myCommittee] : []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 180px", maxWidth: 220 }}>
                <span className="field-label">Category</span>
                <select className="input" value={v.category} onChange={(e) => set("category", e.target.value)}>
                  {EVENT_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Event name</span>
              <input
                value={v.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="e.g. Bootcamp: React fundamentals"
                className="input"
                style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, padding: "12px 14px" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Description</span>
              <textarea className="input" rows={3} placeholder="What happens, who it's for, what to bring." value={v.description} onChange={(e) => set("description", e.target.value)} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.9fr 0.9fr", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="field-label">Date</span>
                <input type="date" className="input" value={v.date} onChange={(e) => set("date", e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="field-label">Starts</span>
                <input type="time" className="input" value={v.startTime} onChange={(e) => set("startTime", e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="field-label">Ends</span>
                <input type="time" className="input" value={v.endTime} onChange={(e) => set("endTime", e.target.value)} />
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Location</span>
              <input className="input" placeholder="Tepper 2612" value={v.location} onChange={(e) => set("location", e.target.value)} />
            </label>
          </div>
        </Card>

        <Card title="Who can sign up">
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {(["cmu", "cmu_guests", "public"] as const).map((a) => (
              <button
                key={a}
                style={seg(v.audience === a)}
                onClick={() =>
                  // On create the +1 allowance follows the audience; on edit it's
                  // an explicit toggle below, so leave the organizer's choice alone.
                  onChange({ ...v, audience: a, ...(isEdit ? {} : { allowPlusOne: a !== "cmu" }) })
                }
              >
                {a === "cmu" ? "CMU only" : a === "cmu_guests" ? "CMU + guests" : "Public"}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 10 }}>{AUDIENCE_NOTES[v.audience]}</div>
          {isEdit && (
            <button
              onClick={() => set("allowPlusOne", !v.allowPlusOne)}
              style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}
            >
              <Switch on={v.allowPlusOne} />
              <span style={{ fontSize: 12.5, color: "var(--muted-1)" }}>Approved guests can transfer a +1</span>
            </button>
          )}
        </Card>

        <Card title="Registration">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 14 }}>
            {MODEL_DEFS.map((m) => {
              const on = v.model === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => set("model", m.key)}
                  style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", border: `1.5px solid ${on ? "var(--blue)" : "var(--border)"}`, background: on ? "var(--blue-subtle)" : "#fff", borderRadius: 10, padding: "13px 15px", transition: "border-color 120ms" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: "none", width: 15, height: 15, borderRadius: 100, border: on ? "5px solid var(--blue)" : "1.5px solid #aebdcc", background: "#fff", boxSizing: "border-box" }} />
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{m.label}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted-2)", marginTop: 5, lineHeight: 1.4 }}>{m.sub}</div>
                </button>
              );
            })}
          </div>
          {v.model === "capacity" && (
            <label className="fade-in" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
              <span className="field-label">Capacity</span>
              <input className="input" style={{ width: 70, padding: "8px 12px" }} value={v.capacity} inputMode="numeric" onChange={(e) => set("capacity", e.target.value.replace(/\D/g, ""))} />
              <span style={{ fontSize: 12, color: "var(--muted-3)" }}>Waitlist opens automatically when full.</span>
            </label>
          )}
          {v.model === "invite" && !registrationExtra && (
            <div className="fade-in" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: "var(--muted-1)" }}>
              <LockIcon size={14} />
              Only people with the invite link or a +1 transfer can sign up. Link generated on publish.
            </div>
          )}
          {registrationExtra}
        </Card>

        {isEdit ? (
          <Card title="Signup questions" sub="Fixed after publishing — guests who already answered would be left with orphaned responses.">
            <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
              {(existingQuestions ?? []).filter((q) => q.kind === "custom" || q.key).length === 0 && (
                <div style={{ fontSize: 12.5, color: "var(--muted-3)", padding: "8px 0" }}>Name and andrew ID only.</div>
              )}
              {(existingQuestions ?? []).map((q) => (
                <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{q.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>
                    {q.kind === "custom" ? "your question" : "standard"} · {TYPE_LABELS[q.type].toLowerCase()}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <>
            <Card title="Data to capture" sub="Andrew ID and name come free with andrew sign-in. Ask only for what this event needs.">
              <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)", opacity: 0.65 }}>
                  <Switch on />
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>Andrew ID + name</span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>always on</span>
                </div>
                {captureDefs.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => set("captures", { ...v.captures, [c.key]: !v.captures[c.key] })}
                    style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)" }}
                  >
                    <Switch on={!!v.captures[c.key]} />
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{c.label}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>{c.note}</span>
                  </button>
                ))}
              </div>
            </Card>

            <Card title="Your questions" sub="Edit inline — guests see them in this order on the signup form.">
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
                {v.questions.map((q) => (
                  <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: "var(--panel)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aebdcc" strokeWidth="2" strokeLinecap="round">
                      <line x1="4" y1="8" x2="20" y2="8" />
                      <line x1="4" y1="16" x2="20" y2="16" />
                    </svg>
                    <input
                      value={q.text}
                      onChange={(e) => set("questions", v.questions.map((x) => (x.id === q.id ? { ...x, text: e.target.value } : x)))}
                      placeholder="Ask anything — e.g. GitHub handle, team size"
                      style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-ui)", fontSize: 13.5, color: "var(--text)" }}
                    />
                    <select
                      value={q.type}
                      onChange={(e) => set("questions", v.questions.map((x) => (x.id === q.id ? { ...x, type: e.target.value as QuestionType } : x)))}
                      style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--muted-1)", background: "#fff", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 6px", outline: "none" }}
                    >
                      {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => set("questions", v.questions.filter((x) => x.id !== q.id))}
                      style={{ all: "unset", cursor: "pointer", color: "var(--muted-3)", display: "flex" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-3)")}
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}
                <button
                  className="dropzone"
                  style={{ padding: 12, fontWeight: 500 }}
                  onClick={() => {
                    set("questions", [...v.questions, { id: nextQid, text: "", type: "short" }]);
                    setNextQid(nextQid + 1);
                  }}
                >
                  <PlusIcon size={14} />
                  Add a question
                </button>
              </div>
            </Card>
          </>
        )}

        <Card title="Updates & contact" sub="Status emails go out via Mailgun. Every invite shows a contact.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Send status updates to</span>
              <input className="input" placeholder="your-committee@scottylabs.org" type="email" value={v.updatesEmail} onChange={(e) => set("updatesEmail", e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Contact email on the invite</span>
              <input className="input" placeholder="hello@scottylabs.org" type="email" value={v.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
            </label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <span className="field-label">Digest frequency</span>
            <div style={{ display: "flex", gap: 8 }}>
              {(["hourly", "daily", "weekly"] as const).map((dg) => (
                <button key={dg} style={seg(v.digest === dg)} onClick={() => set("digest", dg)}>
                  {dg[0].toUpperCase() + dg.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted-3)", marginTop: 12, lineHeight: 1.5 }}>
            Digests cover new signups and reviews waiting. Requests pending more than 24 hours email immediately.
          </div>
        </Card>

        {footerExtra}
      </div>

      {/* Right sticky rail */}
      <div style={{ position: "sticky", top: 96, display: "flex", flexDirection: "column", gap: 16, flex: "1 1 320px", maxWidth: 380 }}>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 20, boxShadow: "var(--shadow-sm)" }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <div style={{ fontFamily: "var(--font-brand)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Scotty Invite preview</div>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-3)" }}>what guests get</span>
          </div>
          <div
            style={
              dark
                ? { background: "var(--black-surface)", borderRadius: 14, overflow: "hidden", marginTop: 14, boxShadow: "0 8px 24px rgba(30,30,30,0.18)" }
                : { background: "#fff", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", marginTop: 14, boxShadow: "var(--shadow-md)" }
            }
          >
            <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <img src={logo} style={{ height: 20, filter: dark ? "brightness(0) invert(1)" : undefined }} alt="" />
              <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: mutedFg }}>Nº 001</span>
            </div>
            <div style={{ background: GRADIENTS[v.artwork], padding: "16px 14px" }}>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.85)" }}>
                {!v.stampCommittee
                  ? "Scotty invite"
                  : selectedCommittee?.isAllClub
                    ? "ScottyLabs · all-club"
                    : `${selectedCommittee?.name ?? ""} committee`}
              </div>
              <div style={{ fontFamily: "var(--font-brand)", fontSize: 19, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginTop: 3, lineHeight: 1.2 }}>
                {v.title || "Your event"}
              </div>
            </div>
            <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", borderTop: `1.5px dashed ${dark ? "rgba(255,255,255,0.25)" : "#d9e1e7"}` }}>
              <span className="mono" style={{ fontSize: 9, color: mutedFg }}>{previewStamp}</span>
              <span className="mono" style={{ fontSize: 9, color: mutedFg }}>{previewLoc}</span>
            </div>
            <div className="mono" style={{ padding: "0 14px 12px", fontSize: 8.5, color: mutedFg, textAlign: "center" }}>
              questions? {v.contactEmail || "hello@scottylabs.org"}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {(Object.keys(GRADIENTS).filter((k) => k !== "deep") as Artwork[]).map((k) => (
                <button
                  key={k}
                  title={k}
                  onClick={() => set("artwork", k)}
                  style={{ all: "unset", cursor: "pointer", flex: 1, height: 34, borderRadius: 8, background: GRADIENTS[k], boxSizing: "border-box", border: `2.5px solid ${k === v.artwork ? "#1e1e1e" : "transparent"}` }}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {(["dark", "light"] as const).map((ps) => (
                <button key={ps} style={{ ...seg(v.passStyle === ps), fontSize: 12, padding: "6px 16px" }} onClick={() => set("passStyle", ps as PassStyle)}>
                  {ps[0].toUpperCase() + ps.slice(1)}
                </button>
              ))}
            </div>
            <button onClick={() => set("stampCommittee", !v.stampCommittee)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <Switch on={v.stampCommittee} />
              <span style={{ fontSize: 12.5, color: "var(--muted-1)" }}>Committee stamp on the pass</span>
            </button>
            <button onClick={() => set("flagship", !v.flagship)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <Switch on={v.flagship} />
              <span style={{ fontSize: 12.5, color: "var(--muted-1)" }}>Feature on the browse hero (flagship)</span>
            </button>
          </div>
        </div>

        {railActions}
      </div>
    </div>
  );
}

/** Kept out of the form so both screens format the category the same way. */
export function asCategory(value: string): EventCategory {
  return (EVENT_CATEGORIES as readonly string[]).includes(value) ? (value as EventCategory) : EVENT_CATEGORIES[0];
}

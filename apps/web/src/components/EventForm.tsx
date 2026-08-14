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
  StandardQuestionKey,
} from "@scottylabs-invites/contract";
import { EVENT_CATEGORIES } from "@scottylabs-invites/contract";
import { ChevronDownIcon, ChevronUpIcon, GripIcon, LockIcon, PlusIcon, XIcon } from "./icons";
import { GRADIENTS } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

export interface DraftQuestion {
  /** Local React key and reorder identity. Never sent to the server. */
  id: number;
  /** The server row's uuid, or null for a row that has never been saved. */
  qid: string | null;
  kind: "standard" | "custom";
  key: StandardQuestionKey | null;
  /** The label. Named `text` because that is what the create screen has always called it. */
  text: string;
  type: QuestionType;
  options: string[];
  required: boolean;
  visible: boolean;
  /** Server-computed. Above zero, the type and options are frozen. */
  answerCount: number;
}

/** A fresh custom row whose local id cannot collide with anything already in the list. */
export function blankQuestion(existing: DraftQuestion[]): DraftQuestion {
  return {
    id: Math.max(0, ...existing.map((q) => q.id)) + 1,
    qid: null,
    kind: "custom",
    key: null,
    text: "",
    type: "short",
    options: [],
    required: false,
    visible: true,
    answerCount: 0,
  };
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
    questions: [blankQuestion([])],
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

/** Rows that carry a real question. Blank-label rows are ignored everywhere, exactly
 *  as the create payload silently drops them, so the seeded empty row from
 *  `emptyEventForm` can never block a save. */
function realCustomQuestions(questions: DraftQuestion[]): DraftQuestion[] {
  return questions.filter((q) => q.kind === "custom" && q.text.trim());
}

/** The count rule on its own — the only question rule the scalar save enforces. */
function questionCountProblem(questions: DraftQuestion[], maxCustom: number): string | null {
  const n = realCustomQuestions(questions).length;
  if (n > maxCustom) return `That's ${n} questions — a signup form carries at most ${maxCustom}.`;
  return null;
}

/**
 * The rules for the primary save button on both screens: the scalars, plus the
 * question COUNT — and deliberately not the per-row question rules.
 *
 * This runs on the edit screen too (EditEventPage's `save`), where the request it
 * guards is `PATCH /api/org/events/:id` — and `UpdateEventBody` cannot carry
 * questions at all (packages/contract/src/index.ts:459). Every custom `select` in
 * the database today has `options: null`, because `CreateEventPage.tsx:65` has
 * never sent options, and `toDraftQuestion` (Task 9) maps that to `options: []`.
 * A "select needs at least one option" rule here would therefore refuse to let an
 * organizer fix a typo in the title of any such event, over a payload the request
 * does not even send. Question rules belong to the thing that saves questions.
 */
export function validateEventForm(v: EventFormValues, opts: { maxCustomQuestions?: number } = {}): string | null {
  if (!v.title.trim()) return "Give the event a name.";
  if (!v.date) return "Pick a date.";
  if (!v.location.trim()) return "Where is it happening?";
  if (!v.updatesEmail.trim() || !v.contactEmail.trim()) return "Add the updates and contact emails.";
  return questionCountProblem(v.questions, opts.maxCustomQuestions ?? 10);
}

/**
 * The full question rules, run by whatever is about to SEND questions: the create
 * screen's Publish (which posts `hostQuestions`) and, from Task 9, the edit
 * screen's Save questions button (which PUTs the whole list).
 * Standard rows are skipped: `major_year`, `dietary` and `source` really are
 * stored as type "select" with no options, and a blanket rule would trip on
 * every event that exists.
 */
export function validateQuestions(questions: DraftQuestion[], maxCustom = 10): string | null {
  const count = questionCountProblem(questions, maxCustom);
  if (count) return count;
  for (const q of realCustomQuestions(questions)) {
    const label = q.text.trim();
    if (label.length > 300) return `"${label.slice(0, 30)}…" is too long — keep a question under 300 characters.`;
    if (q.type !== "select") continue;
    const options = q.options.map((o) => o.trim()).filter(Boolean);
    if (options.length === 0) return `Add at least one option to "${label}", or change it to short text.`;
    if (options.length > 20) return `"${label}" has ${options.length} options — 20 is the maximum.`;
    const tooLong = options.find((o) => o.length > 120);
    if (tooLong) return `The option "${tooLong.slice(0, 30)}…" is too long — keep options under 120 characters.`;
  }
  return null;
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const FILE_HINT = "Guests upload a PDF or Word document, up to 5 MB.";

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

/**
 * The question builder, shared by create and edit. `questions` may contain the
 * event's standard rows (edit mode) — those are rendered by the "Data to capture"
 * card, not here, so this component only ever touches the custom slice and always
 * re-emits [standard…, live custom…, hidden custom…] so `sort` stays coherent and
 * retired rows land at the tail.
 */
export function QuestionsCard({
  questions,
  onChange,
  isEdit,
  actions,
}: {
  questions: DraftQuestion[];
  onChange: (next: DraftQuestion[]) => void;
  isEdit: boolean;
  actions?: React.ReactNode;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [handleHeld, setHandleHeld] = useState<number | null>(null);

  const standard = questions.filter((q) => q.kind === "standard");
  const customs = questions.filter((q) => q.kind === "custom");
  /**
   * A custom question that people have answered is never deleted — deleting it
   * cascades its answers away (answers.question_id is ON DELETE CASCADE), so the
   * server keeps it as visible:false instead. Those rows must still travel in
   * every later save, or the next PUT reads as a fresh attempt to remove them; but
   * they must not sit in the live list either, or "remove" would look like it did
   * nothing the moment the server's list came back. Two lists, one array.
   *
   * In create mode `hidden` is always empty — `blankQuestion` sets visible:true and
   * nothing can hide a row that has never been saved.
   */
  const live = customs.filter((q) => q.visible);
  const hidden = customs.filter((q) => !q.visible);
  const commit = (nextLive: DraftQuestion[], nextHidden: DraftQuestion[] = hidden) =>
    onChange([...standard, ...nextLive, ...nextHidden]);
  const patch = (id: number, fields: Partial<DraftQuestion>) =>
    commit(live.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  const clearDrag = () => {
    setDragId(null);
    setOverId(null);
    setHandleHeld(null);
  };

  return (
    <Card title="Your questions" sub="Guests see them in this order on the signup form. Drag the handle, or use the arrows.">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        {live.map((q, i) => {
          const locked = isEdit && q.answerCount > 0;
          return (
            <div
              key={q.id}
              draggable={handleHeld === q.id}
              onDragStart={(e) => {
                // Firefox refuses to start a drag unless setData is called here.
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(q.id));
                setDragId(q.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragId !== null && dragId !== q.id) setOverId(q.id);
              }}
              onDragLeave={(e) => {
                // dragleave also fires for children (the inputs, the buttons), so
                // only clear when the pointer really left this row.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setOverId((cur) => (cur === q.id ? null : cur));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = live.findIndex((x) => x.id === dragId);
                if (from >= 0 && from !== i) commit(move(live, from, i));
                clearDrag();
              }}
              onDragEnd={clearDrag}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "12px 14px",
                background: "var(--panel)",
                borderTop: overId === q.id ? "2px solid var(--blue)" : undefined,
                opacity: dragId === q.id ? 0.45 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  aria-label="Drag to reorder"
                  onMouseDown={() => setHandleHeld(q.id)}
                  onMouseUp={() => setHandleHeld(null)}
                  style={{ all: "unset", cursor: "grab", color: "#aebdcc", display: "flex" }}
                >
                  <GripIcon size={13} />
                </button>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <button
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => commit(move(live, i, i - 1))}
                    style={{ all: "unset", cursor: i === 0 ? "default" : "pointer", display: "flex", color: i === 0 ? "#d9e1e7" : "var(--muted-3)" }}
                  >
                    <ChevronUpIcon size={11} />
                  </button>
                  <button
                    aria-label="Move down"
                    disabled={i === live.length - 1}
                    onClick={() => commit(move(live, i, i + 1))}
                    style={{ all: "unset", cursor: i === live.length - 1 ? "default" : "pointer", display: "flex", color: i === live.length - 1 ? "#d9e1e7" : "var(--muted-3)" }}
                  >
                    <ChevronDownIcon size={11} />
                  </button>
                </div>
                <input
                  value={q.text}
                  onChange={(e) => patch(q.id, { text: e.target.value })}
                  placeholder="Ask anything — e.g. GitHub handle, team size"
                  style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-ui)", fontSize: 13.5, color: "var(--text)" }}
                />
                <button
                  onClick={() => patch(q.id, { required: !q.required })}
                  aria-label="Required"
                  style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: "none" }}
                >
                  <Switch on={q.required} />
                  <span style={{ fontSize: 11.5, color: "var(--muted-3)" }}>Required</span>
                </button>
                <select
                  value={q.type}
                  disabled={locked}
                  onChange={(e) => patch(q.id, { type: e.target.value as QuestionType })}
                  style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--muted-1)", background: "#fff", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 6px", outline: "none" }}
                >
                  {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <button
                  // An answered question cannot be deleted, so hide it locally and
                  // let it drop into the Hidden list right away — the alternative is
                  // a row that vanishes on click and reappears after the save.
                  onClick={() => (locked ? patch(q.id, { visible: false }) : commit(live.filter((x) => x.id !== q.id)))}
                  aria-label={locked ? "Hide question" : "Remove question"}
                  style={{ all: "unset", cursor: "pointer", color: "var(--muted-3)", display: "flex" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-3)")}
                >
                  <XIcon size={14} />
                </button>
              </div>

              {q.type === "select" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 27 }}>
                  {q.options.map((opt, oi) => (
                    <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        className="input"
                        style={{ padding: "6px 10px", fontSize: 12.5, maxWidth: 280 }}
                        value={opt}
                        disabled={locked}
                        placeholder={`Option ${oi + 1}`}
                        onChange={(e) => patch(q.id, { options: q.options.map((o, k) => (k === oi ? e.target.value : o)) })}
                      />
                      {!locked && (
                        <button className="quiet-link" onClick={() => patch(q.id, { options: q.options.filter((_, k) => k !== oi) })}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {!locked && (
                    <button
                      className="dropzone"
                      style={{ padding: 8, fontSize: 12, maxWidth: 280 }}
                      onClick={() => patch(q.id, { options: [...q.options, ""] })}
                    >
                      <PlusIcon size={12} />
                      Add option
                    </button>
                  )}
                </div>
              )}

              {q.type === "file" && (
                <div style={{ paddingLeft: 27, fontSize: 11.5, color: "var(--muted-3)" }}>{FILE_HINT}</div>
              )}

              {locked && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 27, fontSize: 11.5, color: "var(--muted-3)" }}>
                  <LockIcon size={11} />
                  {q.answerCount} {q.answerCount === 1 ? "person has" : "people have"} answered this — its type and options are fixed, removing
                  it moves it to Hidden below instead of deleting it, and rewording it changes the prompt shown next to their existing answers.
                </div>
              )}
            </div>
          );
        })}
        <button className="dropzone" style={{ padding: 12, fontWeight: 500 }} onClick={() => commit([...live, blankQuestion(questions)])}>
          <PlusIcon size={14} />
          Add a question
        </button>

        {hidden.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: "var(--muted-3)" }}>
              <LockIcon size={11} />
              Hidden — answers kept
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted-3)", lineHeight: 1.5 }}>
              Guests no longer see these, and they keep their CSV column and every answer already given.
            </div>
            {hidden.map((q) => (
              <div
                key={q.id}
                style={{ display: "flex", alignItems: "center", gap: 10, border: "1px dashed #d9e1e7", borderRadius: 8, padding: "10px 14px", background: "var(--canvas-muted)" }}
              >
                <span style={{ fontSize: 13, color: "var(--muted-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)", flex: "none" }}>
                  {q.answerCount} {q.answerCount === 1 ? "answer" : "answers"}
                </span>
                <button
                  className="quiet-link"
                  style={{ flex: "none" }}
                  onClick={() => commit([...live, { ...q, visible: true }], hidden.filter((x) => x.id !== q.id))}
                >
                  Show again
                </button>
              </div>
            ))}
          </div>
        )}

        {actions}
      </div>
    </Card>
  );
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

            <QuestionsCard questions={v.questions} onChange={(next) => set("questions", next)} isEdit={false} />
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

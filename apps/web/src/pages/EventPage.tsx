import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EventDetail } from "@scottylabs-invites/contract";
import { AUDIENCE_LABELS, CLASS_YEAR_OPTIONS, DIETARY_OPTIONS, MAJOR_OPTIONS, SOURCE_OPTIONS } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner, Tag } from "../components/AppShell";
import {
  ArrowLeftIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  LinkIcon,
  LockIcon,
  MapPinIcon,
  UploadIcon,
} from "../components/icons";
import { GRADIENTS, fmtLongDate, fmtMonthTile, fmtPassStamp, fmtTimeRange, pad3 } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";
import scottyColor from "../assets/scotty-logo-color.png";

export default function EventPage() {
  const { code = "" } = useParams();
  const [params] = useSearchParams();
  const inviteFromUrl = params.get("code") ?? "";
  const [inviteCode, setInviteCode] = useState(inviteFromUrl);
  const [inviteInput, setInviteInput] = useState("");

  const query = useQuery({
    queryKey: ["event", code, inviteCode],
    queryFn: async () => {
      const res = await api.events.get({ params: { code }, query: { inviteCode: inviteCode || undefined } });
      if (res.status === 401) return { gate: true as const };
      return { gate: false as const, detail: unwrap(res, 200) };
    },
  });

  const detail = query.data && !query.data.gate ? query.data.detail : null;

  return (
    <Page>
      <section className="shell">
        <Link
          to="/"
          className="fade-in"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 28, fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 500, color: "var(--muted-2)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-2)")}
        >
          <ArrowLeftIcon size={14} />
          All events
        </Link>

        {query.isLoading && <Spinner />}

        {query.data?.gate && (
          <div style={{ maxWidth: 430, margin: "48px auto 96px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 28, textAlign: "center", fontFamily: "var(--font-ui)" }}>
            <div style={{ width: 44, height: 44, borderRadius: 100, background: "var(--canvas-muted)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
              <LockIcon size={18} style={{ color: "var(--muted-1)" }} />
            </div>
            <div style={{ fontFamily: "var(--font-brand)", fontSize: 20, fontWeight: 700, marginTop: 12 }}>Invite only</div>
            <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--muted-2)", lineHeight: 1.5 }}>
              This event is unlisted. Enter the invite code from your host to see the details and sign up.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <input
                className="input mono"
                placeholder="invite code"
                value={inviteInput}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setInviteInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setInviteCode(inviteInput.trim())}
              />
              <button className="pill pill-blue" style={{ fontSize: 13, padding: "0 20px" }} onClick={() => setInviteCode(inviteInput.trim())}>
                Unlock
              </button>
            </div>
            {inviteCode && <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--danger-text)" }}>That code didn't unlock this event.</div>}
          </div>
        )}

        {detail && <EventBody detail={detail} inviteCode={inviteCode} />}
      </section>
    </Page>
  );
}

function EventBody({ detail, inviteCode }: { detail: EventDetail; inviteCode: string }) {
  // An organizer who arrived through "View event page" has no code in the URL,
  // so fall back to the one the API hands scoped admins — otherwise their
  // "copy link" produces a URL that lands recipients on the lock screen.
  const shareCode = inviteCode || detail.inviteCode || "";
  const codeSuffix = shareCode ? `?code=${encodeURIComponent(shareCode)}` : "";
  const eventPath = `/e/${detail.shortCode}${codeSuffix}`;
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [fullName, setFullName] = useState(me.user?.name ?? "");
  const [major, setMajor] = useState<string>(MAJOR_OPTIONS[0]);
  const [classYear, setClassYear] = useState<string>(CLASS_YEAR_OPTIONS[1]);
  const [diets, setDiets] = useState<string[]>([]);
  const [resume, setResume] = useState<{ id: string; filename: string } | null>(null);
  const [source, setSource] = useState<string>(SOURCE_OPTIONS[0]);
  const [plusOne, setPlusOne] = useState(false);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const showMajorYear = detail.questions.some((q) => q.key === "major_year");
  const showDietary = detail.questions.some((q) => q.key === "dietary");
  const showResume = detail.questions.some((q) => q.key === "resume");
  const showSource = detail.questions.some((q) => q.key === "source");
  const customQuestions = detail.questions.filter((q) => q.kind === "custom");

  const registerMutation = useMutation({
    mutationFn: async () => {
      const res = await api.events.register({
        params: { code: detail.shortCode },
        body: {
          fullName: fullName.trim(),
          major: showMajorYear ? major : undefined,
          classYear: showMajorYear ? classYear : undefined,
          dietary: showDietary ? diets : undefined,
          resumeFileId: resume?.id,
          source: showSource ? source : undefined,
          plusOne: detail.allowPlusOne ? plusOne : undefined,
          custom: customQuestions.map((q) => ({ questionId: q.id, value: custom[q.id] ?? "" })).filter((a) => a.value.trim()),
          inviteCode: inviteCode || undefined,
        },
      });
      return unwrap(res, 200);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["event", detail.shortCode] });
      void qc.invalidateQueries({ queryKey: ["events"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  async function uploadResume(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/files", { method: "POST", body: form, credentials: "include" });
      const body = (await res.json()) as { id?: string; filename?: string; message?: string };
      if (!res.ok || !body.id) throw new Error(body.message ?? "Upload failed");
      setResume({ id: body.id, filename: body.filename ?? file.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function copyEventLink() {
    void navigator.clipboard.writeText(`${window.location.origin}${eventPath}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const spotsLine = detail.capacity
    ? `${detail.approvedCount} of ${detail.capacity} spots ${detail.model === "approval" ? "approved" : "taken"}`
    : `${detail.approvedCount} ${detail.model === "approval" ? "approved" : "going"}`;
  const pct = detail.capacity ? Math.min(100, (detail.approvedCount / detail.capacity) * 100) : 0;

  const state: "open" | "pending" | "approved" | "waitlisted" = detail.myRegistration
    ? detail.myRegistration.status === "approved"
      ? "approved"
      : detail.myRegistration.status === "waitlisted"
        ? "waitlisted"
        : "pending"
    : "open";

  const monthTile = fmtMonthTile(detail.startAt);
  const submitLabel =
    detail.model === "approval" ? "Request an invite" : detail.full ? "Join the waitlist" : detail.model === "invite" ? "Claim my spot" : "Sign up";

  return (
    <div className="fade-in" style={{ display: "flex", flexWrap: "wrap", gap: 48, marginTop: 20, paddingBottom: 80 }}>
      {/* left rail */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: "1 1 300px", maxWidth: 400, minWidth: 280 }}>
        <div
          style={{
            background: GRADIENTS[detail.artwork],
            borderRadius: 16,
            padding: 26,
            display: "flex",
            flexDirection: "column",
            gap: 70,
            boxShadow: "0 8px 24px rgba(30,30,30,0.12)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <img src={logo} style={{ height: 34, filter: "brightness(0) invert(1)" }} alt="" />
            <span className="mono" style={{ fontSize: 12, color: "rgba(255,255,255,0.9)" }}>
              Nº {detail.myRegistration?.ticketNumber ? pad3(detail.myRegistration.ticketNumber) : pad3(detail.number)}
            </span>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.8)" }}>
              Scotty invite
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginTop: 4, lineHeight: 1.2 }}>{detail.title}</div>
          </div>
          <div style={{ borderTop: "2px dashed rgba(255,255,255,0.45)", paddingTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>{fmtPassStamp(detail.startAt)}</span>
            <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", textAlign: "right" }}>{detail.locationShort.toUpperCase()}</span>
          </div>
        </div>

        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14, fontFamily: "var(--font-ui)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted-2)" }}>Hosted by</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={scottyColor} style={{ width: 36, height: 36, borderRadius: 100, objectFit: "cover" }} alt="" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {detail.committee.isAllClub ? "ScottyLabs" : `ScottyLabs ${detail.committee.name}`}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted-2)" }}>{detail.contactEmail}</div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="icon-link" onClick={copyEventLink}>
              <LinkIcon size={14} />
              {copied ? "Copied!" : shareCode ? "Copy invite link" : "Copy event link"}
            </button>
            <a className="icon-link" href={`/api/events/${detail.shortCode}/google-calendar${codeSuffix}`} target="_blank" rel="noreferrer">
              <CalendarIcon size={14} />
              Add to Google Calendar
            </a>
          </div>
        </div>
      </div>

      {/* right column */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", flex: "1 1 460px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-ui)", flexWrap: "wrap" }}>
          {detail.flagship && <Tag tone="blue">Flagship</Tag>}
          {detail.model === "approval" && <Tag tone="warning">Approval required</Tag>}
          {detail.model === "invite" && <Tag tone="neutral">Invite only</Tag>}
          <Tag tone="neutral">{AUDIENCE_LABELS[detail.audience]}</Tag>
          <Tag tone="committee">{detail.committee.isAllClub ? "All-club" : `${detail.committee.name} committee`}</Tag>
        </div>
        <h1 style={{ margin: "14px 0 0", fontSize: "2.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000", lineHeight: 1.1 }}>{detail.title}</h1>

        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 12, fontFamily: "var(--font-ui)", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, border: "1px solid var(--border)", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", flex: "none" }}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", color: "var(--danger)", textTransform: "uppercase" }}>{monthTile.mon}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", lineHeight: 1 }}>{monthTile.day}</div>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{fmtLongDate(detail.startAt)}</div>
              <div style={{ fontSize: 13, color: "var(--muted-2)" }}>{fmtTimeRange(detail.startAt, detail.endAt, true)}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, border: "1px solid var(--border)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted-1)", flex: "none" }}>
              <MapPinIcon size={18} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{detail.location.split(",")[0]}</div>
              <div style={{ fontSize: 13, color: "var(--muted-2)" }}>{detail.location.split(",").slice(1).join(",").trim() || "Carnegie Mellon University"}</div>
            </div>
          </div>
        </div>

        {detail.description && (
          <div style={{ marginTop: 30, fontFamily: "var(--font-ui)", maxWidth: 640 }}>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted-2)", borderBottom: "1px solid var(--border-subtle)", paddingBottom: 8 }}>
              About this event
            </div>
            {detail.description.split(/\n\n+/).map((para, i) => (
              <p key={i} style={{ margin: i === 0 ? "14px 0 0" : "12px 0 0", fontSize: 15, lineHeight: 1.6, color: "#38424b", textWrap: "pretty", whiteSpace: "pre-wrap" }}>
                {para}
              </p>
            ))}
          </div>
        )}

        {/* Registration panel */}
        <div style={{ marginTop: 34, width: "100%", maxWidth: 640, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", fontFamily: "var(--font-ui)" }}>
          <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontFamily: "var(--font-brand)", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>Registration</div>
            <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted-2)" }}>{spotsLine}</div>
          </div>
          {detail.capacity && (
            <div style={{ height: 4, background: "#d9e1e7" }}>
              <div style={{ height: 4, width: `${pct}%`, background: "var(--blue)", transition: "width 280ms var(--ease)" }} />
            </div>
          )}

          {state === "open" && !me.user && (
            <div style={{ padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--muted-1)", maxWidth: 380 }}>
                Sign in with your CMU email to {detail.model === "approval" ? "request an invite" : "sign up"} — it takes two clicks.
              </p>
              <button className="pill pill-blue" style={{ fontSize: 14, padding: "11px 26px" }} onClick={() => navigate(`/signin?to=${encodeURIComponent(eventPath)}`)}>
                Sign in to continue
              </button>
            </div>
          )}

          {state === "open" && me.user && (
            <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="field-label">Full name</span>
                  <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Tartan" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="field-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    Andrew ID <LockIcon size={11} style={{ color: "var(--muted-3)" }} />
                  </span>
                  <div className="mono" style={{ display: "flex", alignItems: "center", fontSize: 13, color: "var(--muted-2)", padding: "10px 12px", border: "1px solid #d9e1e7", borderRadius: 6, background: "var(--canvas-muted)" }}>
                    {me.user.andrewId ?? me.user.email.split("@")[0]}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--muted-3)" }}>
                      {me.user.andrewId ? "via andrew sign-in" : "via email sign-in"}
                    </span>
                  </div>
                </label>
                {showMajorYear && (
                  <>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Major</span>
                      <select className="input" value={major} onChange={(e) => setMajor(e.target.value)}>
                        {MAJOR_OPTIONS.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Class year</span>
                      <select className="input" value={classYear} onChange={(e) => setClassYear(e.target.value)}>
                        {CLASS_YEAR_OPTIONS.map((y) => (
                          <option key={y}>{y}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </div>

              {showDietary && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span className="field-label">Dietary restrictions</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {DIETARY_OPTIONS.map((dt) => {
                      const on = diets.includes(dt);
                      return (
                        <button
                          key={dt}
                          className={`diet-chip ${on ? "diet-chip-on" : "diet-chip-off"}`}
                          onClick={() => setDiets(on ? diets.filter((x) => x !== dt) : [...diets, dt])}
                        >
                          {dt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {showResume && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span className="field-label">
                    Resume <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>— optional, shared with {detail.committee.name} mentors only</span>
                  </span>
                  {!resume ? (
                    <>
                      <button className="dropzone" disabled={uploading} onClick={() => fileInput.current?.click()}>
                        <UploadIcon size={16} />
                        {uploading ? "Uploading…" : "Drop your resume here, or click to browse"}
                      </button>
                      <input
                        ref={fileInput}
                        type="file"
                        accept=".pdf,.doc,.docx,application/pdf"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadResume(f);
                          e.target.value = "";
                        }}
                      />
                    </>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--success-border)", background: "var(--success-bg)", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "var(--success-text)" }}>
                      <CheckIcon size={15} style={{ color: "var(--success)" }} />
                      {resume.filename}
                      <button className="quiet-link" style={{ marginLeft: "auto" }} onClick={() => setResume(null)}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )}

              {customQuestions.map((q) => (
                <label key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="field-label">
                    {q.label} <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>— host question</span>
                  </span>
                  {q.type === "long" ? (
                    <textarea className="input" rows={2} placeholder="A sentence or two is plenty" value={custom[q.id] ?? ""} onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })} />
                  ) : q.type === "select" && q.options?.length ? (
                    <select className="input" value={custom[q.id] ?? ""} onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })}>
                      <option value="">Choose…</option>
                      {q.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input className="input" value={custom[q.id] ?? ""} onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })} />
                  )}
                </label>
              ))}

              {showSource && (
                <label style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 280 }}>
                  <span className="field-label">How did you hear about this?</span>
                  <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                    {SOURCE_OPTIONS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              )}

              {detail.allowPlusOne && (
                <button
                  onClick={() => setPlusOne(!plusOne)}
                  style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", background: "#fff" }}
                >
                  <div style={{ flex: "none", width: 36, height: 20, borderRadius: 100, background: plusOne ? "var(--blue)" : "#aebdcc", position: "relative", transition: "background-color 180ms var(--ease)" }}>
                    <div style={{ position: "absolute", top: 2, left: plusOne ? 18 : 2, width: 16, height: 16, borderRadius: 100, background: "#fff", transition: "left 180ms var(--ease)", boxShadow: "0 1px 2px rgba(30,30,30,0.2)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Bring a +1</div>
                    <div style={{ fontSize: 12, color: "var(--muted-2)" }}>You'll get a transferable invite link to send a friend once you're approved.</div>
                  </div>
                </button>
              )}

              {error && <div style={{ fontSize: 13, color: "var(--danger-text)" }}>{error}</div>}

              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
                <button
                  className="pill pill-blue"
                  style={{ fontSize: 15, padding: "12px 30px" }}
                  disabled={registerMutation.isPending || !fullName.trim()}
                  onClick={() => {
                    setError(null);
                    registerMutation.mutate();
                  }}
                >
                  {registerMutation.isPending ? "Sending…" : submitLabel}
                </button>
                <span style={{ fontSize: 12, color: "var(--muted-3)", maxWidth: 300 }}>
                  Your name, andrew ID, and answers go to ScottyLabs organizers — nowhere else.
                </span>
              </div>
            </div>
          )}

          {(state === "pending" || state === "waitlisted") && (
            <div className="fade-in" style={{ padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              <div style={{ width: 44, height: 44, borderRadius: 100, background: "var(--blue-subtle)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ClockIcon size={20} style={{ color: "var(--blue)" }} />
              </div>
              <div style={{ fontFamily: "var(--font-brand)", fontSize: 20, fontWeight: 700, color: "var(--text)" }}>
                {state === "waitlisted" ? "You're on the waitlist" : "Request sent"}
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--muted-1)", maxWidth: 380 }}>
                {state === "waitlisted"
                  ? "Spots free up when guests cancel — we promote in order, automatically. Your Scotty Invite lands in your email the moment you're in."
                  : `The ${detail.committee.name} team reviews requests daily. Once you're approved, your Scotty Invite lands in your email and under My tickets.`}
              </p>
              <Link to="/tickets" className="pill pill-outline" style={{ marginTop: 6, fontSize: 13, padding: "9px 20px" }}>
                View my tickets
              </Link>
            </div>
          )}

          {state === "approved" && (
            <div className="fade-in" style={{ padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              <div style={{ width: 44, height: 44, borderRadius: 100, background: "var(--success-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CheckIcon size={20} style={{ color: "var(--success)" }} />
              </div>
              <div style={{ fontFamily: "var(--font-brand)", fontSize: 20, fontWeight: 700, color: "var(--text)" }}>You're in</div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--muted-1)", maxWidth: 380 }}>
                Scotty Invite Nº {detail.myRegistration?.ticketNumber ? pad3(detail.myRegistration.ticketNumber) : "—"} is yours. Show the QR at the door
                {detail.allowPlusOne ? " — and your +1 link is ready to send." : "."}
              </p>
              <Link to="/tickets" className="pill pill-blue" style={{ marginTop: 6, fontSize: 14, padding: "11px 26px" }}>
                View my Scotty Invite
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

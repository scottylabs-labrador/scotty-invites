import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Artwork, EventAudience, EventModel, QuestionType } from "@scottylabs-invites/contract";
import { EVENT_CATEGORIES } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AppFooter, AppHeader, Spinner } from "../components/AppShell";
import { CheckIcon, LockIcon, PlusIcon, XIcon } from "../components/icons";
import { GRADIENTS, nyWallClockToUtc } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

interface DraftQuestion {
  id: number;
  text: string;
  type: QuestionType;
}

const TYPE_LABELS: Record<QuestionType, string> = { short: "Short text", long: "Long text", select: "Select", file: "File" };

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px", boxShadow: "var(--shadow-sm)" }}>
      <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>{sub}</div>}
      {children}
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <div style={{ flex: "none", width: 34, height: 19, borderRadius: 100, background: on ? "var(--blue)" : "#aebdcc", position: "relative", transition: "background-color 180ms var(--ease)" }}>
      <div style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: 100, background: "#fff", transition: "left 180ms var(--ease)", boxShadow: "0 1px 2px rgba(30,30,30,0.2)" }} />
    </div>
  );
}

function seg(on: boolean): React.CSSProperties {
  return on
    ? { all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 100, background: "#1e1e1e", color: "#fff", border: "1px solid #1e1e1e", fontFamily: "var(--font-ui)" }
    : { all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 500, padding: "8px 18px", borderRadius: 100, background: "#fff", color: "var(--muted-1)", border: "1px solid var(--border)", fontFamily: "var(--font-ui)" };
}

export default function CreateEventPage() {
  const { me, loading } = useAuth();
  const isSuper = me.admin?.role === "super_admin";

  const committeesQuery = useQuery({
    queryKey: ["orgCommittees"],
    queryFn: async () => unwrap(await api.org.committees(), 200),
    enabled: !!me.admin,
  });

  const [committeeId, setCommitteeId] = useState<string>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>(EVENT_CATEGORIES[0]);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("19:00");
  const [endTime, setEndTime] = useState("22:00");
  const [location, setLocation] = useState("");
  const [audience, setAudience] = useState<EventAudience>("cmu");
  const [model, setModel] = useState<EventModel>("instant");
  const [capacity, setCapacity] = useState("40");
  const [captures, setCaptures] = useState<Record<string, boolean>>({
    major_year: true,
    dietary: false,
    resume: false,
    source: true,
    phone: false,
    tshirt: false,
  });
  const [questions, setQuestions] = useState<DraftQuestion[]>([{ id: 1, text: "", type: "short" }]);
  const [nextQid, setNextQid] = useState(2);
  const [updatesEmail, setUpdatesEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [digest, setDigest] = useState<"hourly" | "daily" | "weekly">("daily");
  const [artwork, setArtwork] = useState<Artwork>("cool");
  const [passStyle, setPassStyle] = useState<"dark" | "light">("dark");
  const [stamp, setStamp] = useState(true);
  const [flagship, setFlagship] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ url: string; shortCode: string; id: string; inviteCode: string | null } | null>(null);

  const committees = committeesQuery.data?.committees ?? [];
  const controls = committeesQuery.data?.questionControls;
  const myCommittee = me.admin?.committee;
  const effectiveCommitteeId = committeeId || myCommittee?.id || "";
  const selectedCommittee = committees.find((c) => c.id === effectiveCommitteeId) ?? myCommittee;

  const publish = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Give the event a name.");
      if (!date) throw new Error("Pick a date.");
      if (!location.trim()) throw new Error("Where is it happening?");
      if (!updatesEmail.trim() || !contactEmail.trim()) throw new Error("Add the updates and contact emails.");
      const startAt = nyWallClockToUtc(date, startTime);
      let endAt = nyWallClockToUtc(date, endTime);
      if (endAt <= startAt) endAt = new Date(endAt.getTime() + 24 * 3600 * 1000);
      const res = await api.org.createEvent({
        body: {
          title: name.trim(),
          description: description.trim(),
          committeeId: effectiveCommitteeId,
          category: category as (typeof EVENT_CATEGORIES)[number],
          audience,
          model,
          capacity: model === "capacity" ? Math.max(1, parseInt(capacity, 10) || 1) : null,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          location: location.trim(),
          captures: {
            major_year: captures.major_year,
            dietary: captures.dietary,
            resume: captures.resume,
            source: captures.source,
            phone: captures.phone,
            tshirt: captures.tshirt,
          },
          hostQuestions: questions.filter((q) => q.text.trim()).map((q) => ({ label: q.text.trim(), type: q.type })),
          artwork,
          passStyle,
          stampCommittee: stamp,
          allowPlusOne: audience !== "cmu",
          flagship,
          updatesEmail: updatesEmail.trim(),
          contactEmail: contactEmail.trim(),
          digest,
        },
      });
      return unwrap(res, 200);
    },
    onSuccess: (data) => setPublished(data),
    onError: (e: Error) => setError(e.message),
  });

  const audienceNotes: Record<EventAudience, string> = {
    cmu: "Guests must sign in with an andrew email. IDs verified automatically.",
    cmu_guests: "Andrew sign-in required, but approved guests can transfer a +1 to anyone.",
    public: "Anyone with the link can sign up with any email.",
  };

  const modelDefs: { key: EventModel; label: string; sub: string }[] = [
    { key: "instant", label: "Instant RSVP", sub: "One click and they're in. Best for worksessions and GBMs." },
    { key: "capacity", label: "Capacity + waitlist", sub: "Caps signups; the waitlist promotes in order." },
    { key: "approval", label: "Approval required", sub: "You review every request before an invite is issued." },
    { key: "invite", label: "Invite only", sub: "Private link or code. Nothing listed publicly." },
  ];

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
    return base.filter((c) => controls[c.key as keyof typeof controls]);
  }, [controls]);

  const previewDate = date
    ? new Date(`${date}T${startTime}:00`)
    : null;
  const previewStamp = previewDate
    ? `${previewDate.toLocaleString("en-US", { month: "short" }).toUpperCase()} ${String(previewDate.getDate()).padStart(2, "0")} · ${startTime}`
    : "OCT 03 · 16:00";
  const previewLoc = (location || "Location TBD").split(",")[0].toUpperCase().slice(0, 18);
  const dark = passStyle === "dark";
  const mutedFg = dark ? "rgba(255,255,255,0.65)" : "#5f6f7f";

  if (!loading && !me.admin) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <AppHeader />
        <main style={{ flexGrow: 1, background: "var(--canvas-muted)" }}>
          <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)", color: "var(--muted-2)" }}>
            Creating events is admin-only. Ask a super admin for an invite.
          </div>
        </main>
        <AppFooter />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppHeader />
      <main style={{ flexGrow: 1, background: "var(--canvas-muted)" }}>
        <section className="shell" style={{ paddingBottom: 72 }}>
          <h1 style={{ margin: "36px 0 0", fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>Create an event</h1>
          <div style={{ marginTop: 6, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-2)" }}>
            Admin-only — you are signed in as {isSuper ? "a super admin" : `a ${myCommittee?.name} committee admin`}
            {isSuper && (
              <>
                {" "}
                (
                <Link to="/admin" className="link-blue" style={{ fontWeight: 500 }}>
                  manage admins
                </Link>
                )
              </>
            )}
            . Every event gets a signup page, Scotty Invites, and a check-in scanner.
          </div>

          {committeesQuery.isLoading && <Spinner />}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 24, alignItems: "flex-start", fontFamily: "var(--font-ui)" }}>
            {/* Left column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: "1 1 480px", minWidth: 0 }}>
              <Card title="Basics">
                <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", maxWidth: 280 }}>
                      <span className="field-label">
                        Committee{" "}
                        {isSuper ? <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>— pick ScottyLabs for all-club events like GBMs</span> : <span style={{ fontWeight: 400, color: "var(--muted-3)" }}>— stamped from your admin role</span>}
                      </span>
                      <select className="input" value={effectiveCommitteeId} disabled={!isSuper} onChange={(e) => setCommitteeId(e.target.value)}>
                        {(isSuper ? committees : committees.length ? committees : myCommittee ? [myCommittee] : []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 180px", maxWidth: 220 }}>
                      <span className="field-label">Category</span>
                      <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                        {EVENT_CATEGORIES.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Event name</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Bootcamp: React fundamentals"
                      className="input"
                      style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, padding: "12px 14px" }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Description</span>
                    <textarea className="input" rows={3} placeholder="What happens, who it's for, what to bring." value={description} onChange={(e) => setDescription(e.target.value)} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.9fr 0.9fr", gap: 12 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Date</span>
                      <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Starts</span>
                      <input type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Ends</span>
                      <input type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                    </label>
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Location</span>
                    <input className="input" placeholder="Tepper 2612" value={location} onChange={(e) => setLocation(e.target.value)} />
                  </label>
                </div>
              </Card>

              <Card title="Who can sign up">
                <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  {(["cmu", "cmu_guests", "public"] as const).map((a) => (
                    <button key={a} style={seg(audience === a)} onClick={() => setAudience(a)}>
                      {a === "cmu" ? "CMU only" : a === "cmu_guests" ? "CMU + guests" : "Public"}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 10 }}>{audienceNotes[audience]}</div>
              </Card>

              <Card title="Registration">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 14 }}>
                  {modelDefs.map((m) => {
                    const on = model === m.key;
                    return (
                      <button
                        key={m.key}
                        onClick={() => setModel(m.key)}
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
                {model === "capacity" && (
                  <label className="fade-in" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
                    <span className="field-label">Capacity</span>
                    <input className="input" style={{ width: 70, padding: "8px 12px" }} value={capacity} inputMode="numeric" onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} />
                    <span style={{ fontSize: 12, color: "var(--muted-3)" }}>Waitlist opens automatically when full.</span>
                  </label>
                )}
                {model === "invite" && (
                  <div className="fade-in" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: "var(--muted-1)" }}>
                    <LockIcon size={14} />
                    Only people with the invite link or a +1 transfer can sign up. Link generated on publish.
                  </div>
                )}
              </Card>

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
                      onClick={() => setCaptures({ ...captures, [c.key]: !captures[c.key] })}
                      style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)" }}
                    >
                      <Switch on={!!captures[c.key]} />
                      <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{c.label}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>{c.note}</span>
                    </button>
                  ))}
                </div>
              </Card>

              <Card title="Your questions" sub="Edit inline — guests see them in this order on the signup form.">
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
                  {questions.map((q) => (
                    <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: "var(--panel)" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aebdcc" strokeWidth="2" strokeLinecap="round">
                        <line x1="4" y1="8" x2="20" y2="8" />
                        <line x1="4" y1="16" x2="20" y2="16" />
                      </svg>
                      <input
                        value={q.text}
                        onChange={(e) => setQuestions(questions.map((x) => (x.id === q.id ? { ...x, text: e.target.value } : x)))}
                        placeholder="Ask anything — e.g. GitHub handle, team size"
                        style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-ui)", fontSize: 13.5, color: "var(--text)" }}
                      />
                      <select
                        value={q.type}
                        onChange={(e) => setQuestions(questions.map((x) => (x.id === q.id ? { ...x, type: e.target.value as QuestionType } : x)))}
                        style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--muted-1)", background: "#fff", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 6px", outline: "none" }}
                      >
                        {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setQuestions(questions.filter((x) => x.id !== q.id))}
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
                      setQuestions([...questions, { id: nextQid, text: "", type: "short" }]);
                      setNextQid(nextQid + 1);
                    }}
                  >
                    <PlusIcon size={14} />
                    Add a question
                  </button>
                </div>
              </Card>

              <Card title="Updates & contact" sub="Status emails go out via Mailgun. Every invite shows a contact.">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Send status updates to</span>
                    <input className="input" placeholder="your-committee@scottylabs.org" type="email" value={updatesEmail} onChange={(e) => setUpdatesEmail(e.target.value)} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Contact email on the invite</span>
                    <input className="input" placeholder="hello@scottylabs.org" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
                  </label>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
                  <span className="field-label">Digest frequency</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["hourly", "daily", "weekly"] as const).map((dg) => (
                      <button key={dg} style={seg(digest === dg)} onClick={() => setDigest(dg)}>
                        {dg[0].toUpperCase() + dg.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted-3)", marginTop: 12, lineHeight: 1.5 }}>
                  Digests cover new signups and reviews waiting. Requests pending more than 24 hours email immediately.
                </div>
              </Card>
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
                  <div style={{ background: GRADIENTS[artwork], padding: "16px 14px" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.85)" }}>
                      {!stamp
                        ? "Scotty invite"
                        : selectedCommittee?.isAllClub
                          ? "ScottyLabs · all-club"
                          : `${selectedCommittee?.name ?? ""} committee`}
                    </div>
                    <div style={{ fontFamily: "var(--font-brand)", fontSize: 19, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginTop: 3, lineHeight: 1.2 }}>
                      {name || "Your event"}
                    </div>
                  </div>
                  <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", borderTop: `1.5px dashed ${dark ? "rgba(255,255,255,0.25)" : "#d9e1e7"}` }}>
                    <span className="mono" style={{ fontSize: 9, color: mutedFg }}>{previewStamp}</span>
                    <span className="mono" style={{ fontSize: 9, color: mutedFg }}>{previewLoc}</span>
                  </div>
                  <div className="mono" style={{ padding: "0 14px 12px", fontSize: 8.5, color: mutedFg, textAlign: "center" }}>
                    questions? {contactEmail || "hello@scottylabs.org"}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(Object.keys(GRADIENTS).filter((k) => k !== "deep") as Artwork[]).map((k) => (
                      <button
                        key={k}
                        title={k}
                        onClick={() => setArtwork(k)}
                        style={{ all: "unset", cursor: "pointer", flex: 1, height: 34, borderRadius: 8, background: GRADIENTS[k], boxSizing: "border-box", border: `2.5px solid ${k === artwork ? "#1e1e1e" : "transparent"}` }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["dark", "light"] as const).map((ps) => (
                      <button key={ps} style={{ ...seg(passStyle === ps), fontSize: 12, padding: "6px 16px" }} onClick={() => setPassStyle(ps)}>
                        {ps[0].toUpperCase() + ps.slice(1)}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setStamp(!stamp)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                    <Switch on={stamp} />
                    <span style={{ fontSize: 12.5, color: "var(--muted-1)" }}>Committee stamp on the pass</span>
                  </button>
                  <button onClick={() => setFlagship(!flagship)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                    <Switch on={flagship} />
                    <span style={{ fontSize: 12.5, color: "var(--muted-1)" }}>Feature on the browse hero (flagship)</span>
                  </button>
                </div>
              </div>

              {!published ? (
                <>
                  {error && (
                    <div className="fade-in" style={{ fontSize: 12.5, color: "var(--danger-text)", background: "#fbe9ed", border: "1px solid #f3c2cd", borderRadius: 8, padding: "10px 14px" }}>
                      {error}
                    </div>
                  )}
                  <button
                    className="pill pill-blue"
                    style={{ width: "100%", fontSize: 15, padding: "13px 0" }}
                    disabled={publish.isPending}
                    onClick={() => {
                      setError(null);
                      publish.mutate();
                    }}
                  >
                    {publish.isPending ? "Publishing…" : "Publish event"}
                  </button>
                </>
              ) : (
                <div className="fade-in" style={{ background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 12, padding: "18px 20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-brand)", fontSize: 15, fontWeight: 700, color: "var(--success-text)" }}>
                    <CheckIcon size={16} style={{ color: "var(--success)" }} />
                    Event is live
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: "#38424b", background: "#fff", border: "1px solid var(--success-border)", borderRadius: 6, padding: "8px 12px", marginTop: 10, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {`${published.url}${published.inviteCode ? `?code=${published.inviteCode}` : ""}`.replace(/^https?:\/\//, "")}
                  </div>
                  {published.inviteCode && (
                    <div style={{ fontSize: 12, color: "var(--muted-1)", marginTop: 8 }}>
                      The link includes the invite code <span className="mono">{published.inviteCode}</span> — guests with it skip the code prompt.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 14, marginTop: 12, fontSize: 12.5, fontWeight: 600 }}>
                    <Link to={`/e/${published.shortCode}`} className="link-blue">
                      View event page
                    </Link>
                    <Link to={`/organize/${published.id}`} className="link-blue">
                      Open dashboard
                    </Link>
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: "var(--muted-3)", lineHeight: 1.5, padding: "0 4px" }}>
                Publishing lists this event on the browse page and gives every guest a numbered Scotty Invite.
              </div>
            </div>
          </div>
        </section>
      </main>
      <AppFooter />
    </div>
  );
}

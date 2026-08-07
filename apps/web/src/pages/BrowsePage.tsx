import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { BrowseEvent } from "@scottylabs-invites/contract";
import { AUDIENCE_LABELS, EVENT_CATEGORIES } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { Page, Tag, Spinner } from "../components/AppShell";
import { CalendarIcon, MapPinIcon, UsersIcon } from "../components/icons";
import { GRADIENTS, fmtLongDate, fmtRailDate, fmtTimeRange, fmtWeekday, nyDayKey, pad3 } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

function eventStatus(ev: BrowseEvent): { label: string; tone: "success" | "warning" | "neutral" } {
  if (ev.model === "invite") return { label: "Invite only", tone: "neutral" };
  if (ev.model === "approval") return { label: "Approval required", tone: "warning" };
  if (ev.full) return { label: "Waitlist", tone: "warning" };
  return { label: "Open", tone: "success" };
}

function eventCta(ev: BrowseEvent): { label: string; outline: boolean } {
  if (ev.myStatus === "approved") return { label: "You're in", outline: true };
  if (ev.myStatus === "pending") return { label: "Request sent", outline: true };
  if (ev.myStatus === "waitlisted") return { label: "On waitlist", outline: true };
  if (ev.model === "invite") return { label: "Enter invite code", outline: true };
  if (ev.model === "approval") return { label: "Request an invite", outline: false };
  if (ev.full) return { label: "Join waitlist", outline: true };
  return { label: "Sign up", outline: false };
}

function goingLabel(ev: BrowseEvent): string {
  if (ev.model === "approval") return `${ev.approvedCount} approved`;
  if (ev.full && ev.capacity) return `${ev.approvedCount} / ${ev.capacity} full`;
  return `${ev.approvedCount} going`;
}

export default function BrowsePage() {
  const [filter, setFilter] = useState<string>("All");
  const query = useQuery({
    queryKey: ["events"],
    queryFn: async () => unwrap(await api.events.list(), 200),
  });

  const events = query.data?.events ?? [];
  const flagship = events.find((e) => e.flagship);
  const visible = useMemo(
    () => events.filter((e) => filter === "All" || e.category === filter),
    [events, filter],
  );

  const groups = useMemo(() => {
    const out: { key: string; date: string; weekday: string; events: BrowseEvent[] }[] = [];
    for (const ev of visible) {
      const key = nyDayKey(ev.startAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.events.push(ev);
      else out.push({ key, date: fmtRailDate(ev.startAt), weekday: fmtWeekday(ev.startAt), events: [ev] });
    }
    return out;
  }, [visible]);

  const chips = ["All", ...EVENT_CATEGORIES];

  return (
    <Page>
      <section className="shell">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 20, marginTop: 48 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "2.75rem", fontWeight: 700, color: "#000" }}>Events</h1>
            <p style={{ margin: "8px 0 0", fontSize: "1.125rem", color: "hsl(0,0%,35%)", fontWeight: 500 }}>
              Workshops, socials, and work sessions from the best place to build software @ CMU.
            </p>
          </div>
          <a
            href="/api/calendar.ics"
            style={{
              cursor: "pointer",
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid #000",
              color: "#000",
              fontWeight: 700,
              fontSize: 14,
              padding: "10px 22px",
              borderRadius: 40,
              transition: "transform 150ms",
              fontFamily: "var(--font-ui)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            <CalendarIcon size={15} />
            Subscribe to calendar
          </a>
        </div>

        {flagship && (
          <Link
            to={`/e/${flagship.shortCode}`}
            className="fade-in"
            style={{
              display: "flex",
              flexWrap: "wrap",
              marginTop: 32,
              background: "#000",
              borderRadius: 16,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(600px 300px at 85% 20%, rgba(135,102,212,0.35), transparent 70%),radial-gradient(500px 260px at 70% 100%, rgba(14,150,209,0.28), transparent 70%),radial-gradient(400px 240px at 100% 60%, rgba(215,36,68,0.3), transparent 70%)",
              }}
            />
            <div style={{ position: "relative", padding: "40px 44px", display: "flex", flexDirection: "column", alignItems: "flex-start", flex: "1 1 400px" }}>
              <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-ui)" }}>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#5eb9e0", border: "1px solid rgba(94,185,224,0.4)", borderRadius: 4, padding: "3px 8px" }}>
                  Flagship
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 4, padding: "3px 8px" }}>
                  {eventStatus(flagship).label}
                </span>
              </div>
              <div style={{ marginTop: 16, fontSize: "2.25rem", fontWeight: 700, color: "#fff", letterSpacing: "-0.025em", lineHeight: 1.15, maxWidth: 480 }}>
                {flagship.title}
              </div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-ui)", fontSize: 14, color: "rgba(255,255,255,0.75)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <CalendarIcon size={15} />
                  {fmtLongDate(flagship.startAt)} · {fmtTimeRange(flagship.startAt, flagship.endAt)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <MapPinIcon size={15} />
                  {flagship.location}
                </div>
              </div>
              <div style={{ marginTop: "auto", paddingTop: 28, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <span className="pill pill-blue" style={{ fontSize: 14, padding: "11px 26px" }}>
                  {eventCta(flagship).label}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex" }}>
                    <div style={{ width: 26, height: 26, borderRadius: 100, background: GRADIENTS.warm, border: "2px solid #000" }} />
                    <div style={{ width: 26, height: 26, borderRadius: 100, background: GRADIENTS.cool, border: "2px solid #000", marginLeft: -8 }} />
                    <div style={{ width: 26, height: 26, borderRadius: 100, background: "linear-gradient(135deg,#e8b13a,#df6f3c)", border: "2px solid #000", marginLeft: -8 }} />
                  </div>
                  <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
                    {flagship.approvedCount} {flagship.model === "approval" ? "approved" : "going"}
                    {flagship.capacity ? ` · ${flagship.capacity} spots` : ""}
                  </span>
                </div>
              </div>
            </div>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "36px 40px", flex: "1 1 300px" }}>
              <div
                style={{
                  width: 250,
                  background: GRADIENTS[flagship.artwork],
                  borderRadius: 14,
                  padding: 22,
                  transform: "rotate(3deg)",
                  boxShadow: "0 20px 48px rgba(0,0,0,0.55)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 44,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <img src={logo} style={{ height: 30, filter: "brightness(0) invert(1)" }} alt="" />
                  <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.9)" }}>
                    Nº {pad3(flagship.number)}
                  </span>
                </div>
                <div>
                  <div style={{ fontFamily: "var(--font-ui)", fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.8)" }}>
                    Scotty invite
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginTop: 4 }}>
                    {flagship.title.length > 24 ? flagship.title.split(" ").slice(-2).join(" ") : flagship.title}
                  </div>
                </div>
                <div style={{ borderTop: "2px dashed rgba(255,255,255,0.45)", paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.85)" }}>
                    {fmtRailDate(flagship.startAt).toUpperCase()} ·{" "}
                    {new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(flagship.startAt))}
                  </span>
                  <div style={{ width: 34, height: 34, background: "#fff", borderRadius: 4, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gridTemplateRows: "repeat(3,1fr)", padding: 4, gap: 2 }}>
                    {[1, 0, 1, 0, 1, 0, 1, 0, 1].map((on, i) => (
                      <div key={i} style={{ background: on ? "#000" : "transparent", borderRadius: 1 }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Link>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 44, fontFamily: "var(--font-ui)", flexWrap: "wrap" }}>
          {chips.map((c) => (
            <button key={c} className={`chip ${filter === c ? "chip-on" : "chip-off"}`} style={{ border: undefined }} onClick={() => setFilter(c)}>
              {c}
            </button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted-2)" }}>
            {visible.length} upcoming event{visible.length === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", paddingBottom: 72 }}>
          {query.isLoading && <Spinner />}
          {!query.isLoading && groups.length === 0 && (
            <div style={{ padding: "56px 0", textAlign: "center", fontFamily: "var(--font-ui)", color: "var(--muted-3)", fontSize: 14 }}>
              Nothing on the calendar {filter === "All" ? "yet" : `for ${filter.toLowerCase()}`} — check back soon.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ display: "flex", flexWrap: "wrap" }}>
              <div style={{ position: "relative", padding: "8px 0 36px 22px", flex: "0 0 170px" }}>
                <div style={{ position: "absolute", left: 4, top: 14, width: 9, height: 9, borderRadius: 100, background: "var(--border)" }} />
                <div style={{ position: "absolute", left: 8, top: 30, bottom: 0, borderLeft: "1.5px dashed #d9e1e7" }} />
                <div style={{ fontSize: 17, fontWeight: 700, color: "#000" }}>{g.date}</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-3)", marginTop: 2 }}>{g.weekday}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "0 0 36px", flex: "1 1 420px", minWidth: 0 }}>
                {g.events.map((ev) => {
                  const status = eventStatus(ev);
                  const cta = eventCta(ev);
                  return (
                    <Link
                      key={ev.shortCode}
                      to={`/e/${ev.shortCode}`}
                      className="hover-card"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 116px",
                        gap: 20,
                        background: "#fff",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        padding: 20,
                        boxShadow: "var(--shadow-sm)",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: "var(--font-ui)", minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--muted-2)" }}>{fmtTimeRange(ev.startAt, ev.endAt)}</div>
                        <div style={{ fontFamily: "var(--font-brand)", fontSize: 20, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
                          {ev.title}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, color: "var(--muted-1)", flexWrap: "wrap" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <MapPinIcon size={14} />
                            {ev.location.split(",")[0]}
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <UsersIcon size={14} />
                            {goingLabel(ev)}
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ flex: "none", width: 7, height: 7, borderRadius: 100, background: ev.committee.color }} />
                            {ev.committee.isAllClub ? ev.committee.name : `${ev.committee.name} committee`}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto", paddingTop: 10, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--muted-1)", background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 8px" }}>
                            {ev.category}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--muted-1)", background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 4, padding: "3px 8px" }}>
                            {AUDIENCE_LABELS[ev.audience]}
                          </span>
                          <Tag tone={status.tone} upper={false}>
                            {status.label}
                          </Tag>
                          <span
                            className={`pill ${cta.outline ? "pill-outline" : "pill-blue"}`}
                            style={{ marginLeft: "auto", fontSize: 13, padding: cta.outline ? "7px 17px" : "8px 18px" }}
                          >
                            {cta.label}
                          </span>
                        </div>
                      </div>
                      <div
                        style={{
                          background: GRADIENTS[ev.artwork],
                          borderRadius: 10,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          padding: 12,
                          minHeight: 96,
                        }}
                      >
                        <img src={logo} style={{ height: 22, filter: "brightness(0) invert(1)", opacity: 0.95 }} alt="" />
                        <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.85)" }}>
                          Nº {pad3(ev.number)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

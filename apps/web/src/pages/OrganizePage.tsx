import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dashboard } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner } from "../components/AppShell";
import { CheckIcon, DownloadIcon, FileTextIcon, SearchIcon } from "../components/icons";
import { fmtShortDate } from "../lib/format";

const AVATAR_PALETTES = ["#e7f5fa,#0a6b94", "#f3e8fd,#4b2d8f", "#fbe9ed,#991a30", "#e9f5ec,#0d4b17", "#fdf3e4,#654a00"];

const STATUS_CHIP: Record<string, { color: string; background: string }> = {
  approved: { color: "#0d4b17", background: "#e9f5ec" },
  pending: { color: "#654a00", background: "#fdf3e4" },
  waitlisted: { color: "#4a5662", background: "#f0f4f8" },
  declined: { color: "#5a0f1d", background: "#fbe9ed" },
  cancelled: { color: "#5a0f1d", background: "#fbe9ed" },
};

const STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  pending: "Pending",
  waitlisted: "Waitlist",
  declined: "Declined",
  cancelled: "Cancelled",
};

function timeAgo(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

export default function OrganizePage() {
  const { me, loading } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();

  const eventsQuery = useQuery({
    queryKey: ["orgEvents"],
    queryFn: async () => unwrap(await api.org.myEvents(), 200),
    enabled: !!me.admin,
  });

  const events = eventsQuery.data?.events ?? [];
  const activeId = id ?? events[0]?.id;

  if (!loading && !me.admin) {
    return (
      <Page bg="var(--canvas-muted)">
        <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)" }}>
          <h1 style={{ fontFamily: "var(--font-brand)", fontSize: "1.75rem", margin: 0 }}>Organizers only</h1>
          <p style={{ color: "var(--muted-2)", fontSize: 14 }}>
            The Organize tab unlocks for committee admins. Ask a super admin for an invite.
          </p>
          <Link to="/" className="pill pill-blue" style={{ fontSize: 13, padding: "9px 20px" }}>
            Browse events
          </Link>
        </div>
      </Page>
    );
  }

  return (
    <Page bg="var(--canvas-muted)">
      <section className="shell" style={{ paddingBottom: 72 }}>
        {(eventsQuery.isLoading || loading) && <Spinner />}
        {eventsQuery.isSuccess && events.length === 0 && (
          <div style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)" }}>
            <h1 style={{ fontFamily: "var(--font-brand)", fontSize: "1.75rem", margin: 0 }}>No events yet</h1>
            <p style={{ color: "var(--muted-2)", fontSize: 14 }}>Create your committee's first event — signups, invites, and check-in come free.</p>
            <Link to="/organize/new" className="pill pill-black" style={{ fontSize: 13, padding: "9px 20px" }}>
              Create event
            </Link>
          </div>
        )}
        {activeId && events.length > 0 && (
          <DashboardBody key={activeId} eventId={activeId} events={events} onSwitch={(next) => navigate(`/organize/${next}`)} />
        )}
      </section>
    </Page>
  );
}

function DashboardBody({
  eventId,
  events,
  onSwitch,
}: {
  eventId: string;
  events: { id: string; title: string }[];
  onSwitch: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(25);

  const query = useQuery({
    queryKey: ["dashboard", eventId],
    queryFn: async () => unwrap(await api.org.dashboard({ params: { id: eventId } }), 200),
    refetchInterval: 30_000,
  });

  const approve = useMutation({
    mutationFn: async (registrationId: string) =>
      unwrap(await api.org.approve({ params: { id: registrationId }, body: {} }), 200),
    onMutate: async (registrationId) => {
      await qc.cancelQueries({ queryKey: ["dashboard", eventId] });
      const prev = qc.getQueryData<Dashboard>(["dashboard", eventId]);
      if (prev) {
        qc.setQueryData<Dashboard>(["dashboard", eventId], {
          ...prev,
          kpis: { ...prev.kpis, approved: prev.kpis.approved + 1 },
          pending: prev.pending.filter((p) => p.registrationId !== registrationId),
          guests: prev.guests.map((g) => (g.registrationId === registrationId ? { ...g, status: "approved" } : g)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["dashboard", eventId], ctx.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["dashboard", eventId] }),
  });

  const decline = useMutation({
    mutationFn: async (registrationId: string) =>
      unwrap(await api.org.decline({ params: { id: registrationId }, body: {} }), 200),
    onMutate: async (registrationId) => {
      await qc.cancelQueries({ queryKey: ["dashboard", eventId] });
      const prev = qc.getQueryData<Dashboard>(["dashboard", eventId]);
      if (prev) {
        qc.setQueryData<Dashboard>(["dashboard", eventId], {
          ...prev,
          pending: prev.pending.filter((p) => p.registrationId !== registrationId),
          guests: prev.guests.map((g) => (g.registrationId === registrationId ? { ...g, status: "declined" } : g)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["dashboard", eventId], ctx.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["dashboard", eventId] }),
  });

  const d = query.data;

  const filteredGuests = useMemo(() => {
    if (!d) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return d.guests;
    return d.guests.filter(
      (g) => g.name.toLowerCase().includes(needle) || (g.andrewId ?? "").toLowerCase().includes(needle) || g.email.toLowerCase().includes(needle),
    );
  }, [d, search]);

  if (!d) return <Spinner />;

  const capacityPct = d.kpis.capacity ? Math.min(100, (d.kpis.approved / d.kpis.capacity) * 100) : 0;
  const maxSource = Math.max(1, ...d.sources.map((s) => s.count));
  const modelLabel = { instant: "Instant RSVP", capacity: "Capacity + waitlist", approval: "Approval required", invite: "Invite only" }[d.event.model];

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 36, flexWrap: "wrap" }}>
        <div>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>{d.event.title}</h1>
            {events.length > 1 && (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5f6f7f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <select
                  value={eventId}
                  onChange={(e) => onSwitch(e.target.value)}
                  aria-label="Switch event"
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }}
                >
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div style={{ marginTop: 6, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-2)" }}>
            {d.event.committeeName === "ScottyLabs" ? "All-club" : `${d.event.committeeName} committee`} · {fmtShortDate(d.event.startAt)} ·{" "}
            {d.event.location.split(",")[0]} · {modelLabel} ·{" "}
            <Link to={`/e/${d.event.shortCode}`} className="link-blue" style={{ fontWeight: 500 }}>
              View event page
            </Link>
            {d.event.inviteCode && (
              <>
                {" "}
                · invite code <span className="mono" style={{ fontSize: 12 }}>{d.event.inviteCode}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, fontFamily: "var(--font-ui)" }}>
          <a href={`/api/org/events/${d.event.id}/export.csv`} className="pill pill-outline" style={{ fontSize: 13, padding: "9px 20px" }}>
            <DownloadIcon size={14} />
            Export CSV
          </a>
          <Link to={`/organize/${d.event.id}/checkin`} className="pill pill-blue" style={{ fontSize: 13, padding: "9px 20px" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <line x1="7" y1="12" x2="17" y2="12" />
            </svg>
            Open check-in
          </Link>
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 24, fontFamily: "var(--font-ui)" }}>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>Requests</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", marginTop: 6, fontFamily: "var(--font-brand)" }}>{d.kpis.requests}</div>
          <div style={{ fontSize: 12, color: d.kpis.requestsToday > 0 ? "var(--success)" : "var(--muted-3)", marginTop: 4, fontWeight: 500 }}>
            +{d.kpis.requestsToday} today
          </div>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>Approved</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", marginTop: 6, fontFamily: "var(--font-brand)" }}>
            {d.kpis.approved}
            {d.kpis.capacity !== null && (
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted-3)", fontFamily: "var(--font-ui)" }}> / {d.kpis.capacity}</span>
            )}
          </div>
          {d.kpis.capacity !== null ? (
            <div style={{ height: 4, background: "var(--border-subtle)", borderRadius: 100, marginTop: 10, overflow: "hidden" }}>
              <div style={{ height: 4, width: `${capacityPct}%`, background: "var(--blue)", borderRadius: 100, transition: "width 280ms var(--ease)" }} />
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>No cap set</div>
          )}
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>Waitlist</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", marginTop: 6, fontFamily: "var(--font-brand)" }}>{d.kpis.waitlist}</div>
          <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>Auto-promotes on decline</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>+1 invites issued</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", marginTop: 6, fontFamily: "var(--font-brand)" }}>{d.kpis.plusOnesInvited}</div>
          <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>{d.kpis.plusOnesClaimed} claimed so far</div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 20, alignItems: "flex-start", fontFamily: "var(--font-ui)" }}>
        {/* Guests table */}
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", overflow: "hidden", flex: "1 1 520px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
            <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Guests</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 6, padding: "7px 12px", background: "var(--panel)", color: "var(--muted-3)", fontSize: 13, width: 220 }}>
              <SearchIcon size={13} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or andrew ID"
                style={{ border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--text)", width: "100%" }}
              />
            </div>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted-3)" }}>
              {d.guests.length} {d.guests.length === 1 ? "person" : "people"}
            </span>
          </div>
          <div className="table-scroll">
            <div style={{ minWidth: 780 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 0.9fr 1.1fr 0.55fr 1fr 0.7fr 1fr", gap: 10, padding: "10px 20px", borderBottom: "1px solid var(--border-subtle)", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted-3)" }}>
                <div>Name</div>
                <div>Andrew ID</div>
                <div>Major</div>
                <div>Year</div>
                <div>Dietary</div>
                <div>Resume</div>
                <div>Source · Status</div>
              </div>
              {filteredGuests.slice(0, shown).map((g, i) => {
                const [bg, fg] = AVATAR_PALETTES[i % 5].split(",");
                const chip = STATUS_CHIP[g.status];
                return (
                  <div
                    key={g.registrationId}
                    style={{ display: "grid", gridTemplateColumns: "1.5fr 0.9fr 1.1fr 0.55fr 1fr 0.7fr 1fr", gap: 10, padding: "12px 20px", borderBottom: "1px solid var(--border-subtle)", fontSize: 13, color: "#38424b", alignItems: "center" }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--panel)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <div style={{ fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <div style={{ flex: "none", width: 24, height: 24, borderRadius: 100, background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }}>
                        {g.initials}
                      </div>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                      {g.plusOne && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--blue-pressed)", background: "var(--blue-subtle)", borderRadius: 4, padding: "2px 6px", flex: "none" }}>
                          +1
                        </span>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: "var(--muted-1)" }}>{g.andrewId ?? "—"}</div>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.major ?? "—"}</div>
                    <div>{g.classYear ?? "—"}</div>
                    <div style={{ color: "var(--muted-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.dietary.length ? g.dietary.join(", ") : "—"}
                    </div>
                    <div>
                      {g.resumeUrl ? (
                        <a href={g.resumeUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--blue-hover)", fontSize: 12, fontWeight: 500 }}>
                          <FileTextIcon size={13} />
                          PDF
                        </a>
                      ) : (
                        "—"
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ color: "var(--muted-2)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.source ?? "—"}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: chip.color, background: chip.background, borderRadius: 100, padding: "3px 10px", marginLeft: "auto", flex: "none" }}>
                        {STATUS_LABEL[g.status]}
                      </span>
                    </div>
                  </div>
                );
              })}
              {filteredGuests.length === 0 && (
                <div style={{ padding: "28px 20px", fontSize: 13, color: "var(--muted-3)" }}>
                  {d.guests.length === 0 ? "No signups yet — share the event link." : "No guests match that search."}
                </div>
              )}
            </div>
          </div>
          {filteredGuests.length > shown && (
            <div style={{ padding: "12px 20px", fontSize: 12, color: "var(--muted-3)" }}>
              Showing {shown} of {filteredGuests.length} ·{" "}
              <span className="link-blue" style={{ fontWeight: 500, cursor: "pointer" }} onClick={() => setShown(shown + 50)}>
                Load more
              </span>
            </div>
          )}
        </div>

        {/* Right rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: "1 1 300px" }}>
          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Pending requests</div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#fff", background: d.pending.length ? "var(--danger)" : "#aebdcc", borderRadius: 100, padding: "2px 8px" }}>
                {d.pending.length}
              </span>
            </div>
            {d.pending.map((p) => (
              <div key={p.registrationId} className="fade-in" style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.name}</div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--muted-3)" }}>{p.andrewId ?? ""}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-3)" }}>{timeAgo(p.createdAt)}</span>
                </div>
                {p.answer && <div style={{ fontSize: 12, color: "var(--muted-2)", lineHeight: 1.45 }}>“{p.answer}”</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  <button className="pill pill-blue" style={{ fontSize: 12, padding: "6px 16px" }} onClick={() => approve.mutate(p.registrationId)}>
                    Approve
                  </button>
                  <button className="pill pill-outline pill-outline-danger" style={{ fontSize: 12, padding: "6px 14px", color: "var(--muted-2)", borderColor: "var(--border)" }} onClick={() => decline.mutate(p.registrationId)}>
                    Decline
                  </button>
                </div>
              </div>
            ))}
            {d.pending.length === 0 && (
              <div style={{ padding: "22px 20px", fontSize: 13, color: "var(--muted-2)", display: "flex", alignItems: "center", gap: 8 }}>
                <CheckIcon size={15} style={{ color: "var(--success)" }} />
                All caught up — no pending requests.
              </div>
            )}
          </div>

          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", padding: "16px 20px" }}>
            <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Where signups came from</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
              {d.sources.length === 0 && <div style={{ fontSize: 12, color: "var(--muted-3)" }}>Source data lands here with the first signup.</div>}
              {d.sources.map((s) => (
                <div key={s.label}>
                  <div style={{ display: "flex", fontSize: 12, color: "var(--muted-1)", marginBottom: 4 }}>
                    <span style={{ fontWeight: 500 }}>{s.label}</span>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-3)" }}>{s.count}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--canvas-muted)", borderRadius: 100, overflow: "hidden" }}>
                    <div style={{ height: 6, width: `${(s.count / maxSource) * 100}%`, background: "var(--blue)", borderRadius: 100, transition: "width 280ms var(--ease)" }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: "var(--muted-3)", lineHeight: 1.5 }}>
              Every signup answers “how did you hear about this?” — data lands here, not in a spreadsheet you chase down later.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminOverview, StandardQuestionKey } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner } from "../components/AppShell";
import { CheckIcon } from "../components/icons";

const AVATAR_PALETTES = ["#e7f5fa,#0a6b94", "#f3e8fd,#4b2d8f", "#fbe9ed,#991a30", "#e9f5ec,#0d4b17"];

const Q_META: { key: StandardQuestionKey; label: string; note: string }[] = [
  { key: "major_year", label: "Major + class year", note: "two dropdowns" },
  { key: "dietary", label: "Dietary restrictions", note: "for food orders" },
  { key: "resume", label: "Resume upload", note: "PDF, optional" },
  { key: "source", label: "How they heard about it", note: "source tracking" },
  { key: "phone", label: "Phone number", note: "off by default" },
  { key: "tshirt", label: "T-shirt size", note: "off by default" },
];

function Switch({ on }: { on: boolean }) {
  return (
    <div style={{ flex: "none", width: 34, height: 19, borderRadius: 100, background: on ? "var(--blue)" : "#aebdcc", position: "relative", transition: "background-color 180ms var(--ease)" }}>
      <div style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: 100, background: "#fff", transition: "left 180ms var(--ease)", boxShadow: "0 1px 2px rgba(30,30,30,0.2)" }} />
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export default function AdminPage() {
  const { me, loading } = useAuth();
  const qc = useQueryClient();
  const isSuper = me.admin?.role === "super_admin";

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCommittee, setInviteCommittee] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "super_admin">("admin");
  const [inviteSent, setInviteSent] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [resentId, setResentId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["adminOverview"],
    queryFn: async () => unwrap(await api.admin.overview(), 200),
    enabled: isSuper,
  });

  const invite = useMutation({
    mutationFn: async () => {
      const committeeId = inviteCommittee || d?.committees[0]?.id;
      if (!committeeId) throw new Error("Pick a committee");
      const res = await api.admin.inviteAdmin({ body: { email: inviteEmail.trim(), committeeId, role: inviteRole } });
      return unwrap(res, 200);
    },
    onSuccess: () => {
      setInviteSent(true);
      setInviteEmail("");
      setTimeout(() => setInviteSent(false), 3000);
      void qc.invalidateQueries({ queryKey: ["adminOverview"] });
    },
    onError: (e: Error) => setInviteError(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => unwrap(await api.admin.revokeAdmin({ params: { id } }), 200),
    onMutate: async (id) => {
      const prev = qc.getQueryData<AdminOverview>(["adminOverview"]);
      if (prev) qc.setQueryData<AdminOverview>(["adminOverview"], { ...prev, admins: prev.admins.filter((a) => a.id !== id) });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["adminOverview"], ctx.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["adminOverview"] }),
  });

  const resend = useMutation({
    mutationFn: async (id: string) => unwrap(await api.admin.resendInvite({ params: { id }, body: {} }), 200),
    onSuccess: (_d, id) => {
      setResentId(id);
      setTimeout(() => setResentId(null), 1800);
    },
  });

  const setControl = useMutation({
    mutationFn: async ({ key, enabled }: { key: StandardQuestionKey; enabled: boolean }) =>
      unwrap(await api.admin.setQuestionControl({ body: { key, enabled } }), 200),
    onMutate: async ({ key, enabled }) => {
      const prev = qc.getQueryData<AdminOverview>(["adminOverview"]);
      if (prev) qc.setQueryData<AdminOverview>(["adminOverview"], { ...prev, questionControls: { ...prev.questionControls, [key]: enabled } });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["adminOverview"], ctx.prev),
  });

  const revokeMcp = useMutation({
    mutationFn: async (id: string) => unwrap(await api.admin.revokeMcpToken({ params: { id } }), 200),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["adminOverview"] }),
  });

  const d = query.data;

  if (!loading && !isSuper) {
    return (
      <Page bg="var(--canvas-muted)">
        <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)", color: "var(--muted-2)" }}>
          The admin portal is for super admins only.
        </div>
      </Page>
    );
  }

  return (
    <Page bg="var(--canvas-muted)">
      <section className="shell" style={{ paddingBottom: 72 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 36, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>Admin</h1>
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#4b2d8f", background: "rgba(105,64,201,0.1)", border: "1px solid #baa7e6", borderRadius: 4, padding: "4px 10px" }}>
            Super admin
          </span>
        </div>
        <div style={{ marginTop: 6, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-2)" }}>
          Who can create events, and what signup forms may ask. Only you can add admins.
        </div>

        {query.isLoading && <Spinner />}

        {d && (
          <div className="fade-in" style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 24, alignItems: "flex-start", fontFamily: "var(--font-ui)" }}>
            {/* Left column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: "1 1 560px", minWidth: 0 }}>
              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
                  <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Admins</div>
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--muted-3)" }}>
                    {d.admins.length} {d.admins.length === 1 ? "person" : "people"}
                  </span>
                </div>
                {d.admins.map((a, i) => {
                  const [bg, fg] = AVATAR_PALETTES[i % 4].split(",");
                  return (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 20px", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
                      <div style={{ flex: "none", width: 30, height: 30, borderRadius: 100, background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>
                        {a.initials}
                      </div>
                      <div style={{ minWidth: 150 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                          {a.name ?? a.email.split("@")[0]}
                          {a.domainExempt && (
                            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--warning-text)", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", borderRadius: 4, padding: "2px 7px" }}>
                              Domain exempt
                            </span>
                          )}
                        </div>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--muted-3)", marginTop: 2 }}>{a.email}</div>
                      </div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted-1)", marginLeft: "auto" }}>
                        <span style={{ flex: "none", width: 7, height: 7, borderRadius: 100, background: a.committee.color }} />
                        {a.committee.name}
                      </span>
                      <span
                        style={
                          a.role === "super_admin"
                            ? { fontSize: 10.5, fontWeight: 600, color: "#4b2d8f", background: "rgba(105,64,201,0.1)", borderRadius: 100, padding: "3px 10px" }
                            : { fontSize: 10.5, fontWeight: 600, color: "var(--muted-1)", background: "var(--canvas-muted)", borderRadius: 100, padding: "3px 10px" }
                        }
                      >
                        {a.role === "super_admin" ? "Super admin" : "Admin"}
                      </span>
                      <span
                        style={
                          a.status === "active"
                            ? { fontSize: 10.5, fontWeight: 600, color: "var(--success-text)", background: "var(--success-bg)", borderRadius: 100, padding: "3px 10px" }
                            : { fontSize: 10.5, fontWeight: 600, color: "var(--warning-text)", background: "var(--warning-bg)", borderRadius: 100, padding: "3px 10px" }
                        }
                      >
                        {a.status === "active" ? "Active" : "Invited"}
                      </span>
                      <div style={{ display: "flex", gap: 10, fontSize: 12, fontWeight: 600 }}>
                        {a.status === "invited" && (
                          <button className="icon-link" style={{ fontSize: 12, fontWeight: 600 }} onClick={() => resend.mutate(a.id)}>
                            {resentId === a.id ? "Sent ✓" : "Resend"}
                          </button>
                        )}
                        <button className="quiet-link" style={{ fontSize: 12, fontWeight: 600 }} onClick={() => revoke.mutate(a.id)}>
                          Revoke
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div style={{ padding: "12px 20px", fontSize: 12, color: "var(--muted-3)" }}>
                  Revoking removes event tools immediately — their account and tickets stay.
                </div>
              </div>

              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", padding: "20px 24px" }}>
                <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Signup questions</div>
                <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4 }}>
                  The standard fields event admins can show on their forms. Turn one off and it disappears from every create flow.
                </div>
                <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
                  {Q_META.map((q) => {
                    const on = d.questionControls[q.key];
                    return (
                      <button
                        key={q.key}
                        onClick={() => setControl.mutate({ key: q.key, enabled: !on })}
                        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 2px", borderBottom: "1px solid var(--border-subtle)" }}
                      >
                        <Switch on={on} />
                        <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)" }}>{q.label}</span>
                        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)" }}>{q.note}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: "1 1 320px", maxWidth: 420 }}>
              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", padding: "20px 24px" }}>
                <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Invite an admin</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="field-label">Email</span>
                    <input className="input" placeholder="anyone@any-domain.com" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Committee</span>
                      <select className="input" value={inviteCommittee || d.committees[0]?.id} onChange={(e) => setInviteCommittee(e.target.value)}>
                        {d.committees.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span className="field-label">Role</span>
                      <select className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "super_admin")}>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super admin</option>
                      </select>
                    </label>
                  </div>
                  {inviteError && <div style={{ fontSize: 12.5, color: "var(--danger-text)" }}>{inviteError}</div>}
                  <button
                    className="pill pill-blue"
                    style={{ width: "100%", fontSize: 14, padding: "12px 0" }}
                    disabled={invite.isPending || !inviteEmail.trim()}
                    onClick={() => {
                      setInviteError(null);
                      invite.mutate();
                    }}
                  >
                    {invite.isPending ? "Sending…" : "Send invite via Mailgun"}
                  </button>
                  {inviteSent && (
                    <div className="fade-in" style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "var(--success-text)" }}>
                      <CheckIcon size={13} style={{ color: "var(--success)" }} />
                      Invite sent — they appear above as “Invited” until they sign in.
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--muted-3)", textWrap: "pretty" }}>
                    Any domain works here. The CMU-only rule applies to guests signing up — not to admins you invite.
                  </div>
                </div>
              </div>

              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", padding: "20px 24px" }}>
                <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Committees</div>
                <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
                  {d.committees.map((c) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 13 }}>
                      <span style={{ flex: "none", width: 8, height: 8, borderRadius: 100, background: c.color }} />
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{c.name}</span>
                      <span style={{ marginLeft: "auto", color: "var(--muted-3)", fontSize: 12 }}>
                        {c.isAllClub
                          ? "all-club · GBMs, kickoffs"
                          : `${c.adminCount} admin${c.adminCount === 1 ? "" : "s"} · ${c.upcomingCount} upcoming`}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted-3)", marginTop: 12, lineHeight: 1.5 }}>
                  Every event is stamped with its committee — dashboards, exports, and the Postgres rows all carry it.
                </div>
              </div>

              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", padding: "20px 24px" }}>
                <div style={{ fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>MCP data access</div>
                <div style={{ fontSize: 12, color: "var(--muted-3)", marginTop: 4, lineHeight: 1.5 }}>
                  Connect Claude — or any MCP client — to live guest data. Adding the URL opens your browser to sign in and approve once; the client stays signed in with a committee-scoped token.
                </div>
                <div className="mono" style={{ display: "flex", alignItems: "center", fontSize: 12, color: "#38424b", background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 6, padding: "9px 12px", marginTop: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.mcp.url.replace(/^https?:\/\//, "")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                  {d.mcp.tokens.length === 0 && (
                    <div style={{ padding: "10px 0", fontSize: 12.5, color: "var(--muted-3)" }}>No connected clients yet.</div>
                  )}
                  {d.mcp.tokens.map((t) => (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 12.5, color: "#38424b", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{t.email.split("@")[0]}</span>
                      · {t.label ?? "MCP client"} · {t.scope}
                      <span style={{ marginLeft: "auto", color: "var(--muted-3)", fontSize: 11.5 }}>{timeAgo(t.lastUsedAt ?? t.createdAt)}</span>
                      <button className="quiet-link" style={{ fontSize: 11.5, fontWeight: 600 }} onClick={() => revokeMcp.mutate(t.id)}>
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted-3)", marginTop: 12 }}>
                  list_events · guest_list · pending_reviews · export_csv
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </Page>
  );
}

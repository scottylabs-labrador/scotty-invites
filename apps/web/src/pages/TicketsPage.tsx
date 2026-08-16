import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TicketView } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner, Tag } from "../components/AppShell";
import { QrCode } from "../components/QrCode";
import { CheckIcon, ClockIcon, CopyIcon, WalletIcon } from "../components/icons";
import { GRADIENTS, fmtClock, fmtShortDate, fmtTimeWithZone } from "../lib/format";
import { pad3 } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

function PassCard({ ticket }: { ticket: TicketView }) {
  const { me } = useAuth();
  const dark = ticket.event.passStyle !== "light";
  const bg = dark ? "var(--black-surface)" : "#ffffff";
  const fg = dark ? "#fff" : "var(--text)";
  const dim = (a: number) => (dark ? `rgba(255,255,255,${a})` : `rgba(30,30,30,${a})`);
  const [walletNote, setWalletNote] = useState<string | null>(null);

  async function saveToGoogle() {
    if (!ticket.id) return;
    const res = await api.tickets.googleWallet({ params: { id: ticket.id } });
    if (res.status === 200) window.open(res.body.saveUrl, "_blank");
    else setWalletNote((res.body as { message?: string }).message ?? "Google Wallet isn't configured yet.");
  }

  async function addToApple() {
    if (!ticket.id) return;
    const res = await fetch(`/api/tickets/${ticket.id}/apple.pkpass`, { credentials: "include" });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ticket.serial}.pkpass`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const body = (await res.json()) as { message?: string };
      setWalletNote(body.message ?? "Apple Wallet isn't configured yet.");
    }
  }

  const statusChip =
    ticket.status === "checked_in" ? (
      <span style={{ position: "absolute", top: 18, right: 20, fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "#fff", background: "var(--success)", borderRadius: 100, padding: "4px 12px" }}>
        Checked in · {ticket.checkedInAt ? fmtClock(ticket.checkedInAt) : ""}
      </span>
    ) : ticket.status === "approved" ? (
      <span style={{ position: "absolute", top: 18, right: 20, fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--success-text)", background: "var(--success-bg)", borderRadius: 100, padding: "4px 12px" }}>
        Approved
      </span>
    ) : (
      <span style={{ position: "absolute", top: 18, right: 20, fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, color: "var(--warning-text)", background: "var(--warning-bg)", borderRadius: 100, padding: "4px 12px" }}>
        Pending approval
      </span>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: bg, border: dark ? undefined : "1px solid var(--border)", borderRadius: 20, overflow: "hidden", boxShadow: "var(--shadow-pass)", position: "relative" }}>
        <div style={{ padding: "18px 22px", display: "flex", alignItems: "center", gap: 10 }}>
          <img src={logo} style={{ height: 22, filter: dark ? "brightness(0) invert(1)" : undefined }} alt="" />
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: dim(0.75) }}>
            Scotty invite
          </span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: dim(0.9) }}>
            {ticket.number !== null ? `Nº ${pad3(ticket.number)}` : "Nº —"}
          </span>
        </div>

        <div style={{ position: "relative", background: GRADIENTS[ticket.event.artwork], padding: "24px 22px 20px" }}>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.85)" }}>
            {ticket.event.stampCommittee
              ? ticket.event.committeeName === "ScottyLabs"
                ? "ScottyLabs"
                : `ScottyLabs ${ticket.event.committeeName}`
              : "ScottyLabs"}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.15, marginTop: 4, paddingRight: 110 }}>
            {ticket.event.title}
          </div>
          {statusChip}
        </div>

        <div style={{ padding: "20px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontFamily: "var(--font-ui)" }}>
          {[
            ["Date", fmtShortDate(ticket.event.startAt)],
            ["Doors", fmtTimeWithZone(ticket.event.startAt)],
            ["Location", ticket.event.locationShort],
            ["Guest", ""],
          ].map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: dim(0.5) }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: fg, marginTop: 3 }}>
                {label === "Guest" ? (
                  <>
                    {ticket.guestName}
                    {ticket.plusOneOnPass && <span style={{ color: dim(0.55), fontWeight: 500 }}> +1</span>}
                    {ticket.kind === "plus_one" && <span style={{ color: dim(0.55), fontWeight: 500 }}> (guest)</span>}
                  </>
                ) : (
                  value
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ position: "relative", height: 24 }}>
          <div style={{ position: "absolute", left: 22, right: 22, top: "50%", borderTop: `2px dashed ${dim(0.25)}` }} />
          <div style={{ position: "absolute", left: -12, top: 0, width: 24, height: 24, borderRadius: 100, background: "var(--panel)" }} />
          <div style={{ position: "absolute", right: -12, top: 0, width: 24, height: 24, borderRadius: 100, background: "var(--panel)" }} />
        </div>

        <div style={{ padding: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          {ticket.serial ? (
            <>
              <div style={{ background: "#fff", borderRadius: 12, padding: 14, border: dark ? undefined : "1px solid var(--border-subtle)" }}>
                <QrCode value={ticket.serial} size={150} />
              </div>
              <div className="mono" style={{ fontSize: 11, color: dim(0.65) }}>{ticket.serial}</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: dim(0.5) }}>Scan at the door</div>
              <div className="mono" style={{ fontSize: 10, color: dim(0.45) }}>questions? {ticket.event.contactEmail}</div>
            </>
          ) : (
            <div style={{ width: 176, height: 176, border: `1.5px dashed ${dim(0.3)}`, borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: dim(0.6) }}>
              <ClockIcon size={22} />
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, textAlign: "center", maxWidth: 130 }}>Your QR unlocks once you're approved</span>
            </div>
          )}
        </div>
      </div>

      {ticket.serial && (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            {me.wallet.apple ? (
              <button className="pill" style={{ flex: 1, background: "#000", color: "#fff", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }} onClick={() => void addToApple()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#383838")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#000")}>
                <WalletIcon size={15} />
                Add to Apple Wallet
              </button>
            ) : (
              <button className="pill" disabled title="Apple Wallet passes need a paid Apple Developer account — not set up yet." style={{ flex: 1, background: "#000", color: "#fff", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }}>
                <WalletIcon size={15} />
                Apple Wallet — coming soon
              </button>
            )}
            {me.wallet.google ? (
              <button className="pill" style={{ flex: 1, background: "#1f1f1f", color: "#fff", border: "1px solid #1f1f1f", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }} onClick={() => void saveToGoogle()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#383838")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#1f1f1f")}>
                <WalletIcon size={15} />
                Save to Google Wallet
              </button>
            ) : (
              <button className="pill" disabled title="Google Wallet passes aren't configured on this deployment yet." style={{ flex: 1, background: "#1f1f1f", color: "#fff", border: "1px solid #1f1f1f", fontSize: 13, fontWeight: 600, padding: "12px 0", borderRadius: 10 }}>
                <WalletIcon size={15} />
                Google Wallet — coming soon
              </button>
            )}
          </div>
          {walletNote && (
            <div className="fade-in" style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--warning-text)", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
              {walletNote}
            </div>
          )}
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--muted-3)", textAlign: "center" }}>
            {me.wallet.apple && me.wallet.google
              ? "Add it to Apple Wallet or Google Wallet — or just show the QR."
              : me.wallet.google
                ? "Save it to Google Wallet — Apple Wallet is coming soon."
                : me.wallet.apple
                  ? "Save it to Apple Wallet — Google Wallet is coming soon."
                  : "Your QR is the ticket — wallet passes are coming soon."}
          </div>
        </>
      )}
    </div>
  );
}

function PlusOneCard({ ticket }: { ticket: TicketView }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const transfer = ticket.transfer;

  const create = useMutation({
    mutationFn: async () => unwrap(await api.tickets.createTransfer({ params: { id: ticket.id! }, body: {} }), 200),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets"] }),
  });
  const revoke = useMutation({
    mutationFn: async () => unwrap(await api.tickets.revokeTransfer({ params: { id: ticket.id! }, body: {} }), 200),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets"] }),
  });

  if (!transfer || !ticket.id) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px", boxShadow: "var(--shadow-sm)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--font-brand)", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>Your +1 invite</div>
        <Tag tone="blue" upper={false}>Transferable</Tag>
        <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--muted-3)", marginLeft: "auto" }}>{ticket.event.title}</span>
      </div>

      {transfer.status === "claimed" ? (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--success-text)", background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 8, padding: "12px 14px" }}>
          <CheckIcon size={15} style={{ color: "var(--success)" }} />
          Claimed by {transfer.claimedByName ?? "your guest"} — their pass is tied to yours.
        </div>
      ) : (
        <>
          <p style={{ margin: "8px 0 0", fontFamily: "var(--font-ui)", fontSize: 13, lineHeight: 1.5, color: "var(--muted-2)", maxWidth: 460 }}>
            Send this link to a friend — it becomes their own Scotty Invite, tied to yours. One transfer per invite.
          </p>
          {transfer.status === "active" && transfer.url ? (
            <>
              <div style={{ marginTop: 14, display: "flex", gap: 10, maxWidth: 520 }}>
                <div className="mono" style={{ flex: 1, display: "flex", alignItems: "center", fontSize: 12, color: "#38424b", padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--canvas-muted)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {transfer.url.replace(/^https?:\/\//, "")}
                </div>
                <button
                  className="pill pill-blue"
                  style={{ fontSize: 13, padding: "0 20px" }}
                  onClick={() => {
                    void navigator.clipboard.writeText(transfer.url!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  <CopyIcon size={13} />
                  {copied ? "Copied!" : "Copy link"}
                </button>
              </div>
              <button className="quiet-link" style={{ marginTop: 12, display: "block" }} onClick={() => revoke.mutate()}>
                Revoke +1 link
              </button>
            </>
          ) : (
            <button className="pill pill-blue" style={{ marginTop: 14, fontSize: 13, padding: "9px 20px" }} disabled={create.isPending} onClick={() => create.mutate()}>
              {transfer.status === "revoked" ? "Create a new +1 link" : "Get my +1 link"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function TicketsPage() {
  const { me, loading } = useAuth();
  const query = useQuery({
    queryKey: ["tickets"],
    queryFn: async () => unwrap(await api.tickets.mine(), 200),
    enabled: !!me.user,
  });

  const tickets = query.data?.tickets ?? [];
  const stubs = query.data?.stubs ?? [];
  const withPlusOne = tickets.filter((t) => t.transfer !== null && t.id);

  return (
    <Page bg="var(--panel)">
      <section className="shell">
          <h1 style={{ margin: "44px 0 0", fontSize: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>My tickets</h1>
          <p style={{ margin: "8px 0 0", fontSize: "1rem", color: "hsl(0,0%,35%)" }}>Your Scotty Invites — numbered, scannable, and yours to keep.</p>

          {!loading && !me.user && (
            <div style={{ margin: "48px 0 96px", textAlign: "center", fontFamily: "var(--font-ui)" }}>
              <p style={{ color: "var(--muted-2)", fontSize: 14 }}>Sign in to see your invites.</p>
              <Link to="/signin?to=/tickets" className="pill pill-blue" style={{ fontSize: 14, padding: "11px 26px" }}>
                Sign in
              </Link>
            </div>
          )}

          {me.user && query.isLoading && <Spinner />}

          {me.user && !query.isLoading && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 48, marginTop: 32, paddingBottom: 72, alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 28, flex: "0 1 420px", minWidth: 300 }}>
                {tickets.length === 0 && (
                  <div style={{ fontFamily: "var(--font-ui)", fontSize: 14, color: "var(--muted-2)", background: "#fff", border: "1px dashed var(--border)", borderRadius: 12, padding: "36px 24px", textAlign: "center" }}>
                    No invites yet — <Link to="/" className="link-blue">browse events</Link> and grab your first Scotty Invite.
                  </div>
                )}
                {tickets.map((t) => (
                  <PassCard key={t.registrationId + (t.id ?? "")} ticket={t} />
                ))}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 24, fontFamily: "var(--font-ui)", flex: "1 1 400px", minWidth: 0 }}>
                {withPlusOne.map((t) => (
                  <PlusOneCard key={t.id} ticket={t} />
                ))}

                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: "1px solid var(--border-subtle)", paddingBottom: 10 }}>
                    <div style={{ fontFamily: "var(--font-brand)", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>Stub wall</div>
                    <span style={{ fontSize: 12, color: "var(--muted-3)" }}>Every invite you've used stays yours.</span>
                  </div>
                  {stubs.length === 0 ? (
                    <div style={{ marginTop: 16, fontSize: 13, color: "var(--muted-3)" }}>Your first stub lands here after your first event.</div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 16 }}>
                      {stubs.map((s) => (
                        <div key={s.serial} style={{ background: GRADIENTS[s.artwork], borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-md)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <img src={logo} style={{ height: 18, filter: "brightness(0) invert(1)", opacity: 0.9 }} alt="" />
                            <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.85)" }}>Nº {pad3(s.number)}</span>
                          </div>
                          <div style={{ marginTop: 26 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em", lineHeight: 1.2 }}>{s.title}</div>
                            <div className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.8)", marginTop: 5 }}>{s.date}</div>
                          </div>
                          <div style={{ marginTop: 14, borderTop: "1.5px dashed rgba(255,255,255,0.4)", paddingTop: 9, display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>
                            {s.checkedIn ? (
                              <>
                                <CheckIcon size={11} strokeWidth={3} />
                                Checked in
                              </>
                            ) : (
                              "Kept"
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
      </section>
    </Page>
  );
}

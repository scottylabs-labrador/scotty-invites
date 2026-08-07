import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner, Tag } from "../components/AppShell";
import { CheckIcon } from "../components/icons";
import { GRADIENTS, fmtLongDate, fmtTimeRange } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

export default function ClaimPage() {
  const { token = "" } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [claimedSerial, setClaimedSerial] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["transfer", token],
    queryFn: async () => unwrap(await api.tickets.transferPreview({ params: { token } }), 200),
  });

  const claim = useMutation({
    mutationFn: async () => {
      const res = await api.tickets.claimTransfer({ params: { token }, body: {} });
      return unwrap(res, 200);
    },
    onSuccess: (data) => {
      setClaimedSerial(data.serial);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const p = preview.data;

  return (
    <Page bg="var(--canvas-muted)">
      <div style={{ display: "flex", justifyContent: "center", padding: "8vh var(--gutter) 64px" }}>
        <div style={{ width: "100%", maxWidth: 460, fontFamily: "var(--font-ui)" }}>
          {preview.isLoading && <Spinner />}

          {p && p.status !== "active" && !claimedSerial && (
            <div className="fade-in" style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-md)", padding: "32px 28px", textAlign: "center" }}>
              <img src={logo} style={{ height: 36 }} alt="" />
              <h1 style={{ margin: "16px 0 0", fontFamily: "var(--font-brand)", fontSize: 22, fontWeight: 700 }}>
                {p.status === "claimed" ? "This +1 was already claimed" : p.status === "revoked" ? "This +1 link was revoked" : "That link isn't valid"}
              </h1>
              <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--muted-2)", lineHeight: 1.55 }}>
                {p.status === "claimed"
                  ? "Each +1 invite works exactly once. Ask your host if they meant to send it to someone else."
                  : p.status === "revoked"
                    ? "The host pulled this link back. Ask them for a fresh one."
                    : "Double-check the link from your host — it may have been copied incompletely."}
              </p>
              <Link to="/" className="pill pill-outline" style={{ marginTop: 20, fontSize: 13, padding: "9px 20px" }}>
                Browse events
              </Link>
            </div>
          )}

          {p && p.event && (p.status === "active" || claimedSerial) && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ background: GRADIENTS[p.event.artwork], borderRadius: 16, padding: 26, boxShadow: "var(--shadow-pass)", display: "flex", flexDirection: "column", gap: 54 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <img src={logo} style={{ height: 30, filter: "brightness(0) invert(1)" }} alt="" />
                  <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.9)" }}>+1 INVITE</span>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.8)" }}>
                    {p.hostName} sent you a Scotty invite
                  </div>
                  <div style={{ fontFamily: "var(--font-brand)", fontSize: 24, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginTop: 4, lineHeight: 1.2 }}>
                    {p.event.title}
                  </div>
                </div>
                <div style={{ borderTop: "2px dashed rgba(255,255,255,0.45)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>
                    {fmtLongDate(p.event.startAt).toUpperCase()} · {fmtTimeRange(p.event.startAt, p.event.endAt)}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>{p.event.location.toUpperCase()}</span>
                </div>
              </div>

              <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-md)", padding: "26px 28px", textAlign: "center" }}>
                {claimedSerial ? (
                  <>
                    <div style={{ width: 44, height: 44, borderRadius: 100, background: "var(--success-bg)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
                      <CheckIcon size={20} style={{ color: "var(--success)" }} />
                    </div>
                    <div style={{ fontFamily: "var(--font-brand)", fontSize: 20, fontWeight: 700, marginTop: 10 }}>It's yours</div>
                    <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--muted-2)", lineHeight: 1.55 }}>
                      Your pass <span className="mono" style={{ fontSize: 12 }}>{claimedSerial}</span> is tied to {p.hostName}'s invite. Show the QR at the door.
                    </p>
                    <button className="pill pill-blue" style={{ width: "100%", marginTop: 18, fontSize: 14, padding: "12px 0" }} onClick={() => navigate("/tickets")}>
                      View my Scotty Invite
                    </button>
                  </>
                ) : me.user ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
                      <Tag tone="blue" upper={false}>Transferable +1</Tag>
                      <Tag tone="committee" upper={false}>{p.event.committeeName} committee</Tag>
                    </div>
                    <p style={{ margin: "14px 0 0", fontSize: 13.5, color: "var(--muted-1)", lineHeight: 1.55 }}>
                      Claim this invite as <span className="mono" style={{ fontSize: 12.5 }}>{me.user.email}</span> — it becomes your own numbered pass, tied to {p.hostName}'s at the door.
                    </p>
                    {error && <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--danger-text)" }}>{error}</div>}
                    <button className="pill pill-blue" style={{ width: "100%", marginTop: 16, fontSize: 14, padding: "12px 0" }} disabled={claim.isPending} onClick={() => claim.mutate()}>
                      {claim.isPending ? "Claiming…" : "Claim my Scotty Invite"}
                    </button>
                  </>
                ) : (
                  <>
                    <p style={{ margin: 0, fontSize: 13.5, color: "var(--muted-1)", lineHeight: 1.55 }}>
                      Sign in with any email to claim it — this link is your way in, CMU address or not.
                    </p>
                    <button
                      className="pill pill-blue"
                      style={{ width: "100%", marginTop: 16, fontSize: 14, padding: "12px 0" }}
                      onClick={() => navigate(`/signin?to=/inv/${token}&transfer=${encodeURIComponent(token)}`)}
                    >
                      Sign in to claim
                    </button>
                  </>
                )}
                <div className="mono" style={{ marginTop: 16, fontSize: 10, color: "var(--muted-3)" }}>questions? {p.event.contactEmail}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

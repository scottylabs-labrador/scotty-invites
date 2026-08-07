import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, unwrap } from "../lib/api";
import { AppFooter } from "../components/AppShell";
import { AlertCircleIcon, ArrowUpRightIcon, CheckIcon, MailIcon } from "../components/icons";
import logo from "../assets/scottylabs-logo.svg";

type Phase = "email" | "code" | "signed-in";

const REDIRECT_KEY = "sl_invites_pending_redirect";

/** Where to land after sign-in. Survives the email-link-opens-a-new-tab path
 *  (e.g. the MCP OAuth consent flow) via a short-lived localStorage stash. */
function usePendingRedirect(toParam: string | null): string {
  if (toParam) {
    try {
      localStorage.setItem(REDIRECT_KEY, JSON.stringify({ to: toParam, at: Date.now() }));
    } catch {
      /* private mode */
    }
    return toParam;
  }
  try {
    const raw = localStorage.getItem(REDIRECT_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as { to?: string; at?: number };
      if (stored.to?.startsWith("/") && Date.now() - (stored.at ?? 0) < 10 * 60 * 1000) return stored.to;
    }
  } catch {
    /* ignore */
  }
  return "/";
}

export default function SignInPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirectTo = usePendingRedirect(params.get("to"));
  const transferToken = params.get("transfer") ?? undefined;

  const continueLabel = redirectTo.startsWith("/api/oauth") ? "Continue to authorization" : "Continue to events";
  function continueOn() {
    try {
      localStorage.removeItem(REDIRECT_KEY);
    } catch {
      /* ignore */
    }
    if (redirectTo.startsWith("/api/")) window.location.assign(redirectTo);
    else navigate(redirectTo);
  }

  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [keep, setKeep] = useState(true);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [signedOutNote, setSignedOutNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (params.get("verified") === "1") {
      void refresh().then(() => setPhase("signed-in"));
    }
    if (params.get("error") === "expired") {
      setGeneralError("That link expired or was already used — request a new one.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (me.user && phase === "email" && !signedOutNote && !params.get("error")) setPhase("signed-in");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.user]);

  async function sendLink() {
    if (!email.trim()) return;
    setBusy(true);
    setDomainError(null);
    setGeneralError(null);
    try {
      const res = await api.auth.start({ body: { email: email.trim(), keepSignedIn: keep, transferToken } });
      if (res.status === 200) {
        setPhase("code");
        setDigits(["", "", "", "", "", ""]);
        setTimeout(() => inputRefs.current[0]?.focus(), 50);
      } else {
        const body = res.body as { error?: string; message?: string };
        if (body.error === "domain") setDomainError(body.message ?? "That email domain isn't allowed.");
        else setGeneralError(body.message ?? "Something went wrong — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(code?: string) {
    const joined = code ?? digits.join("");
    if (joined.length !== 6) return;
    setBusy(true);
    setGeneralError(null);
    try {
      const res = await api.auth.verify({ body: { email: email.trim(), code: joined } });
      if (res.status === 200) {
        await refresh();
        setPhase("signed-in");
      } else {
        const body = res.body as { message?: string };
        setGeneralError(body.message ?? "That code didn't work.");
        setDigits(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api.auth.signOut({ body: {} });
    await refresh();
    setPhase("email");
    setSignedOutNote(true);
    setEmail("");
  }

  function setDigit(i: number, value: string) {
    const clean = value.replace(/\D/g, "");
    if (clean.length > 1) {
      // paste path
      const next = ["", "", "", "", "", ""];
      for (let k = 0; k < 6; k++) next[k] = clean[k] ?? "";
      setDigits(next);
      const last = Math.min(clean.length, 6) - 1;
      inputRefs.current[Math.max(last, 0)]?.focus();
      if (clean.length >= 6) void verify(clean.slice(0, 6));
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) inputRefs.current[i + 1]?.focus();
    if (clean && i === 5) {
      const joined = next.join("");
      if (joined.length === 6) void verify(joined);
    }
  }

  const activeIndex = digits.findIndex((d) => d === "");

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: "var(--canvas-muted)" }}>
      <header style={{ position: "sticky", top: 0, background: "#fff", borderBottom: "1px solid var(--border)", zIndex: 999 }}>
        <div className="shell" style={{ minHeight: 64, display: "flex", alignItems: "center", gap: 24 }}>
          <Link to="/" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <img src={logo} style={{ height: 26 }} alt="ScottyLabs" />
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--text)", whiteSpace: "nowrap" }}>
              ScottyLabs Invites
            </div>
          </Link>
          <a href="https://scottylabs.org" target="_blank" rel="noreferrer" className="header-ext" style={{ marginLeft: "auto" }}>
            scottylabs.org
            <ArrowUpRightIcon size={11} />
          </a>
        </div>
      </header>

      <main style={{ flexGrow: 1, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "9vh var(--gutter) 64px" }}>
        <div
          style={{
            width: "100%",
            maxWidth: 430,
            background: "#fff",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow-md)",
            padding: "32px 28px",
            fontFamily: "var(--font-ui)",
          }}
        >
          {phase === "email" && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column" }}>
              <img src={logo} style={{ height: 40, alignSelf: "flex-start" }} alt="" />
              <h1 style={{ margin: "18px 0 0", fontFamily: "var(--font-brand)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)" }}>
                Sign in
              </h1>
              <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: "var(--muted-2)", textWrap: "pretty" }}>
                No passwords — we email you a link. Same email, same account, every time.
              </p>
              {signedOutNote && (
                <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8, background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "var(--muted-1)" }}>
                  <CheckIcon size={13} style={{ color: "var(--success)" }} strokeWidth={2.5} />
                  Signed out — the cookie on this device was cleared.
                </div>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 22 }}>
                <span className="field-label">Email</span>
                <input
                  className={`input${domainError ? " input-error" : ""}`}
                  style={{ fontSize: 15, padding: "12px 14px", borderRadius: 8 }}
                  placeholder="andrewid@andrew.cmu.edu"
                  value={email}
                  autoFocus
                  type="email"
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void sendLink()}
                />
              </label>
              {domainError && (
                <div style={{ display: "flex", gap: 8, marginTop: 10, fontSize: 12.5, lineHeight: 1.5, color: "var(--danger-text)" }}>
                  <AlertCircleIcon size={14} style={{ flex: "none", marginTop: 2, color: "var(--danger)" }} />
                  <span>{domainError}</span>
                </div>
              )}
              {generalError && (
                <div style={{ display: "flex", gap: 8, marginTop: 10, fontSize: 12.5, lineHeight: 1.5, color: "var(--danger-text)" }}>
                  <AlertCircleIcon size={14} style={{ flex: "none", marginTop: 2, color: "var(--danger)" }} />
                  <span>{generalError}</span>
                </div>
              )}
              <button onClick={() => setKeep(!keep)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
                <div
                  style={{
                    flex: "none",
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxSizing: "border-box",
                    transition: "background-color 120ms",
                    background: keep ? "#1e1e1e" : "#fff",
                    border: keep ? "1px solid #1e1e1e" : "1.5px solid #aebdcc",
                  }}
                >
                  {keep && <CheckIcon size={11} style={{ color: "#fff" }} strokeWidth={3.5} />}
                </div>
                <span style={{ fontSize: 13, color: "#38424b" }}>Keep me signed in on this device</span>
              </button>
              <button className="pill pill-blue" style={{ width: "100%", marginTop: 18, fontSize: 15, padding: "13px 0" }} disabled={busy} onClick={() => void sendLink()}>
                {busy ? "Sending…" : "Email me a sign-in link"}
              </button>
              <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 22, paddingTop: 14, fontSize: 12, lineHeight: 1.55, color: "var(--muted-3)", textWrap: "pretty" }}>
                Works with <span className="mono" style={{ fontSize: 11, color: "var(--muted-1)" }}>andrew.cmu.edu</span>,{" "}
                <span className="mono" style={{ fontSize: 11, color: "var(--muted-1)" }}>cs.cmu.edu</span>, and{" "}
                <span className="mono" style={{ fontSize: 11, color: "var(--muted-1)" }}>cmu.edu</span> addresses. Invited admins can use any email.
              </div>
            </div>
          )}

          {phase === "code" && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
              <div style={{ width: 48, height: 48, borderRadius: 100, background: "var(--blue-subtle)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MailIcon size={21} style={{ color: "var(--blue)" }} />
              </div>
              <h1 style={{ margin: "16px 0 0", fontFamily: "var(--font-brand)", fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)" }}>
                Check your inbox
              </h1>
              <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.55, color: "var(--muted-2)", textWrap: "pretty" }}>
                We sent a link and a 6-digit code to
                <br />
                <span className="mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{email.trim()}</span>
                <br />
                It expires in 10 minutes.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 22 }}>
                {digits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    value={digit}
                    inputMode="numeric"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    onChange={(e) => setDigit(i, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace" && !digits[i] && i > 0) inputRefs.current[i - 1]?.focus();
                      if (e.key === "Enter") void verify();
                    }}
                    style={{
                      width: 42,
                      height: 50,
                      border: i === activeIndex ? "1.5px solid var(--blue)" : "1px solid var(--border)",
                      boxShadow: i === activeIndex ? "var(--focus-ring)" : undefined,
                      borderRadius: 8,
                      textAlign: "center",
                      fontFamily: "var(--font-mono)",
                      fontSize: 20,
                      color: "var(--text)",
                      outline: "none",
                      padding: 0,
                    }}
                  />
                ))}
              </div>
              {generalError && (
                <div style={{ display: "flex", gap: 8, marginTop: 12, fontSize: 12.5, color: "var(--danger-text)" }}>
                  <AlertCircleIcon size={14} style={{ flex: "none", marginTop: 2, color: "var(--danger)" }} />
                  <span>{generalError}</span>
                </div>
              )}
              <button className="pill pill-blue" style={{ width: "100%", marginTop: 22, fontSize: 15, padding: "13px 0" }} disabled={busy} onClick={() => void verify()}>
                {busy ? "Verifying…" : "Verify code"}
              </button>
              <div style={{ display: "flex", gap: 16, marginTop: 16, fontSize: 13, fontWeight: 500 }}>
                <button className="icon-link" onClick={() => void sendLink()}>Resend email</button>
                <button
                  style={{ all: "unset", cursor: "pointer", color: "var(--muted-2)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-2)")}
                  onClick={() => {
                    setPhase("email");
                    setGeneralError(null);
                  }}
                >
                  Use a different address
                </button>
              </div>
              <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 20, paddingTop: 12, fontSize: 11.5, color: "var(--muted-3)", width: "100%" }}>
                Sent via Mailgun from noreply@mail.scottylabs.org
              </div>
            </div>
          )}

          {phase === "signed-in" && me.user && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
              <div style={{ position: "relative" }}>
                <div style={{ width: 56, height: 56, borderRadius: 100, background: "var(--blue-subtle)", color: "var(--blue-pressed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>
                  {me.user.initials}
                </div>
                <div style={{ position: "absolute", right: -2, bottom: -2, width: 20, height: 20, borderRadius: 100, background: "var(--success)", border: "2.5px solid #fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <CheckIcon size={10} style={{ color: "#fff" }} strokeWidth={3.5} />
                </div>
              </div>
              <h1 style={{ margin: "16px 0 0", fontFamily: "var(--font-brand)", fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)" }}>
                You're signed in
              </h1>
              <div className="mono" style={{ marginTop: 8, fontSize: 12.5, color: "#38424b", background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 6, padding: "7px 14px" }}>
                {me.user.email}
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--muted-2)", textWrap: "pretty" }}>
                A secure cookie keeps this device signed in for 30 days. Sign in with the same email anywhere — it's always the same account, tickets included.
              </p>
              <button className="pill pill-blue" style={{ width: "100%", marginTop: 20, fontSize: 15, padding: "13px 0" }} onClick={continueOn}>
                {continueLabel}
              </button>
              <button className="pill pill-outline pill-outline-danger" style={{ width: "100%", marginTop: 10, fontSize: 14, padding: "11px 0" }} onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </main>
      <AppFooter />
    </div>
  );
}

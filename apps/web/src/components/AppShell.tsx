import { Link, NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { ArrowUpRightIcon, PlusIcon } from "./icons";
import logo from "../assets/scottylabs-logo.svg";

export function AppHeader() {
  const { me } = useAuth();
  const isAdmin = !!me.admin;
  const isSuper = me.admin?.role === "super_admin";

  return (
    <header style={{ position: "sticky", top: 0, background: "#fff", borderBottom: "1px solid var(--border)", zIndex: 999 }}>
      <div
        className="shell"
        style={{
          minHeight: 64,
          display: "flex",
          alignItems: "stretch",
          flexWrap: "wrap",
          columnGap: 24,
        }}
      >
        <Link to="/" style={{ display: "flex", gap: 10, alignItems: "center", padding: "14px 0" }}>
          <img src={logo} style={{ height: 26 }} alt="ScottyLabs" />
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--text)", whiteSpace: "nowrap" }}>
            ScottyLabs Invites
          </div>
        </Link>
        <nav style={{ display: "flex", gap: 18, alignItems: "stretch", fontFamily: "var(--font-ui)" }}>
          <NavLink to="/" end className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}>
            Browse
          </NavLink>
          <NavLink to="/tickets" className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}>
            My tickets
          </NavLink>
          {isAdmin && (
            <NavLink to="/organize" className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}>
              Organize
            </NavLink>
          )}
          {isSuper && (
            <NavLink to="/admin" className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}>
              Admin
            </NavLink>
          )}
        </nav>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontFamily: "var(--font-ui)",
            padding: "11px 0",
          }}
        >
          <a href="https://scottylabs.org" target="_blank" rel="noreferrer" className="header-ext hide-mobile">
            scottylabs.org
            <ArrowUpRightIcon size={11} />
          </a>
          {isAdmin && (
            <Link to="/organize/new" className="pill pill-black" style={{ fontSize: 13, padding: "8px 18px" }}>
              <PlusIcon size={14} />
              Create event
            </Link>
          )}
          <Link
            to="/signin"
            title={me.user ? `${me.user.email} — signed in via email link` : "Sign in"}
            style={{
              width: 32,
              height: 32,
              borderRadius: 100,
              background: me.user ? "var(--blue-subtle)" : "var(--canvas-muted)",
              color: me.user ? "var(--blue-pressed)" : "var(--muted-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              flex: "none",
            }}
          >
            {me.user ? (
              me.user.initials
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppFooter() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", background: "#fff", marginTop: "auto" }}>
      <div
        className="shell"
        style={{
          padding: `14px var(--gutter)`,
          display: "flex",
          alignItems: "center",
          gap: "10px 24px",
          flexWrap: "wrap",
          fontFamily: "var(--font-ui)",
          fontSize: 13,
          color: "var(--muted-2)",
        }}
      >
        <div>Designed, developed and maintained with ❤️ by ScottyLabs.</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 18, fontWeight: 500 }}>
          <a href="https://scottylabs.org" target="_blank" rel="noreferrer" className="link-blue">
            scottylabs.org
          </a>
          <a href="https://github.com/ScottyLabs" target="_blank" rel="noreferrer" className="link-blue">
            GitHub
          </a>
          <Link to="/signin" className="link-blue">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}

export function Page({ children, bg = "#fff" }: { children: ReactNode; bg?: string }) {
  return (
    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <AppHeader />
      <main style={{ flexGrow: 1, background: bg }}>{children}</main>
      <AppFooter />
    </div>
  );
}

export function Tag({
  children,
  tone = "neutral",
  upper = true,
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "warning" | "success" | "committee" | "purple";
  upper?: boolean;
  color?: string;
}) {
  const tones: Record<string, { color: string; background: string; border: string }> = {
    neutral: { color: "#4a5662", background: "#f0f4f8", border: "1px solid #d9e1e7" },
    blue: { color: "#0a6b94", background: "#e7f5fa", border: "1px solid #b4def1" },
    warning: { color: "#654a00", background: "#fdf3e4", border: "1px solid #f3e0b8" },
    success: { color: "#0d4b17", background: "#e9f5ec", border: "1px solid #cde8d4" },
    committee: { color: "#063f58", background: "rgba(6,63,88,0.07)", border: "1px solid #aebdcc" },
    purple: { color: "#6940c9", background: "rgba(105,64,201,0.08)", border: "1px solid #c9b8ee" },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        fontFamily: "var(--font-ui)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: upper ? "0.06em" : undefined,
        textTransform: upper ? "uppercase" : undefined,
        color: t.color,
        background: t.background,
        border: t.border,
        borderRadius: 4,
        padding: "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="fade-in"
      style={{
        padding: "80px 0",
        textAlign: "center",
        fontFamily: "var(--font-ui)",
        fontSize: 14,
        color: "var(--muted-3)",
      }}
    >
      {label}
    </div>
  );
}

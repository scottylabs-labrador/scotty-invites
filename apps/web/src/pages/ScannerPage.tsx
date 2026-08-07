import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CheckinResult } from "@scottylabs-invites/contract";
import jsQR from "jsqr";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Page, Spinner } from "../components/AppShell";
import { CheckIcon, ClockIcon, FlashlightIcon, PlusIcon, SearchIcon, XIcon } from "../components/icons";
import { fmtClock } from "../lib/format";
import logo from "../assets/scottylabs-logo.svg";

const PALETTES = {
  ok: { bg: "rgba(58,154,76,0.16)", border: "rgba(58,154,76,0.5)", icon: "#3a9a4c", chipBg: "#3a9a4c", chipFg: "#fff", label: "Approved" },
  plus_one: { bg: "rgba(14,150,209,0.14)", border: "rgba(14,150,209,0.5)", icon: "#0e96d1", chipBg: "#0e96d1", chipFg: "#fff", label: "+1 guest" },
  duplicate: { bg: "rgba(232,177,58,0.14)", border: "rgba(232,177,58,0.5)", icon: "#e8b13a", chipBg: "#e8b13a", chipFg: "#1e1e1e", label: "Already in" },
  denied: { bg: "rgba(215,36,68,0.16)", border: "rgba(215,36,68,0.55)", icon: "#d72444", chipBg: "#d72444", chipFg: "#fff", label: "Not on list" },
} as const;

const DOT: Record<string, string> = { ok: "#3a9a4c", plus_one: "#0e96d1", denied: "#d72444", duplicate: "#e8b13a" };

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export default function ScannerPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();

  const [result, setResult] = useState<CheckinResult | null>(null);
  const [cameraState, setCameraState] = useState<"starting" | "on" | "off" | "denied">("starting");
  const [torchOn, setTorchOn] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupValue, setLookupValue] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScanRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  const busyRef = useRef(false);

  const stateQuery = useQuery({
    queryKey: ["checkins", id],
    queryFn: async () => unwrap(await api.org.checkinState({ params: { id } }), 200),
    refetchInterval: 10_000,
    enabled: !!me.admin,
  });

  const submitCheckin = useCallback(
    async (payload: { serial?: string; andrewId?: string; method: "qr" | "manual" }) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const res = await api.org.checkin({ params: { id }, body: payload });
        if (res.status === 200) {
          setResult(res.body);
          void qc.invalidateQueries({ queryKey: ["checkins", id] });
        }
      } finally {
        setTimeout(() => {
          busyRef.current = false;
        }, 600);
      }
    },
    [id, qc],
  );

  // Camera + scan loop
  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let detector: BarcodeDetectorLike | null = null;
    const canvas = document.createElement("canvas");
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    let lastAttempt = 0;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setCameraState("on");

        const BD = (window as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
        if (BD) {
          try {
            detector = new BD({ formats: ["qr_code"] });
          } catch {
            detector = null;
          }
        }
        loop();
      } catch {
        if (!stopped) setCameraState("denied");
      }
    }

    function onDecoded(raw: string) {
      const now = Date.now();
      const serial = raw.trim();
      if (!serial) return;
      if (lastScanRef.current.value === serial && now - lastScanRef.current.at < 4000) return;
      lastScanRef.current = { value: serial, at: now };
      void submitCheckin({ serial, method: "qr" });
    }

    function loop() {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const now = Date.now();
      if (now - lastAttempt < 220) return;
      lastAttempt = now;

      if (detector) {
        void detector
          .detect(video)
          .then((codes) => {
            if (codes[0]?.rawValue) onDecoded(codes[0].rawValue);
          })
          .catch(() => {});
      } else if (ctx2d) {
        const w = 360;
        const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
        canvas.width = w;
        canvas.height = h;
        ctx2d.drawImage(video, 0, 0, w, h);
        const imgData = ctx2d.getImageData(0, 0, w, h);
        const code = jsQR(imgData.data, w, h, { inversionAttempts: "dontInvert" });
        if (code?.data) onDecoded(code.data);
      }
    }

    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [submitCheckin]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const capabilities = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    if (!capabilities?.torch) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      /* unsupported */
    }
  }

  const s = stateQuery.data;
  const capacity = s?.event.capacity ?? null;
  const denom = capacity ?? s?.event.approvedCount ?? 0;
  const pct = denom > 0 && s ? Math.min(100, (s.stats.checkedIn / denom) * 100) : 0;
  const palette = result ? PALETTES[result.result] : null;

  if (!me.admin) {
    return (
      <Page bg="var(--canvas-muted)">
        <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)", color: "var(--muted-2)" }}>
          Organizers only.
        </div>
      </Page>
    );
  }

  return (
    <Page bg="var(--canvas-muted)">
      <section className="shell" style={{ paddingBottom: 64 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 36, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>Door check-in</h1>
            <div style={{ marginTop: 6, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-2)" }}>
              {s ? `${s.event.committeeName === "ScottyLabs" ? "All-club" : `${s.event.committeeName} committee`} · ${s.event.title}` : "…"} · Scanning as{" "}
              {me.user?.andrewId ?? me.user?.email} ·{" "}
              <Link to={`/organize/${id}`} className="link-blue" style={{ fontWeight: 500 }}>
                Back to dashboard
              </Link>
            </div>
          </div>
          <div className="hide-mobile" style={{ marginLeft: "auto", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--muted-2)", background: "#fff", border: "1px solid var(--border)", borderRadius: 100, padding: "8px 16px" }}>
            Point the camera at a Scotty Invite QR
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 32, marginTop: 28, alignItems: "flex-start", fontFamily: "var(--font-ui)" }}>
          {/* Left stats */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: "1 1 240px", maxWidth: 340, minWidth: 240 }}>
            <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-2)" }}>Checked in</div>
              <div style={{ fontFamily: "var(--font-brand)", fontSize: 30, fontWeight: 700, color: "var(--text)", marginTop: 6 }}>
                {s?.stats.checkedIn ?? "—"}{" "}
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 500, color: "var(--muted-3)" }}>
                  / {capacity ?? s?.event.approvedCount ?? "—"}
                </span>
              </div>
              <div style={{ height: 5, background: "var(--border-subtle)", borderRadius: 100, marginTop: 10, overflow: "hidden" }}>
                <div style={{ height: 5, width: `${pct}%`, background: "var(--success)", borderRadius: 100, transition: "width 280ms var(--ease)" }} />
              </div>
            </div>
            <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", fontSize: 13, color: "var(--muted-1)" }}>
                <span>+1 guests arrived</span>
                <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text)" }}>{s?.stats.plusOnes ?? 0}</span>
              </div>
              <div style={{ display: "flex", fontSize: 13, color: "var(--muted-1)" }}>
                <span>Manual walk-ins</span>
                <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text)" }}>{s?.stats.walkIns ?? 0}</span>
              </div>
              <div style={{ display: "flex", fontSize: 13, color: "var(--muted-1)" }}>
                <span>Turned away</span>
                <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text)" }}>{s?.stats.turnedAway ?? 0}</span>
              </div>
            </div>
          </div>

          {/* Phone scanner */}
          <div
            style={{
              width: "100%",
              maxWidth: 390,
              minHeight: 640,
              background: "var(--black-surface)",
              borderRadius: 34,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 20px 48px rgba(6,63,88,0.35)",
              flex: "0 1 390px",
            }}
          >
            <div style={{ padding: "22px 18px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              <img src={logo} style={{ height: 18, filter: "brightness(0) invert(1)" }} alt="" />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{s?.event.title ?? "…"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>Door · check-in</div>
              </div>
              <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "#5eb9e0" }}>
                {s ? `${s.stats.checkedIn} / ${capacity ?? s.event.approvedCount} in` : ""}
              </span>
            </div>

            <div
              style={{
                position: "relative",
                margin: "6px 14px 0",
                borderRadius: 18,
                overflow: "hidden",
                flex: 1,
                minHeight: 300,
                background: "radial-gradient(340px 240px at 30% 20%, #1d2b36, #0d1319 70%),radial-gradient(280px 200px at 80% 85%, #16222c, transparent)",
              }}
            >
              <video ref={videoRef} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: cameraState === "on" ? 1 : 0 }} />
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(240px 160px at 60% 45%, rgba(14,150,209,0.12), transparent)" }} />
              <div className="scan-line" style={{ position: "absolute", left: "12%", right: "12%", height: 2, background: "linear-gradient(90deg,transparent,rgba(94,185,224,0.9),transparent)", top: "12%" }} />
              <div style={{ position: "absolute", top: "14%", left: "14%", width: 34, height: 34, borderTop: "3px solid #fff", borderLeft: "3px solid #fff", borderRadius: "6px 0 0 0", opacity: 0.9 }} />
              <div style={{ position: "absolute", top: "14%", right: "14%", width: 34, height: 34, borderTop: "3px solid #fff", borderRight: "3px solid #fff", borderRadius: "0 6px 0 0", opacity: 0.9 }} />
              <div style={{ position: "absolute", bottom: "14%", left: "14%", width: 34, height: 34, borderBottom: "3px solid #fff", borderLeft: "3px solid #fff", borderRadius: "0 0 0 6px", opacity: 0.9 }} />
              <div style={{ position: "absolute", bottom: "14%", right: "14%", width: 34, height: 34, borderBottom: "3px solid #fff", borderRight: "3px solid #fff", borderRadius: "0 0 6px 0", opacity: 0.9 }} />
              <div style={{ position: "absolute", left: 0, right: 0, bottom: "5%", textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.5)", padding: "0 20px" }}>
                {cameraState === "on"
                  ? "Point at a Scotty Invite QR"
                  : cameraState === "denied"
                    ? "Camera unavailable — use andrew-ID lookup below"
                    : "Starting camera…"}
              </div>
            </div>

            {result && palette && (
              <div className="fade-in" style={{ margin: "12px 14px 0", borderRadius: 14, padding: "14px 16px", background: palette.bg, border: `1px solid ${palette.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: "none", width: 34, height: 34, borderRadius: 100, background: palette.icon, display: "flex", alignItems: "center", justifyContent: "center", color: result.result === "duplicate" ? "#1e1e1e" : "#fff" }}>
                    {result.result === "ok" && <CheckIcon size={16} />}
                    {result.result === "plus_one" && <PlusIcon size={16} />}
                    {result.result === "duplicate" && <ClockIcon size={16} />}
                    {result.result === "denied" && <XIcon size={16} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {result.result === "denied" ? "Code not recognized" : result.guestName}
                      {result.result === "plus_one" && result.hostName ? ` (+1 of ${result.hostName})` : ""}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", marginTop: 2 }}>
                      {result.serial ?? "Unknown QR payload"}
                    </div>
                  </div>
                  <span style={{ flex: "none", fontSize: 10, fontWeight: 700, color: palette.chipFg, background: palette.chipBg, borderRadius: 100, padding: "4px 10px" }}>
                    {palette.label}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.7)", marginTop: 10, lineHeight: 1.45 }}>
                  {result.result === "duplicate" && result.originalAt
                    ? `This invite was scanned at ${fmtClock(result.originalAt)}.`
                    : result.result === "denied"
                      ? "Send them to the registration table."
                      : result.result === "plus_one"
                        ? "Transferred invite — counts against the host's pass. Checked in."
                        : "Checked in."}
                </div>
              </div>
            )}

            <div style={{ padding: "12px 14px 22px", display: "flex", gap: 10 }}>
              {lookupOpen ? (
                <form
                  style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 100, padding: "6px 8px 6px 16px" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (lookupValue.trim()) {
                      void submitCheckin({ andrewId: lookupValue.trim(), method: "manual" });
                      setLookupValue("");
                      setLookupOpen(false);
                    }
                  }}
                >
                  <SearchIcon size={13} style={{ color: "rgba(255,255,255,0.55)", flex: "none" }} />
                  <input
                    autoFocus
                    value={lookupValue}
                    onChange={(e) => setLookupValue(e.target.value)}
                    placeholder="andrew ID"
                    className="mono"
                    style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: 13 }}
                  />
                  <button type="submit" className="pill pill-blue" style={{ fontSize: 12, padding: "7px 14px" }}>
                    Check in
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setLookupOpen(true)}
                  style={{ all: "unset", cursor: "pointer", flex: 1, display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 100, padding: "11px 16px", fontSize: 12.5, color: "rgba(255,255,255,0.55)" }}
                >
                  <SearchIcon size={13} />
                  Look up andrew ID
                </button>
              )}
              <button
                onClick={() => void toggleTorch()}
                title="Torch"
                style={{ all: "unset", cursor: "pointer", width: 42, height: 42, borderRadius: 100, background: torchOn ? "rgba(94,185,224,0.35)" : "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.8)", flex: "none" }}
              >
                <FlashlightIcon size={16} />
              </button>
            </div>
          </div>

          {/* Recent scans */}
          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)", overflow: "hidden", flex: "1 1 280px", maxWidth: 400, minWidth: 260 }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)", fontFamily: "var(--font-brand)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>
              Recent scans
            </div>
            {stateQuery.isLoading && <Spinner label="Loading…" />}
            {s?.recent.length === 0 && <div style={{ padding: "22px 20px", fontSize: 13, color: "var(--muted-3)" }}>Scans land here in real time.</div>}
            {s?.recent.map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 20px", borderBottom: "1px solid var(--border-subtle)", fontSize: 13 }}>
                <div style={{ flex: "none", width: 8, height: 8, borderRadius: 100, background: DOT[r.result] }} />
                <div style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.result === "denied" ? "Unknown code" : r.name}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.serial ?? "—"}
                </div>
                <div style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted-3)", flex: "none" }}>{fmtClock(r.at)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </Page>
  );
}

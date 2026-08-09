import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrgEventDetail } from "@scottylabs-invites/contract";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AppFooter, AppHeader, Spinner } from "../components/AppShell";
import EventForm, {
  Card,
  asCategory,
  emptyEventForm,
  validateEventForm,
  type EventFormValues,
} from "../components/EventForm";
import { AlertCircleIcon, ArrowLeftIcon, LinkIcon, LockIcon } from "../components/icons";
import { nyWallClockToUtc, utcToNyWallClock } from "../lib/format";

function toFormValues(e: OrgEventDetail): EventFormValues {
  const start = utcToNyWallClock(e.startAt);
  const end = utcToNyWallClock(e.endAt);
  return {
    ...emptyEventForm(e.committee.id),
    category: e.category,
    title: e.title,
    description: e.description,
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    location: e.location,
    audience: e.audience,
    model: e.model,
    capacity: e.capacity !== null ? String(e.capacity) : "40",
    updatesEmail: e.updatesEmail,
    contactEmail: e.contactEmail,
    digest: e.digest,
    artwork: e.artwork,
    passStyle: e.passStyle,
    stampCommittee: e.stampCommittee,
    flagship: e.flagship,
    allowPlusOne: e.allowPlusOne,
  };
}

export default function EditEventPage() {
  const { me, loading } = useAuth();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const eventQuery = useQuery({
    queryKey: ["orgEvent", id],
    queryFn: async () => unwrap(await api.org.getEvent({ params: { id } }), 200),
    enabled: !!me.admin && !!id,
  });

  const committeesQuery = useQuery({
    queryKey: ["orgCommittees"],
    queryFn: async () => unwrap(await api.org.committees(), 200),
    enabled: !!me.admin,
  });

  const [values, setValues] = useState<EventFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const event = eventQuery.data;

  // Prefill once the event lands. Keyed on id so switching events refills.
  useEffect(() => {
    if (event) setValues(toFormValues(event));
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: async (v: EventFormValues) => {
      const problem = validateEventForm(v);
      if (problem) throw new Error(problem);
      const startAt = nyWallClockToUtc(v.date, v.startTime);
      let endAt = nyWallClockToUtc(v.date, v.endTime);
      if (endAt <= startAt) endAt = new Date(endAt.getTime() + 24 * 3600 * 1000);
      return unwrap(
        await api.org.updateEvent({
          params: { id },
          body: {
            title: v.title.trim(),
            description: v.description.trim(),
            category: asCategory(v.category),
            audience: v.audience,
            model: v.model,
            capacity: v.model === "capacity" ? Math.max(1, parseInt(v.capacity, 10) || 1) : null,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            location: v.location.trim(),
            artwork: v.artwork,
            passStyle: v.passStyle,
            stampCommittee: v.stampCommittee,
            allowPlusOne: v.allowPlusOne,
            flagship: v.flagship,
            updatesEmail: v.updatesEmail.trim(),
            contactEmail: v.contactEmail.trim(),
            digest: v.digest,
          },
        }),
        200,
      );
    },
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      await qc.invalidateQueries({ queryKey: ["orgEvent", id] });
      void qc.invalidateQueries({ queryKey: ["orgEvents"] });
      void qc.invalidateQueries({ queryKey: ["dashboard", id] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const setStatus = useMutation({
    mutationFn: async (status: "published" | "cancelled") =>
      unwrap(await api.org.updateEvent({ params: { id }, body: { status } }), 200),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ["orgEvent", id] });
      void qc.invalidateQueries({ queryKey: ["orgEvents"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: async () => unwrap(await api.org.deleteEvent({ params: { id } }), 200),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orgEvents"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
      navigate("/organize");
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!loading && !me.admin) {
    return (
      <Shell>
        <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)", color: "var(--muted-2)" }}>
          Editing events is admin-only. Ask a super admin for an invite.
        </div>
      </Shell>
    );
  }

  if (eventQuery.isError) {
    return (
      <Shell>
        <div className="shell" style={{ padding: "80px 0", textAlign: "center", fontFamily: "var(--font-ui)" }}>
          <h1 style={{ fontFamily: "var(--font-brand)", fontSize: "1.75rem", margin: 0 }}>Event not found</h1>
          <p style={{ color: "var(--muted-2)", fontSize: 14 }}>
            {(eventQuery.error as Error).message} — it may have been deleted, or belong to another committee.
          </p>
          <Link to="/organize" className="pill pill-outline" style={{ fontSize: 13, padding: "9px 20px" }}>
            Back to dashboard
          </Link>
        </div>
      </Shell>
    );
  }

  if (!event || !values) {
    return (
      <Shell>
        <div className="shell">
          <Spinner />
        </div>
      </Shell>
    );
  }

  const isSuper = me.admin?.role === "super_admin";
  const cancelled = event.status === "cancelled";
  const shareUrl = event.shareUrl;
  const confirmMatches = confirmText.trim().toLowerCase() === event.title.trim().toLowerCase();
  // The API allows a hard delete only with zero signups, or — for a super admin —
  // once the event has been cancelled. Mirror that so the button never lies.
  const canDelete = event.deletable || (isSuper && cancelled);

  return (
    <Shell>
      <section className="shell" style={{ paddingBottom: 72 }}>
        <Link
          to={`/organize/${event.id}`}
          className="fade-in"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 28, fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 500, color: "var(--muted-2)" }}
        >
          <ArrowLeftIcon size={14} />
          Back to dashboard
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#000" }}>Edit event</h1>
          {cancelled && (
            <span style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, fontWeight: 600, color: "#5a0f1d", background: "#fbe9ed", borderRadius: 100, padding: "4px 12px" }}>
              Cancelled
            </span>
          )}
        </div>
        <div style={{ marginTop: 6, fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--muted-2)" }}>
          {event.committee.isAllClub ? "All-club" : `${event.committee.name} committee`} · Nº {event.number} ·{" "}
          {event.registrationCount} {event.registrationCount === 1 ? "signup" : "signups"} ·{" "}
          <Link to={`/e/${event.shortCode}`} className="link-blue" style={{ fontWeight: 500 }}>
            View event page
          </Link>
        </div>

        <EventForm
          mode="edit"
          values={values}
          onChange={setValues}
          committees={committeesQuery.data?.committees ?? [event.committee]}
          myCommittee={event.committee}
          isSuper={!!isSuper}
          controls={committeesQuery.data?.questionControls}
          existingQuestions={event.questions}
          registrationExtra={
            event.model === "capacity" && values.model !== "capacity" && event.waitlistCount > 0 ? (
              <div className="fade-in" style={{ marginTop: 14, display: "flex", alignItems: "flex-start", gap: 10, background: "#fdf3e4", border: "1px solid #f0dcb4", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: "#654a00", lineHeight: 1.5 }}>
                <AlertCircleIcon size={14} style={{ marginTop: 2, flex: "none" }} />
                <span>
                  {event.waitlistCount} {event.waitlistCount === 1 ? "guest is" : "guests are"} on the waitlist. Dropping the cap{" "}
                  {values.model === "approval"
                    ? "moves them into your pending-requests queue to review."
                    : "admits all of them and emails each a Scotty Invite."}
                </span>
              </div>
            ) : values.model === "invite" ? (
              <div className="fade-in" style={{ marginTop: 14, background: "var(--canvas-muted)", border: "1px solid #d9e1e7", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--muted-1)" }}>
                  <LockIcon size={14} />
                  {event.model === "invite" ? (
                    <span>
                      Invite code <span className="mono" style={{ fontWeight: 600 }}>{event.inviteCode}</span> — the link below carries it.
                    </span>
                  ) : (
                    <span>Saving will unlist this event and generate an invite code.</span>
                  )}
                </div>
                {event.model === "invite" && (
                  <>
                    <div className="mono" style={{ fontSize: 11.5, color: "#38424b", background: "#fff", border: "1px solid #d9e1e7", borderRadius: 6, padding: "8px 10px", marginTop: 10, wordBreak: "break-all" }}>
                      {shareUrl.replace(/^https?:\/\//, "")}
                    </div>
                    <button
                      className="icon-link"
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(shareUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      }}
                    >
                      <LinkIcon size={14} />
                      {copied ? "Copied!" : "Copy invite link"}
                    </button>
                  </>
                )}
              </div>
            ) : event.model === "invite" ? (
              <div className="fade-in" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, background: "#fdf3e4", border: "1px solid #f0dcb4", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: "#654a00" }}>
                <AlertCircleIcon size={14} />
                Saving will list this event publicly and retire its invite code — old invite links stop working.
              </div>
            ) : null
          }
          footerExtra={
            <Card
              title="Danger zone"
              sub={
                event.deletable
                  ? "No one has signed up yet, so this event can be removed outright."
                  : "Cancelling keeps every registration, ticket and check-in record; deleting destroys them."
              }
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <button
                    className="pill pill-outline"
                    style={{ fontSize: 13, padding: "9px 20px" }}
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate(cancelled ? "published" : "cancelled")}
                  >
                    {setStatus.isPending ? "Saving…" : cancelled ? "Restore event" : "Cancel event"}
                  </button>
                  <span style={{ fontSize: 12, color: "var(--muted-3)", flex: "1 1 220px" }}>
                    {cancelled
                      ? "Restoring puts it back on the browse page and reopens signups."
                      : "Hides it from browse and closes signups. Guests keep their passes; nothing is deleted."}
                  </span>
                </div>

                <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
                  {canDelete ? (
                    <>
                      <div style={{ fontSize: 12.5, color: "var(--muted-1)", lineHeight: 1.5 }}>
                        Permanently delete <strong>{event.title}</strong>
                        {event.registrationCount > 0 && (
                          <>
                            {" "}
                            and its {event.registrationCount} registration{event.registrationCount === 1 ? "" : "s"}, tickets and check-in
                            history
                          </>
                        )}
                        . This cannot be undone.
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                        <input
                          className="input"
                          style={{ maxWidth: 260 }}
                          placeholder="Type the event name to confirm"
                          value={confirmText}
                          onChange={(e) => setConfirmText(e.target.value)}
                        />
                        <button
                          className="pill pill-outline pill-outline-danger"
                          style={{ fontSize: 13, padding: "9px 20px", color: confirmMatches ? "var(--danger-text)" : "var(--muted-3)", borderColor: confirmMatches ? "var(--danger)" : "var(--border)" }}
                          disabled={!confirmMatches || remove.isPending}
                          onClick={() => remove.mutate()}
                        >
                          {remove.isPending ? "Deleting…" : "Delete event"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12.5, color: "var(--muted-2)", lineHeight: 1.5 }}>
                      <AlertCircleIcon size={14} style={{ marginTop: 2, flex: "none" }} />
                      <span>
                        {event.registrationCount} {event.registrationCount === 1 ? "person has" : "people have"} signed up, so this event
                        can't be deleted directly.{" "}
                        {isSuper
                          ? "Cancel it first — then the delete option unlocks here."
                          : "Cancel it instead, or ask a super admin to delete it."}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          }
          railActions={
            <>
              {error && (
                <div className="fade-in" style={{ fontSize: 12.5, color: "var(--danger-text)", background: "#fbe9ed", border: "1px solid #f3c2cd", borderRadius: 8, padding: "10px 14px" }}>
                  {error}
                </div>
              )}
              {saved && (
                <div className="fade-in" style={{ fontSize: 12.5, color: "var(--success-text)", background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 8, padding: "10px 14px" }}>
                  Changes saved.
                </div>
              )}
              <button
                className="pill pill-blue"
                style={{ width: "100%", fontSize: 15, padding: "13px 0" }}
                disabled={save.isPending}
                onClick={() => {
                  setError(null);
                  save.mutate(values);
                }}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              <Link
                to={`/organize/${event.id}`}
                className="pill pill-outline"
                style={{ width: "100%", fontSize: 14, padding: "11px 0", justifyContent: "center", boxSizing: "border-box" }}
              >
                Cancel
              </Link>
              <div style={{ fontSize: 11.5, color: "var(--muted-3)", lineHeight: 1.5, padding: "0 4px" }}>
                Guests already holding a Scotty Invite keep it — changes to the time or room show up on their pass.
              </div>
            </>
          }
        />
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppHeader />
      <main style={{ flexGrow: 1, background: "var(--canvas-muted)" }}>{children}</main>
      <AppFooter />
    </div>
  );
}

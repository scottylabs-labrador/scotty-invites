import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AppFooter, AppHeader, Spinner } from "../components/AppShell";
import EventForm, { asCategory, emptyEventForm, validateEventForm, type EventFormValues } from "../components/EventForm";
import { CheckIcon, LinkIcon } from "../components/icons";
import { nyWallClockToUtc } from "../lib/format";

export default function CreateEventPage() {
  const { me, loading } = useAuth();
  const isSuper = me.admin?.role === "super_admin";

  const committeesQuery = useQuery({
    queryKey: ["orgCommittees"],
    queryFn: async () => unwrap(await api.org.committees(), 200),
    enabled: !!me.admin,
  });

  const [values, setValues] = useState<EventFormValues>(() => emptyEventForm());
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [published, setPublished] = useState<{ url: string; shortCode: string; id: string; inviteCode: string | null } | null>(null);

  const committees = committeesQuery.data?.committees ?? [];
  const controls = committeesQuery.data?.questionControls;
  const myCommittee = me.admin?.committee;
  const effectiveCommitteeId = values.committeeId || myCommittee?.id || "";

  /** The link that actually works — an invite-only event needs its code attached. */
  const shareUrl = published
    ? published.inviteCode
      ? `${published.url}?code=${encodeURIComponent(published.inviteCode)}`
      : published.url
    : "";

  const publish = useMutation({
    mutationFn: async () => {
      const problem = validateEventForm(values);
      if (problem) throw new Error(problem);
      const startAt = nyWallClockToUtc(values.date, values.startTime);
      let endAt = nyWallClockToUtc(values.date, values.endTime);
      if (endAt <= startAt) endAt = new Date(endAt.getTime() + 24 * 3600 * 1000);
      const res = await api.org.createEvent({
        body: {
          title: values.title.trim(),
          description: values.description.trim(),
          committeeId: effectiveCommitteeId,
          category: asCategory(values.category),
          audience: values.audience,
          model: values.model,
          capacity: values.model === "capacity" ? Math.max(1, parseInt(values.capacity, 10) || 1) : null,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          location: values.location.trim(),
          captures: {
            major_year: values.captures.major_year,
            dietary: values.captures.dietary,
            resume: values.captures.resume,
            source: values.captures.source,
            phone: values.captures.phone,
            tshirt: values.captures.tshirt,
          },
          hostQuestions: values.questions.filter((q) => q.text.trim()).map((q) => ({ label: q.text.trim(), type: q.type })),
          artwork: values.artwork,
          passStyle: values.passStyle,
          stampCommittee: values.stampCommittee,
          allowPlusOne: values.audience !== "cmu",
          flagship: values.flagship,
          updatesEmail: values.updatesEmail.trim(),
          contactEmail: values.contactEmail.trim(),
          digest: values.digest,
        },
      });
      return unwrap(res, 200);
    },
    onSuccess: (data) => setPublished(data),
    onError: (e: Error) => setError(e.message),
  });

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

          <EventForm
            mode="create"
            values={values}
            onChange={setValues}
            committees={isSuper ? committees : committees.length ? committees : myCommittee ? [myCommittee] : []}
            myCommittee={myCommittee}
            isSuper={isSuper}
            controls={controls}
            railActions={
              !published ? (
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
                  <div style={{ fontSize: 11.5, color: "var(--muted-3)", lineHeight: 1.5, padding: "0 4px" }}>
                    Publishing lists this event on the browse page and gives every guest a numbered Scotty Invite.
                  </div>
                </>
              ) : (
                <div className="fade-in" style={{ background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 12, padding: "18px 20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-brand)", fontSize: 15, fontWeight: 700, color: "var(--success-text)" }}>
                    <CheckIcon size={16} style={{ color: "var(--success)" }} />
                    Event is live
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: "#38424b", background: "#fff", border: "1px solid var(--success-border)", borderRadius: 6, padding: "8px 12px", marginTop: 10, wordBreak: "break-all" }}>
                    {shareUrl.replace(/^https?:\/\//, "")}
                  </div>
                  <button
                    className="icon-link"
                    style={{ marginTop: 10 }}
                    onClick={() => {
                      void navigator.clipboard.writeText(shareUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    }}
                  >
                    <LinkIcon size={14} />
                    {copied ? "Copied!" : published.inviteCode ? "Copy invite link" : "Copy event link"}
                  </button>
                  {published.inviteCode && (
                    <div style={{ fontSize: 12, color: "var(--muted-1)", marginTop: 10, lineHeight: 1.5 }}>
                      The link carries the code, so anyone you send it to gets straight in. If they need to type it:{" "}
                      <span className="mono">{published.inviteCode}</span>
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
              )
            }
          />
        </section>
      </main>
      <AppFooter />
    </div>
  );
}

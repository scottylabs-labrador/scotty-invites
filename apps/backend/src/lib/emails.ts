import { env } from "../env";
import { fmtLongDate, fmtTimeRange, pad3 } from "./format";

// ---------------------------------------------------------------------------
// Layout helpers — email-safe HTML, brand accents from the ScottyLabs DS.
// ---------------------------------------------------------------------------

const BLUE = "#0e96d1";
const TEXT = "#1e1e1e";
const MUTED = "#5f6f7f";
const BORDER = "#c7d2dc";

function layout(inner: string, preheader: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f0f4f8">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${BORDER};border-radius:16px">
<tr><td style="padding:28px 32px 0;font-family:Helvetica,Arial,sans-serif">
  <div style="font-size:16px;font-weight:bold;letter-spacing:-0.02em;color:${TEXT}">ScottyLabs <span style="color:${BLUE}">Invites</span></div>
</td></tr>
<tr><td style="padding:20px 32px 28px;font-family:Helvetica,Arial,sans-serif;color:${TEXT}">${inner}</td></tr>
</table>
<div style="max-width:520px;padding:14px 8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#7a8fa3;text-align:center">
Designed, developed and maintained with &#10084;&#65039; by ScottyLabs · <a href="${env.appUrl}" style="color:#0d89be;text-decoration:none">${env.appUrl.replace(/^https?:\/\//, "")}</a>
</div>
</td></tr></table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="background:${BLUE};border-radius:100px">
<a href="${href}" style="display:inline-block;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function h1(t: string): string {
  return `<div style="font-size:22px;font-weight:bold;letter-spacing:-0.02em;margin:4px 0 10px">${escapeHtml(t)}</div>`;
}

function p(t: string): string {
  return `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#38424b">${t}</p>`;
}

function mono(t: string): string {
  return `<span style="font-family:Menlo,Consolas,monospace;font-size:13px;color:${TEXT}">${escapeHtml(t)}</span>`;
}

function contactLine(contactEmail: string): string {
  return `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e9ebf8;font-family:Menlo,Consolas,monospace;font-size:11px;color:#7a8fa3">questions? <a href="mailto:${contactEmail}" style="color:#0d89be;text-decoration:none">${escapeHtml(contactEmail)}</a></div>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface EventEmailInfo {
  title: string;
  startAt: Date;
  endAt: Date;
  location: string;
  contactEmail: string;
  committeeName: string;
  shortCode: string;
}

function eventBlock(ev: EventEmailInfo): string {
  return `<div style="margin:14px 0;padding:14px 16px;border:1px solid ${BORDER};border-radius:12px">
<div style="font-size:15px;font-weight:bold">${escapeHtml(ev.title)}</div>
<div style="margin-top:6px;font-size:13px;color:${MUTED}">${escapeHtml(fmtLongDate(ev.startAt))} · ${escapeHtml(fmtTimeRange(ev.startAt, ev.endAt))}</div>
<div style="margin-top:2px;font-size:13px;color:${MUTED}">${escapeHtml(ev.location)}</div>
<div style="margin-top:2px;font-size:12px;color:#7a8fa3">Hosted by ${escapeHtml(ev.committeeName)}</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function signInEmail(opts: { link: string; code: string }) {
  const inner = `${h1("Sign in to ScottyLabs Invites")}
${p("Click the button below, or enter the 6-digit code on the sign-in page. This link works once and expires in 10 minutes.")}
${button(opts.link, "Sign in")}
<div style="margin:6px 0 4px;font-size:12px;color:${MUTED}">Your code</div>
<div style="font-family:Menlo,Consolas,monospace;font-size:28px;letter-spacing:0.35em;font-weight:bold;color:${TEXT}">${opts.code}</div>
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#7a8fa3">Didn't request this? You can ignore this email — no one can sign in without it.</p>`;
  return {
    subject: `${opts.code} is your ScottyLabs Invites code`,
    html: layout(inner, `Your sign-in code is ${opts.code}`),
    text: `Sign in to ScottyLabs Invites\n\nYour code: ${opts.code}\nOr click: ${opts.link}\n\nThis expires in 10 minutes. If you didn't request it, ignore this email.`,
  };
}

export function adminInviteEmail(opts: { committeeName: string; role: string; invitedBy: string }) {
  const roleLabel = opts.role === "super_admin" ? "super admin" : "admin";
  const label = `${opts.committeeName} ${roleLabel}`;
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  const inner = `${h1("You're invited to organize")}
${p(`${escapeHtml(opts.invitedBy)} added you as ${article} <b>${escapeHtml(opts.committeeName)}</b> ${roleLabel} on ScottyLabs Invites — the event signup system for ScottyLabs.`)}
${p("Sign in with this email address and the Organize tab unlocks: create events, review requests, and run door check-in.")}
${button(`${env.appUrl}/signin`, "Sign in to get started")}
${p(`Your email works even if it isn't a CMU address — invited admins are domain-exempt.`)}`;
  return {
    subject: `You're ${article} ${label} on ScottyLabs Invites`,
    html: layout(inner, `Sign in to start organizing ${opts.committeeName} events`),
    text: `${opts.invitedBy} added you as ${article} ${label} on ScottyLabs Invites.\n\nSign in with this email at ${env.appUrl}/signin — the Organize tab unlocks once you do.`,
  };
}

export function ticketEmail(opts: {
  ev: EventEmailInfo;
  guestName: string;
  serial: string;
  number: number;
  promotedFromWaitlist?: boolean;
}) {
  const title = opts.promotedFromWaitlist ? "You're off the waitlist — you're in" : "You're in";
  const inner = `${h1(title)}
${p(`${escapeHtml(opts.guestName.split(" ")[0] || opts.guestName)}, Scotty Invite <b>Nº ${pad3(opts.number)}</b> is yours.`)}
${eventBlock(opts.ev)}
${p(`Show the QR under <b>My tickets</b> at the door — or add it to your wallet. Your pass serial is ${mono(opts.serial)}.`)}
${button(`${env.appUrl}/tickets`, "View my Scotty Invite")}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `Scotty Invite Nº ${pad3(opts.number)} — ${opts.ev.title}`,
    html: layout(inner, `Your Scotty Invite for ${opts.ev.title}`),
    text: `${title}!\n\nScotty Invite No ${pad3(opts.number)} — ${opts.ev.title}\n${fmtLongDate(opts.ev.startAt)} · ${fmtTimeRange(opts.ev.startAt, opts.ev.endAt)}\n${opts.ev.location}\nSerial: ${opts.serial}\n\nView it: ${env.appUrl}/tickets\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function requestReceivedEmail(opts: { ev: EventEmailInfo; guestName: string }) {
  const inner = `${h1("Request sent")}
${p(`We passed your request along to the ${escapeHtml(opts.ev.committeeName)} team — they review daily. Once you're approved, your Scotty Invite lands here and under My tickets.`)}
${eventBlock(opts.ev)}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `Request received — ${opts.ev.title}`,
    html: layout(inner, `Your request for ${opts.ev.title} is in review`),
    text: `Request sent!\n\n${opts.ev.title} — the ${opts.ev.committeeName} team reviews daily. You'll get your Scotty Invite by email once approved.\n\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function waitlistedEmail(opts: { ev: EventEmailInfo; position: number }) {
  const inner = `${h1("You're on the waitlist")}
${p(`This one's full for now — you're <b>#${opts.position}</b> in line. Spots free up when guests cancel, and we promote in order automatically. You'll get your Scotty Invite by email the moment you're in.`)}
${eventBlock(opts.ev)}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `Waitlist #${opts.position} — ${opts.ev.title}`,
    html: layout(inner, `You're #${opts.position} on the waitlist for ${opts.ev.title}`),
    text: `You're #${opts.position} on the waitlist for ${opts.ev.title}. We promote in order automatically — your Scotty Invite arrives by email the moment you're in.\n\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function declinedEmail(opts: { ev: EventEmailInfo }) {
  const inner = `${h1("About your request")}
${p(`The ${escapeHtml(opts.ev.committeeName)} team couldn't fit you in for <b>${escapeHtml(opts.ev.title)}</b> this time. More events are always coming — keep an eye on the browse page.`)}
${button(`${env.appUrl}`, "Browse events")}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `About your request — ${opts.ev.title}`,
    html: layout(inner, `An update on your request for ${opts.ev.title}`),
    text: `The ${opts.ev.committeeName} team couldn't fit you in for ${opts.ev.title} this time.\n\nBrowse more events: ${env.appUrl}\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function plusOneClaimedEmail(opts: { ev: EventEmailInfo; hostName: string; claimerName: string }) {
  const inner = `${h1("Your +1 is in")}
${p(`<b>${escapeHtml(opts.claimerName)}</b> claimed your +1 invite for <b>${escapeHtml(opts.ev.title)}</b>. Their pass is tied to yours and counts against your invite at the door.`)}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `${opts.claimerName} claimed your +1 — ${opts.ev.title}`,
    html: layout(inner, `${opts.claimerName} claimed your +1`),
    text: `${opts.claimerName} claimed your +1 invite for ${opts.ev.title}. Their pass is tied to yours.\n\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function plusOneInviteEmail(opts: { ev: EventEmailInfo; hostName: string; url: string }) {
  const inner = `${h1(`${opts.hostName} sent you a +1`)}
${p(`You're invited to <b>${escapeHtml(opts.ev.title)}</b> as ${escapeHtml(opts.hostName)}'s +1. Claim the link below with any email — it becomes your own numbered Scotty Invite.`)}
${eventBlock(opts.ev)}
${button(opts.url, "Claim my Scotty Invite")}
${contactLine(opts.ev.contactEmail)}`;
  return {
    subject: `Your +1 invite — ${opts.ev.title}`,
    html: layout(inner, `${opts.hostName} sent you a +1 for ${opts.ev.title}`),
    text: `${opts.hostName} sent you a +1 for ${opts.ev.title}.\nClaim it: ${opts.url}\n\nquestions? ${opts.ev.contactEmail}`,
    replyTo: opts.ev.contactEmail,
  };
}

export function digestEmail(opts: {
  ev: EventEmailInfo;
  newSignups: number;
  pendingCount: number;
  approved: number;
  capacity: number | null;
  waitlist: number;
  dashboardUrl: string;
  cadence: string;
}) {
  const capLabel = opts.capacity ? ` of ${opts.capacity}` : "";
  const inner = `${h1(`${opts.ev.title} — ${opts.cadence} digest`)}
${p(`<b>${opts.newSignups}</b> new signup${opts.newSignups === 1 ? "" : "s"} since the last digest · <b>${opts.approved}</b>${capLabel} approved · <b>${opts.waitlist}</b> waitlisted.`)}
${opts.pendingCount > 0 ? p(`<b>${opts.pendingCount}</b> request${opts.pendingCount === 1 ? "" : "s"} waiting for review.`) : p("All caught up — nothing waiting for review.")}
${button(opts.dashboardUrl, "Open dashboard")}`;
  return {
    subject: `[${opts.ev.title}] ${opts.newSignups} new signup${opts.newSignups === 1 ? "" : "s"}, ${opts.pendingCount} to review`,
    html: layout(inner, `${opts.newSignups} new signups, ${opts.pendingCount} waiting`),
    text: `${opts.ev.title} — ${opts.cadence} digest\n\n${opts.newSignups} new signups since the last digest\n${opts.approved}${capLabel} approved · ${opts.waitlist} waitlisted\n${opts.pendingCount} requests waiting for review\n\nDashboard: ${opts.dashboardUrl}`,
  };
}

export function escalationEmail(opts: { ev: EventEmailInfo; count: number; oldestHours: number; dashboardUrl: string }) {
  const inner = `${h1("Requests waiting more than 24 hours")}
${p(`<b>${opts.count}</b> request${opts.count === 1 ? "" : "s"} for <b>${escapeHtml(opts.ev.title)}</b> ${opts.count === 1 ? "has" : "have"} been pending for over 24 hours (oldest: ~${opts.oldestHours}h). Guests are waiting on you.`)}
${button(opts.dashboardUrl, "Review requests now")}`;
  return {
    subject: `⚠ ${opts.count} request${opts.count === 1 ? "" : "s"} pending >24h — ${opts.ev.title}`,
    html: layout(inner, `${opts.count} requests pending more than 24 hours`),
    text: `${opts.count} requests for ${opts.ev.title} have been pending for over 24 hours (oldest ~${opts.oldestHours}h).\n\nReview: ${opts.dashboardUrl}`,
  };
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface IcsEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: Date;
  endAt: Date;
  url: string;
}

export function buildIcs(events: IcsEvent[], calName = "ScottyLabs Invites"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ScottyLabs//Invites//EN",
    `X-WR-CALNAME:${icsEscape(calName)}`,
    "X-WR-TIMEZONE:America/New_York",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(ev.uid)}@invite.scottylabs.org`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(ev.startAt)}`,
      `DTEND:${icsDate(ev.endAt)}`,
      `SUMMARY:${icsEscape(ev.title)}`,
      `DESCRIPTION:${icsEscape(ev.description ? `${ev.description}\n\n${ev.url}` : ev.url)}`,
      `LOCATION:${icsEscape(ev.location)}`,
      `URL:${icsEscape(ev.url)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function googleCalendarUrl(ev: IcsEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${icsDate(ev.startAt)}/${icsDate(ev.endAt)}`,
    details: `${ev.description}\n\n${ev.url}`.trim(),
    location: ev.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

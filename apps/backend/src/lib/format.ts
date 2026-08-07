const TZ = "America/New_York";

export function fmtLongDate(d: Date): string {
  // "Friday, September 11"
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(d);
}

export function fmtShortDate(d: Date): string {
  // "Fri, Sep 11"
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(d);
}

export function fmtTime(d: Date): string {
  // "7:00 PM"
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
}

export function fmtTimeWithZone(d: Date): string {
  // "7:00 PM EDT"
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

export function fmtTimeRange(start: Date, end: Date): string {
  // "7:00 – 10:00 PM EDT" (drops the first meridiem when both match)
  const s = fmtTime(start);
  const e = fmtTimeWithZone(end);
  const sMer = s.slice(-2);
  const eMer = fmtTime(end).slice(-2);
  const sBare = sMer === eMer ? s.slice(0, -3) : s;
  return `${sBare} – ${e}`;
}

export function fmtPassStamp(d: Date): string {
  // "SEP 11 · 19:00"
  const mon = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" }).format(d).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" }).format(d);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${mon} ${day} · ${hm}`;
}

export function fmtStubDate(d: Date): string {
  // "FEB 06 2026"
  const mon = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" }).format(d).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "2-digit" }).format(d);
  const year = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(d);
  return `${mon} ${day} ${year}`;
}

export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

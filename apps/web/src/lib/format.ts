const TZ = "America/New_York";

export function d(iso: string): Date {
  return new Date(iso);
}

export function fmtLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(d(iso));
}

export function fmtShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(d(iso));
}

export function fmtRailDate(iso: string): string {
  // "Sep 11"
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d(iso));
}

export function fmtWeekday(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(d(iso));
}

export function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d(iso));
}

export function fmtTimeWithZone(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
    d(iso),
  );
}

/** "7:00 – 10:00 PM" (first meridiem dropped when both match) */
export function fmtTimeRange(startIso: string, endIso: string, withZone = false): string {
  const s = fmtTime(startIso);
  const e = withZone ? fmtTimeWithZone(endIso) : fmtTime(endIso);
  const sMer = s.slice(-2);
  const eMer = fmtTime(endIso).slice(-2);
  const sBare = sMer === eMer ? s.slice(0, -3) : s;
  return `${sBare} – ${e}`;
}

export function fmtPassStamp(iso: string): string {
  // "SEP 11 · 19:00 EDT"
  const date = d(iso);
  const mon = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" }).format(date).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" }).format(date);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  return `${mon} ${day} · ${hm}${zone ? ` ${zone}` : ""}`;
}

export function fmtMonthTile(iso: string): { mon: string; day: string } {
  const date = d(iso);
  return {
    mon: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short" }).format(date),
    day: new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" }).format(date),
  };
}

export function fmtClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d(iso));
}

export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function nyDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d(iso));
}

/** Interprets a "YYYY-MM-DD" + "HH:mm" wall-clock pair as America/New_York and returns the UTC instant. */
export function nyWallClockToUtc(date: string, time: string): Date {
  const asIfUtc = new Date(`${date}T${time}:00Z`).getTime();
  const offsetAt = (t: number) => {
    const dt = new Date(t);
    const utc = new Date(dt.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const ny = new Date(dt.toLocaleString("en-US", { timeZone: TZ })).getTime();
    return ny - utc;
  };
  let instant = asIfUtc - offsetAt(asIfUtc);
  instant = asIfUtc - offsetAt(instant);
  return new Date(instant);
}

/** Inverse of nyWallClockToUtc — splits a UTC instant back into the NY wall-clock
 *  date + time pair the create/edit form's <input type="date"|"time"> expect. */
export function utcToNyWallClock(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { date: nyDayKey(iso), time: `${hour}:${minute}` };
}

export const GRADIENTS: Record<string, string> = {
  brand: "conic-gradient(from 180deg at 50% 50%, #d72444 0%, #8766d4 25%, #0e96d1 55%, #063f58 80%, #d72444 100%)",
  cool: "linear-gradient(135deg,#0e96d1 0%,#6940c9 100%)",
  warm: "linear-gradient(135deg,#d72444 0%,#8766d4 100%)",
  sunset: "linear-gradient(135deg,#e8b13a 0%,#df6f3c 50%,#d72444 100%)",
  deep: "linear-gradient(135deg,#063f58 0%,#0e96d1 100%)",
};

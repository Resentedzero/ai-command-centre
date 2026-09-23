/**
 * The Command Keep's clock. Authoritative instants are UTC (`timestamptz`); a wall-clock reading
 * ("09:00 on Monday") only means something in the workplace's configured IANA timezone, never the
 * server's or the browser's. `Intl.DateTimeFormat` does the zone arithmetic, so daylight-saving
 * transitions follow the platform's tz database. Pure functions; no dependency.
 */

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall clock in `timeZone` at `instant`, with its ISO weekday (1 = Monday). */
export function wallClock(instant: Date, timeZone: string): WallClock & { weekday: number; second: number } {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday!]!,
  };
}

/** The zone's offset from UTC at `instant`, in minutes (Europe/London in summer: +60). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant a wall-clock reading denotes in `timeZone`. A time skipped by a spring-forward
 * transition resolves to the instant just after the gap; a time repeated by a fall-back
 * transition resolves to its first (earlier) occurrence.
 */
export function fromWallClock(w: WallClock, timeZone: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // Two candidate offsets: the ones in force a day either side of the reading.
  const before = offsetMinutes(new Date(naive - 86_400_000), timeZone);
  const after = offsetMinutes(new Date(naive + 86_400_000), timeZone);
  const candidates = [...new Set([before, after])].map((o) => new Date(naive - o * 60_000)).sort((a, b) => a.getTime() - b.getTime());
  for (const c of candidates) {
    const back = wallClock(c, timeZone);
    if (back.year === w.year && back.month === w.month && back.day === w.day && back.hour === w.hour && back.minute === w.minute) return c;
  }
  // In a spring-forward gap: no candidate reads back; take the later offset's instant (just after the gap).
  return new Date(naive - Math.min(before, after) * 60_000);
}

/** The calendar date `days` after the wall-clock date of `instant` (month and year rollover handled by UTC arithmetic). */
export function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** ISO weekday of a calendar date. */
export function weekdayOf(date: { year: number; month: number; day: number }): number {
  const js = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Midnight at the start of that calendar date in `timeZone`. */
export function startOfDay(date: { year: number; month: number; day: number }, timeZone: string): Date {
  return fromWallClock({ ...date, hour: 0, minute: 0 }, timeZone);
}

/** "2026-09-17 14:05" in `timeZone`. */
export function formatWall(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

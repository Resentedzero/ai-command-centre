/**
 * Times in the Command Keep's configured timezone (Settings → General), never the browser's. The
 * backend decides every instant; this only formats and lays out days for display.
 */
export type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string) {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    cache.set(timeZone, f);
  }
  return f;
}
const DAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function wall(instant: Date | string, timeZone: string): Wall {
  const p = Object.fromEntries(fmt(timeZone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: DAYS[p.weekday as string] ?? 1 };
}

const pad = (n: number) => String(n).padStart(2, "0");
export function hhmm(instant: Date | string, tz: string): string {
  const w = wall(instant, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}
export const dateKey = (w: Pick<Wall, "year" | "month" | "day">) => `${w.year}-${pad(w.month)}-${pad(w.day)}`;
export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const minutesLabel = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** The instant a wall clock denotes in `timeZone` (the first occurrence when the clocks go back). */
export function fromWall(w: Pick<Wall, "year" | "month" | "day" | "hour" | "minute">, timeZone: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const offset = (t: number) => {
    const x = wall(new Date(t), timeZone);
    return (Date.UTC(x.year, x.month - 1, x.day, x.hour, x.minute) - Math.floor(t / 60_000) * 60_000) / 60_000;
  };
  for (const o of [...new Set([offset(naive - 86_400_000), offset(naive + 86_400_000)])].sort((a, b) => b - a)) {
    const c = new Date(naive - o * 60_000);
    const back = wall(c, timeZone);
    if (back.hour === w.hour && back.minute === w.minute && back.day === w.day) return c;
  }
  return new Date(naive - offset(naive) * 60_000);
}

export function addDays(d: Pick<Wall, "year" | "month" | "day">, n: number) {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

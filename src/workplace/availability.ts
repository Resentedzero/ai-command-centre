/**
 * Availability and conflicts: pure, deterministic functions over already-loaded workplace facts.
 * No model computes any of this; nothing here reads the database or the clock (`now` is passed in).
 *
 * An agent over a range is:
 * - `unavailable`: stopped, inside an `unavailable` calendar entry, or (when working hours are enforced)
 *   the range is not inside its working hours;
 * - `busy`: overlapping a meeting that is not cancelled, or an appointment, break or scheduled work;
 * - `available` otherwise.
 * Ranges are half-open [start, end): a meeting ending at 10:00 does not conflict with one starting at 10:00.
 */
import { addDays, fromWallClock, wallClock, weekdayOf } from "./zonedTime.js";

export type Interval = { start: Date; end: Date };
export type WorkingHours = { workStartMinute: number; workEndMinute: number; workingDays: number[] };
export type WorkplaceClock = WorkingHours & { timezone: string; outsideWorkingHours: "forbid" | "allow" };

export type Commitment = {
  agentName: string | null;
  kind: "meeting" | "appointment" | "break" | "unavailable" | "scheduled_work" | "deadline";
  id: string;
  title: string;
  start: Date;
  end: Date;
};

export type AgentAvailability = {
  agentName: string;
  status: "available" | "busy" | "unavailable";
  reasons: string[];
  commitments: Commitment[];
};

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** The agent's working intervals in [from, to), day by day in the workplace timezone. */
export function workingIntervals(hours: WorkingHours, timezone: string, range: Interval): Interval[] {
  const out: Interval[] = [];
  const first = wallClock(range.start, timezone);
  for (let day = { year: first.year, month: first.month, day: first.day }, i = 0; i < 400; day = addDays(day, 1), i++) {
    const dayStart = fromWallClock({ ...day, hour: 0, minute: 0 }, timezone);
    if (dayStart >= range.end) break;
    if (!hours.workingDays.includes(weekdayOf(day))) continue;
    const at = (minute: number) => fromWallClock({ ...day, hour: Math.floor(minute / 60), minute: minute % 60 }, timezone);
    const start = at(hours.workStartMinute);
    const end = hours.workEndMinute >= 1440 ? fromWallClock({ ...addDays(day, 1), hour: 0, minute: 0 }, timezone) : at(hours.workEndMinute);
    if (overlaps({ start, end }, range)) out.push({ start, end });
  }
  return out;
}

export function withinWorkingHours(hours: WorkingHours, timezone: string, range: Interval): boolean {
  return workingIntervals(hours, timezone, range).some((w) => w.start <= range.start && range.end <= w.end);
}

const BLOCKING: Commitment["kind"][] = ["meeting", "appointment", "break", "scheduled_work"];

export function availabilityOf(input: {
  agentName: string;
  range: Interval;
  clock: WorkplaceClock;
  hours: WorkingHours;
  stopped: boolean;
  commitments: Commitment[];
  /** A meeting being moved does not conflict with itself. */
  ignoreMeetingId?: string;
}): AgentAvailability {
  const mine = input.commitments.filter(
    (c) => (c.agentName === input.agentName || (c.agentName === null && c.kind !== "deadline")) && c.id !== input.ignoreMeetingId && overlaps(c, input.range)
  );
  const reasons: string[] = [];
  let status: AgentAvailability["status"] = "available";
  if (input.stopped) reasons.push("stopped by an emergency stop");
  for (const c of mine.filter((c) => c.kind === "unavailable")) reasons.push(`unavailable: ${c.title}`);
  if (input.clock.outsideWorkingHours === "forbid" && !withinWorkingHours(input.hours, input.clock.timezone, input.range)) reasons.push("outside working hours");
  if (reasons.length > 0) status = "unavailable";
  else {
    for (const c of mine.filter((c) => BLOCKING.includes(c.kind))) reasons.push(`${c.kind === "meeting" ? "in meeting" : c.kind.replace("_", " ")}: ${c.title}`);
    if (reasons.length > 0) status = "busy";
  }
  return { agentName: input.agentName, status, reasons, commitments: mine };
}

/**
 * Whether the agent may take NEW work at this instant: inside its working hours (when the Keep forbids
 * work outside them) and not inside a blocking commitment. An instant, not a range — starting work is a
 * point in time, unlike booking a meeting, which needs a whole slot free.
 */
export function availableAt(input: { clock: WorkplaceClock; hours: WorkingHours; commitments: Commitment[]; agentName: string; at: Date }): { ok: true } | { ok: false; reason: string } {
  const range = { start: input.at, end: new Date(input.at.getTime() + 1) };
  const a = availabilityOf({ agentName: input.agentName, range, clock: input.clock, hours: input.hours, stopped: false, commitments: input.commitments });
  return a.status === "available" ? { ok: true } : { ok: false, reason: a.reasons[0] ?? a.status };
}

/**
 * The next instant the agent could take work, searching forward from `from` on the slot grid, or null if
 * it is not free within `withinDays`. Deterministic and bounded; nothing here estimates how long work
 * takes, and being unavailable is never a failure — it is a time.
 */
export function nextAvailableFrom(input: { clock: WorkplaceClock; hours: WorkingHours; commitments: Commitment[]; agentName: string; from: Date; withinDays?: number }): Date | null {
  const step = SLOT_STEP_MINUTES * 60_000;
  const limit = input.from.getTime() + (input.withinDays ?? 14) * 86_400_000;
  if (availableAt({ ...input, at: input.from }).ok) return input.from;
  for (let t = Math.ceil(input.from.getTime() / step) * step; t <= limit; t += step) {
    if (availableAt({ ...input, at: new Date(t) }).ok) return new Date(t);
  }
  return null;
}

export type Room = { id: string; name: string; purpose: string; capacity: number; active: boolean };

/** Rooms that can hold `size` people over `range`: active, big enough, not booked. Smallest adequate first, then by name. */
export function roomsFor(rooms: Room[], bookings: { roomId: string; meetingId: string; start: Date; end: Date }[], size: number, range: Interval, ignoreMeetingId?: string): Room[] {
  return rooms
    .filter((r) => r.active && r.capacity >= size && !bookings.some((b) => b.roomId === r.id && b.meetingId !== ignoreMeetingId && overlaps(b, range)))
    .sort((a, b) => a.capacity - b.capacity || a.name.localeCompare(b.name));
}

export const SLOT_STEP_MINUTES = 15;

/**
 * The earliest start in [window.start, window.end − duration] on the slot grid where every participant
 * is available and a room fits. `check` receives each candidate and returns a room or null.
 */
export function earliestSlot(window: Interval, durationMinutes: number, check: (range: Interval) => Room | null): { range: Interval; room: Room } | null {
  const step = SLOT_STEP_MINUTES * 60_000;
  let t = Math.ceil(window.start.getTime() / step) * step;
  for (let i = 0; i < 20_000 && t + durationMinutes * 60_000 <= window.end.getTime(); i++, t += step) {
    const range = { start: new Date(t), end: new Date(t + durationMinutes * 60_000) };
    const room = check(range);
    if (room) return { range, room };
  }
  return null;
}

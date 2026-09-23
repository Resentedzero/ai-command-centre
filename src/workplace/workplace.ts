/**
 * The Command Keep's internal workplace: settings, rooms, calendar entries, meetings and internal
 * notifications. Office facts, not runtime work — a meeting creates no Goal, Run or model call, and
 * attending one earns nothing. Work that comes out of a meeting is started through the existing
 * runtime (a Manager mission), and recorded here only as a link.
 *
 * AUTHORITY. Every write validates by code, takes advisory locks on the rooms and participants it
 * touches, re-checks conflicts inside that lock, writes its rows and emits one event through the
 * existing event log, in the caller's transaction. The caller is either an operator API route
 * (actor `human:operator`) or the Manager's governed capability position (actor `agent:<name>`,
 * with its Goal, Run and Invocation as provenance). Nothing here grants, budgets, approves, stops or
 * routes, and nothing here reads world geometry (structural invariant).
 *
 * TIME. Instants are UTC; "working hours", "today" and "tomorrow morning" are read in the workplace's
 * configured timezone (`./zonedTime.ts`). Meeting status is derived from its times — never ticked:
 * cancelled | scheduled | starting | in_progress | completed. "Starting" is the gather window
 * (`gatherMinutes` before the start), when participants leave for the room; it is still a meeting that
 * has not begun, so it can still be moved or cancelled.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  agentDefinitions,
  events,
  executionStops,
  workplaceAgentSettings,
  workplaceCalendarEvents,
  workplaceMeetingParticipants,
  workplaceMeetings,
  workplaceNotifications,
  workplaceRooms,
  workplaceSettings,
  type WorkplaceEntry,
} from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitLifecycleEvent, NO_CORRELATION, type Correlation } from "../events/lifecycle.js";
import { availabilityOf, earliestSlot, overlaps, roomsFor, type AgentAvailability, type Commitment, type Interval, type Room, type WorkingHours, type WorkplaceClock } from "./availability.js";
import { addDays, formatWall, fromWallClock, isValidTimeZone, wallClock } from "./zonedTime.js";

// ---------------------------------------------------------------------------
// Errors and limits
// ---------------------------------------------------------------------------

export const WORKPLACE_CODES = [
  "invalid_meeting",
  "unknown_participant",
  "participant_unavailable",
  "participant_conflict",
  "outside_working_hours",
  "room_not_found",
  "room_inactive",
  "insufficient_room_capacity",
  "room_conflict",
  "no_common_availability",
  "meeting_not_found",
  "meeting_not_changeable",
  "invalid_settings",
  "invalid_room",
  "invalid_calendar_entry",
  "invalid_message",
] as const;
export type WorkplaceCode = (typeof WORKPLACE_CODES)[number];

export class WorkplaceError extends Error {
  constructor(
    readonly code: WorkplaceCode,
    detail: string,
    readonly status = 409
  ) {
    super(detail);
  }
}

export const WORKPLACE_LIMITS = { titleChars: 120, agendaChars: 2_000, entryChars: 2_000, minMinutes: 5, maxMinutes: 480, maxParticipants: 50, horizonDays: 90, maxEntries: 50 };

export const ROOM_PURPOSES = ["boardroom", "conference", "small_meeting", "one_to_one", "presentation", "lounge"] as const;
export const CALENDAR_KINDS = ["appointment", "break", "unavailable", "scheduled_work", "deadline"] as const;
/**
 * Notification kinds. The first seven are the office's own notices, written beside the change they
 * describe. The rest (R2 Stage 11) are DERIVED from runtime events by `api/operationalNotices.ts`: the
 * runtime already records these facts, and a notice is only ever a second view of one — never a new fact.
 */
export const NOTIFICATION_KINDS = [
  "meeting_invitation",
  "meeting_reminder",
  "meeting_changed",
  "meeting_cancelled",
  "work_assigned",
  "announcement",
  "message",
  // Derived from events. Each carries the event's own identity in its idempotency key.
  "task_failed",
  "mission_completed",
  "mission_failed",
  "mission_recovered",
  "meeting_held",
  "meeting_not_held",
  "decision_recorded",
  "follow_up_created",
  "goal_overdue",
  "stop_engaged",
] as const;

/**
 * How loudly a notice asks to be read, from its kind alone. A static map, applied when notices are read:
 * nothing is stored, nothing is scored, and no model is asked. Lower is more urgent.
 */
export const NOTIFICATION_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  stop_engaged: 0,
  approval_required: 0,
  task_failed: 1,
  mission_failed: 1,
  goal_overdue: 1,
  meeting_not_held: 2,
  meeting_reminder: 2,
  meeting_cancelled: 2,
  meeting_changed: 3,
  meeting_invitation: 3,
  work_assigned: 3,
  mission_recovered: 3,
  follow_up_created: 3,
  decision_recorded: 4,
  meeting_held: 4,
  mission_completed: 4,
  announcement: 5,
  message: 5,
});
export const notificationPriority = (kind: string): number => NOTIFICATION_PRIORITY[kind] ?? 5;

const PRODUCER = "workplace";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Settings = typeof workplaceSettings.$inferSelect;
const SETTINGS_ID = "default";
const DEFAULT_SETTINGS: Settings = {
  id: SETTINGS_ID,
  timezone: "Europe/London",
  workStartMinute: 540,
  workEndMinute: 1020,
  workingDays: [1, 2, 3, 4, 5],
  outsideWorkingHours: "forbid",
  workOutsideHours: "allow",
  defaultMeetingMinutes: 30,
  reminderMinutes: 10,
  gatherMinutes: 2,
  notifyInvitations: true,
  notifyReminders: true,
  notifyAnnouncements: true,
  updatedAt: new Date(0),
};

export async function readSettings(tx: DrizzleTransaction): Promise<Settings> {
  return (await tx.query.workplaceSettings.findFirst({ where: eq(workplaceSettings.id, SETTINGS_ID) })) ?? DEFAULT_SETTINGS;
}

export function clockOf(s: Settings): WorkplaceClock {
  return { timezone: s.timezone, workStartMinute: s.workStartMinute, workEndMinute: s.workEndMinute, workingDays: s.workingDays, outsideWorkingHours: s.outsideWorkingHours === "allow" ? "allow" : "forbid" };
}

const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const days = (v: unknown) => Array.isArray(v) && v.length <= 7 && v.every((d) => intIn(d, 1, 7)) && new Set(v).size === v.length;

type Body = Record<string, unknown>;

/** Validates and saves a partial settings change; emits `workplace_settings_changed`. Returns the event key. */
export async function updateSettings(tx: DrizzleTransaction, body: Body, actor: string): Promise<{ settings: Settings; eventKey: string }> {
  const allowed = ["timezone", "workStartMinute", "workEndMinute", "workingDays", "outsideWorkingHours", "workOutsideHours", "defaultMeetingMinutes", "reminderMinutes", "gatherMinutes", "notifyInvitations", "notifyReminders", "notifyAnnouncements"];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  const bad = (m: string) => new WorkplaceError("invalid_settings", m, 400);
  if (extra.length > 0) throw bad(`unknown setting(s): ${extra.join(", ")}`);
  const current = await readSettings(tx);
  const next = { ...current, ...body } as Settings;
  if (typeof next.timezone !== "string" || !isValidTimeZone(next.timezone)) throw bad("timezone must be an IANA timezone such as Europe/London");
  if (!intIn(next.workStartMinute, 0, 1439) || !intIn(next.workEndMinute, 1, 1440) || next.workEndMinute <= next.workStartMinute) throw bad("working hours must be a start before an end, in minutes after midnight");
  if (!days(next.workingDays)) throw bad("workingDays must list distinct ISO weekdays (1 = Monday)");
  if (next.outsideWorkingHours !== "forbid" && next.outsideWorkingHours !== "allow") throw bad('outsideWorkingHours must be "forbid" or "allow"');
  if (next.workOutsideHours !== "forbid" && next.workOutsideHours !== "allow") throw bad('workOutsideHours must be "forbid" or "allow"');
  if (!intIn(next.defaultMeetingMinutes, WORKPLACE_LIMITS.minMinutes, WORKPLACE_LIMITS.maxMinutes)) throw bad(`defaultMeetingMinutes must be ${WORKPLACE_LIMITS.minMinutes}-${WORKPLACE_LIMITS.maxMinutes}`);
  if (!intIn(next.reminderMinutes, 0, 1440) || !intIn(next.gatherMinutes, 0, 60)) throw bad("reminderMinutes must be 0-1440 and gatherMinutes 0-60");
  for (const k of ["notifyInvitations", "notifyReminders", "notifyAnnouncements"] as const) if (typeof next[k] !== "boolean") throw bad(`${k} must be true or false`);
  const values = { ...next, id: SETTINGS_ID, updatedAt: new Date() };
  await tx.insert(workplaceSettings).values(values).onConflictDoUpdate({ target: workplaceSettings.id, set: values });
  const eventKey = `workplace_settings_changed:${randomUUID()}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_settings_changed", subjectId: SETTINGS_ID, correlation: NO_CORRELATION, producer: PRODUCER, actor, payload: { changed: Object.keys(body) }, idempotencyKey: eventKey });
  return { settings: values, eventKey };
}

/** Per-agent working hours; a field left null uses the workplace setting. */
export async function updateAgentHours(tx: DrizzleTransaction, agentName: string, body: Body, actor: string): Promise<{ eventKey: string }> {
  const bad = (m: string) => new WorkplaceError("invalid_settings", m, 400);
  const extra = Object.keys(body).filter((k) => !["workStartMinute", "workEndMinute", "workingDays"].includes(k));
  if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(", ")}`);
  if (!(await agentExists(tx, agentName))) throw new WorkplaceError("unknown_participant", `no agent named "${agentName}"`, 404);
  const start = body.workStartMinute ?? null;
  const end = body.workEndMinute ?? null;
  const wd = body.workingDays ?? null;
  if ((start === null) !== (end === null)) throw bad("give both workStartMinute and workEndMinute, or neither");
  if (start !== null && (!intIn(start, 0, 1439) || !intIn(end, 1, 1440) || (end as number) <= (start as number))) throw bad("working hours must be a start before an end, in minutes after midnight");
  if (wd !== null && !days(wd)) throw bad("workingDays must list distinct ISO weekdays (1 = Monday)");
  const values = { agentName, workStartMinute: start as number | null, workEndMinute: end as number | null, workingDays: wd as number[] | null, updatedAt: new Date() };
  await tx.insert(workplaceAgentSettings).values(values).onConflictDoUpdate({ target: workplaceAgentSettings.agentName, set: values });
  const eventKey = `workplace_agent_hours_changed:${agentName}:${randomUUID()}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_agent_hours_changed", subjectId: agentName, correlation: NO_CORRELATION, producer: PRODUCER, actor, payload: { agentName, workStartMinute: start, workEndMinute: end, workingDays: wd }, idempotencyKey: eventKey });
  return { eventKey };
}

export async function listAgentHours(tx: DrizzleTransaction) {
  return tx.select().from(workplaceAgentSettings).orderBy(asc(workplaceAgentSettings.agentName));
}

/** A meeting not cancelled and not yet started with this title (case-insensitive), if any. */
export async function upcomingMeetingTitled(tx: DrizzleTransaction, title: string, now: Date): Promise<{ id: string; title: string } | null> {
  const rows = await tx.select({ id: workplaceMeetings.id, title: workplaceMeetings.title }).from(workplaceMeetings).where(and(isNull(workplaceMeetings.cancelledAt), gt(workplaceMeetings.startsAt, now)));
  return rows.find((m) => m.title.toLowerCase() === title.toLowerCase()) ?? null;
}

async function hoursFor(tx: DrizzleTransaction, settings: Settings, names: string[]): Promise<Map<string, WorkingHours>> {
  const rows = names.length ? await tx.select().from(workplaceAgentSettings).where(inArray(workplaceAgentSettings.agentName, names)) : [];
  return new Map(
    names.map((n) => {
      const r = rows.find((x) => x.agentName === n);
      return [
        n,
        {
          workStartMinute: r?.workStartMinute ?? settings.workStartMinute,
          workEndMinute: r?.workEndMinute ?? settings.workEndMinute,
          workingDays: r?.workingDays ?? settings.workingDays,
        },
      ];
    })
  );
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export type RoomRow = typeof workplaceRooms.$inferSelect;

/**
 * The initial rooms, each on a drawn room of the keep map that has somewhere to gather (the map is one
 * baked image; a room placed on a bare corridor would show nothing). The Conference room has no drawn
 * space of its own yet, so it starts inactive and unplaced.
 */
export const DEFAULT_ROOMS: { name: string; purpose: (typeof ROOM_PURPOSES)[number]; capacity: number; areas: string[]; active: boolean }[] = [
  // `areas`: the drawn rooms this meeting room may occupy, best first. Which of them the current world
  // actually has is decided when the room is created or repaired — world templates differ.
  { name: "Boardroom", purpose: "boardroom", capacity: 12, areas: ["Council hall", "Council common room", "Council tables", "Map room"], active: true },
  { name: "Presentation room", purpose: "presentation", capacity: 8, areas: ["Map room", "Council hall", "Council common room"], active: true },
  { name: "Small meeting room", purpose: "small_meeting", capacity: 4, areas: ["Vault", "Map-room lounge", "Library"], active: true },
  { name: "One-to-one room", purpose: "one_to_one", capacity: 2, areas: ["Reading nook", "Quiet forge corner", "Map-room lounge", "Benches"], active: true },
  { name: "Break room", purpose: "lounge", capacity: 14, areas: ["Entrance plaza", "Benches", "Gathering spot"], active: true },
  { name: "Conference room", purpose: "conference", capacity: 10, areas: [], active: false },
];

export async function listRooms(tx: DrizzleTransaction): Promise<RoomRow[]> {
  return tx.select().from(workplaceRooms).orderBy(asc(workplaceRooms.name));
}

function validateRoom(body: Body, partial: boolean) {
  const bad = (m: string) => new WorkplaceError("invalid_room", m, 400);
  const extra = Object.keys(body).filter((k) => !["name", "purpose", "capacity", "locationAreaName", "active"].includes(k));
  if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(", ")}`);
  const out: Partial<RoomRow> = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "" || body.name.length > 60) throw bad("name must be 1-60 characters");
    out.name = body.name.trim();
  }
  if (!partial || body.purpose !== undefined) {
    if (!(ROOM_PURPOSES as readonly unknown[]).includes(body.purpose)) throw bad(`purpose must be one of ${ROOM_PURPOSES.join(", ")}`);
    out.purpose = body.purpose as string;
  }
  if (!partial || body.capacity !== undefined) {
    if (!intIn(body.capacity, 1, 100)) throw bad("capacity must be 1-100");
    out.capacity = body.capacity as number;
  }
  if (body.locationAreaName !== undefined) {
    if (body.locationAreaName !== null && (typeof body.locationAreaName !== "string" || body.locationAreaName.length > 80)) throw bad("locationAreaName must be an area name or null");
    out.locationAreaName = (body.locationAreaName as string | null) ?? null;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw bad("active must be true or false");
    out.active = body.active;
  }
  return out;
}

export async function createRoom(tx: DrizzleTransaction, body: Body, actor: string): Promise<{ room: RoomRow; eventKey: string }> {
  const values = validateRoom(body, false);
  if (await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.name, values.name!) })) throw new WorkplaceError("invalid_room", `a room named "${values.name}" exists`);
  const [room] = await tx.insert(workplaceRooms).values(values as typeof workplaceRooms.$inferInsert).returning();
  const eventKey = `workplace_room_created:${room!.id}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_room_created", subjectId: room!.id, correlation: NO_CORRELATION, producer: PRODUCER, actor, payload: { roomId: room!.id, ...values }, idempotencyKey: eventKey });
  return { room: room!, eventKey };
}

/** A room is never deleted: deactivate it. A deactivated room keeps its past and already-scheduled meetings; it takes no new ones. */
export async function updateRoom(tx: DrizzleTransaction, roomId: string, body: Body, actor: string): Promise<{ room: RoomRow; eventKey: string }> {
  const values = validateRoom(body, true);
  const existing = await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.id, roomId) });
  if (!existing) throw new WorkplaceError("room_not_found", "no such room", 404);
  if (values.name && values.name !== existing.name && (await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.name, values.name) }))) throw new WorkplaceError("invalid_room", `a room named "${values.name}" exists`);
  const [room] = await tx.update(workplaceRooms).set({ ...values, updatedAt: new Date() }).where(eq(workplaceRooms.id, roomId)).returning();
  const eventKey = `workplace_room_changed:${roomId}:${randomUUID()}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_room_changed", subjectId: roomId, correlation: NO_CORRELATION, producer: PRODUCER, actor, payload: { roomId, changes: values }, idempotencyKey: eventKey });
  return { room: room!, eventKey };
}

/**
 * Seed and repair the default rooms against the world as it is now. A room is created only if none of that
 * name exists, on the first of its candidate areas the world actually has. A seeded room already pointing at
 * an area this world does not have (a template switch retires the old areas) is re-pointed to a candidate
 * that exists, or left off the map when none does — meetings in it are kept either way, and the change is
 * recorded like any other room change. Rooms the operator made or moved are never touched.
 *
 * `areaNames` comes from the caller (`../definitions/seed.ts`), because this module never reads the world.
 */
export async function ensureDefaultRooms(tx: DrizzleTransaction, actor: string, areaNames: string[] = []): Promise<boolean> {
  let changed = false;
  const has = (name: string | null) => name !== null && areaNames.includes(name);
  for (const r of DEFAULT_ROOMS) {
    const place = r.areas.find((a) => areaNames.includes(a)) ?? null;
    const existing = await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.name, r.name) });
    if (!existing) {
      await createRoom(tx, { name: r.name, purpose: r.purpose, capacity: r.capacity, locationAreaName: place, active: r.active }, actor);
      changed = true;
      continue;
    }
    // Only a seeded room that has drifted off the map is repaired, and only when this world has somewhere to put it.
    if (areaNames.length > 0 && !has(existing.locationAreaName) && place && place !== existing.locationAreaName) {
      await updateRoom(tx, existing.id, { locationAreaName: place }, actor);
      changed = true;
    }
  }
  return changed;
}

/** Rooms whose area this world does not have: they take meetings, but nobody can be drawn in them. */
export function roomsOffTheMap(rooms: RoomRow[], areaNames: string[]): RoomRow[] {
  return rooms.filter((r) => r.active && (r.locationAreaName === null || !areaNames.includes(r.locationAreaName)));
}

// ---------------------------------------------------------------------------
// Agents and facts
// ---------------------------------------------------------------------------

async function agentExists(tx: DrizzleTransaction, name: string): Promise<boolean> {
  return !!(await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, name) }));
}

/** Every agent name in the Registry (all versions collapse to one person). */
export async function agentNames(tx: DrizzleTransaction): Promise<string[]> {
  const rows = await tx.selectDistinct({ name: agentDefinitions.name }).from(agentDefinitions).orderBy(asc(agentDefinitions.name));
  return rows.map((r) => r.name);
}

/** Names covered by an engaged stop right now (global, or on any version of the agent). */
export async function stoppedNames(tx: DrizzleTransaction, names: string[]): Promise<Set<string>> {
  const stops = await tx.select({ scope: executionStops.scope, ref: executionStops.scopeRefId }).from(executionStops).where(isNull(executionStops.liftedAt));
  if (stops.some((s) => s.scope === "global")) return new Set(names);
  const refs = stops.filter((s) => s.scope === "agent_definition").map((s) => s.ref.toLowerCase());
  if (refs.length === 0 || names.length === 0) return new Set();
  const defs = await tx.select({ id: agentDefinitions.id, name: agentDefinitions.name }).from(agentDefinitions).where(inArray(agentDefinitions.name, names));
  return new Set(defs.filter((d) => refs.includes(d.id.toLowerCase())).map((d) => d.name));
}

type MeetingRow = typeof workplaceMeetings.$inferSelect;

export type MeetingStatus = "scheduled" | "starting" | "in_progress" | "completed" | "cancelled";
export function meetingStatus(m: { startsAt: Date; endsAt: Date; cancelledAt: Date | null }, now: Date, gatherMinutes = 0): MeetingStatus {
  if (m.cancelledAt) return "cancelled";
  if (now >= m.endsAt) return "completed";
  if (now >= m.startsAt) return "in_progress";
  if (now >= new Date(m.startsAt.getTime() - gatherMinutes * 60_000)) return "starting";
  return "scheduled";
}

/** A meeting that has not begun: it can still be moved or cancelled. */
export const notBegun = (status: MeetingStatus) => status === "scheduled" || status === "starting";

/** Everything that can conflict with [range): meetings not cancelled (with participants) and calendar entries not cancelled. */
async function loadCommitments(tx: DrizzleTransaction, range: Interval): Promise<{ commitments: Commitment[]; bookings: { roomId: string; meetingId: string; start: Date; end: Date }[] }> {
  const meetings = await tx
    .select()
    .from(workplaceMeetings)
    .where(and(isNull(workplaceMeetings.cancelledAt), lt(workplaceMeetings.startsAt, range.end), gt(workplaceMeetings.endsAt, range.start)));
  const parts = meetings.length ? await tx.select().from(workplaceMeetingParticipants).where(inArray(workplaceMeetingParticipants.meetingId, meetings.map((m) => m.id))) : [];
  const entries = await tx
    .select()
    .from(workplaceCalendarEvents)
    .where(and(isNull(workplaceCalendarEvents.cancelledAt), lt(workplaceCalendarEvents.startsAt, range.end), gt(workplaceCalendarEvents.endsAt, range.start)));
  return {
    commitments: [
      ...parts.map((p) => {
        const m = meetings.find((x) => x.id === p.meetingId)!;
        return { agentName: p.agentName, kind: "meeting" as const, id: m.id, title: m.title, start: m.startsAt, end: m.endsAt };
      }),
      ...entries.map((e) => ({ agentName: e.agentName, kind: e.kind as Commitment["kind"], id: e.id, title: e.title, start: e.startsAt, end: e.endsAt })),
    ],
    bookings: meetings.map((m) => ({ roomId: m.roomId, meetingId: m.id, start: m.startsAt, end: m.endsAt })),
  };
}

/** Availability of each named agent over [range), from the records. */
/**
 * Everything the pure availability functions need for these agents over this range, read ONCE: the Keep's
 * clock, each agent's effective working hours, and every commitment in the window. Callers that ask about
 * many agents (the agent-state read model) must share one of these rather than re-reading per agent.
 *
 * Stops are deliberately NOT included: an emergency stop is authority, answered by the governance module,
 * and must never look like a diary entry.
 */
/** The clock as EXECUTION sees it: the same hours and days, gated by `workOutsideHours`. */
export function workClockOf(s: Settings): WorkplaceClock {
  return { ...clockOf(s), outsideWorkingHours: s.workOutsideHours === "forbid" ? "forbid" : "allow" };
}

export async function availabilityInputs(tx: DrizzleTransaction, names: string[], range: Interval): Promise<{ clock: WorkplaceClock; hours: Map<string, WorkingHours>; commitments: Commitment[] }> {
  const settings = await readSettings(tx);
  return { clock: workClockOf(settings), hours: await hoursFor(tx, settings, names), commitments: (await loadCommitments(tx, range)).commitments };
}

export async function availabilityFor(tx: DrizzleTransaction, names: string[], range: Interval, opts: { ignoreMeetingId?: string } = {}): Promise<AgentAvailability[]> {
  const settings = await readSettings(tx);
  const clock = clockOf(settings);
  const hours = await hoursFor(tx, settings, names);
  const stopped = await stoppedNames(tx, names);
  const { commitments } = await loadCommitments(tx, range);
  return names.map((n) => availabilityOf({ agentName: n, range, clock, hours: hours.get(n)!, stopped: stopped.has(n), commitments, ...(opts.ignoreMeetingId ? { ignoreMeetingId: opts.ignoreMeetingId } : {}) }));
}

// ---------------------------------------------------------------------------
// Timing windows ("tomorrow morning") — resolved by code in the workplace timezone
// ---------------------------------------------------------------------------

export const TIMING_WINDOWS = ["asap", "today", "this_morning", "this_afternoon", "tomorrow", "tomorrow_morning", "tomorrow_afternoon", "this_week", "next_week", "at"] as const;
export type TimingWindow = (typeof TIMING_WINDOWS)[number];

const NOON = 12 * 60;

/**
 * The search window a timing phrase denotes. `at` takes a local "YYYY-MM-DDTHH:MM" and denotes exactly that
 * start. Mornings run from midnight to noon and afternoons from noon to midnight; working hours (when
 * enforced) narrow them further during the search, so this stays independent of per-agent hours.
 */
export function timingWindow(settings: Settings, timing: { window: TimingWindow; at?: string }, now: Date, durationMinutes: number): Interval | null {
  const tz = settings.timezone;
  const today = wallClock(now, tz);
  const date = { year: today.year, month: today.month, day: today.day };
  const at = (d: { year: number; month: number; day: number }, minute: number) => fromWallClock({ ...d, hour: Math.floor(minute / 60), minute: minute % 60 }, tz);
  const dayRange = (d: typeof date, from: number, to: number): Interval => ({ start: at(d, from), end: to >= 1440 ? fromWallClock({ ...addDays(d, 1), hour: 0, minute: 0 }, tz) : at(d, to) });
  const tomorrow = addDays(date, 1);
  const monday = addDays(date, 1 - today.weekday);
  switch (timing.window) {
    case "asap":
      return { start: now, end: new Date(now.getTime() + 7 * 86_400_000) };
    case "today":
      return dayRange(date, 0, 1440);
    case "this_morning":
      return dayRange(date, 0, NOON);
    case "this_afternoon":
      return dayRange(date, NOON, 1440);
    case "tomorrow":
      return dayRange(tomorrow, 0, 1440);
    case "tomorrow_morning":
      return dayRange(tomorrow, 0, NOON);
    case "tomorrow_afternoon":
      return dayRange(tomorrow, NOON, 1440);
    case "this_week":
      return { start: now, end: at(addDays(monday, 7), 0) };
    case "next_week":
      return { start: at(addDays(monday, 7), 0), end: at(addDays(monday, 14), 0) };
    case "at": {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(timing.at ?? "");
      if (!m) return null;
      const start = fromWallClock({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! }, tz);
      return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
    }
  }
}

// ---------------------------------------------------------------------------
// Proposals: the earliest valid slot and room, by code
// ---------------------------------------------------------------------------

export type Proposal = { startsAt: Date; endsAt: Date; roomId: string; roomName: string };

/**
 * Finds the earliest start in `window` (never before now + the gather time) at which every participant is
 * available and an active room with enough seats is free — the preferred room or purpose first when one is
 * named. Throws a coded WorkplaceError naming the real blocker when there is none.
 */
export async function proposeMeeting(
  tx: DrizzleTransaction,
  input: { participants: string[]; durationMinutes: number; window: Interval; now: Date; roomName?: string | null; roomPurpose?: string | null; ignoreMeetingId?: string }
): Promise<Proposal> {
  await validateParticipants(tx, input.participants);
  validateDuration(input.durationMinutes);
  const settings = await readSettings(tx);
  const clock = clockOf(settings);
  const earliest = new Date(Math.max(input.window.start.getTime(), input.now.getTime() + settings.gatherMinutes * 60_000));
  const latest = new Date(Math.min(input.window.end.getTime(), input.now.getTime() + WORKPLACE_LIMITS.horizonDays * 86_400_000));
  if (earliest.getTime() + input.durationMinutes * 60_000 > latest.getTime()) throw new WorkplaceError("no_common_availability", "the requested time has already passed or is too short for the meeting");

  const stopped = await stoppedNames(tx, input.participants);
  if (stopped.size > 0) throw new WorkplaceError("participant_unavailable", `${[...stopped].join(", ")} ${stopped.size === 1 ? "is" : "are"} stopped by an emergency stop`);

  const rooms = (await listRooms(tx)).map((r) => ({ id: r.id, name: r.name, purpose: r.purpose, capacity: r.capacity, active: r.active }));
  let candidates: Room[] = rooms;
  if (input.roomName) {
    const named = rooms.find((r) => r.name.toLowerCase() === input.roomName!.toLowerCase());
    if (!named) throw new WorkplaceError("room_not_found", `no room named "${input.roomName}"`);
    if (!named.active) throw new WorkplaceError("room_inactive", `${named.name} is not in use`);
    candidates = [named];
  }
  const size = input.participants.length;
  if (!candidates.some((r) => r.active && r.capacity >= size)) {
    const biggest = Math.max(0, ...candidates.filter((r) => r.active).map((r) => r.capacity));
    throw new WorkplaceError("insufficient_room_capacity", `${size} participants; the largest ${input.roomName ? "requested " : ""}active room seats ${biggest}`);
  }
  const hours = await hoursFor(tx, settings, input.participants);
  const { commitments, bookings } = await loadCommitments(tx, { start: earliest, end: latest });
  const preferPurpose = (list: Room[]) => (input.roomPurpose ? [...list.filter((r) => r.purpose === input.roomPurpose), ...list.filter((r) => r.purpose !== input.roomPurpose)] : list);

  const slot = earliestSlot({ start: earliest, end: latest }, input.durationMinutes, (range) => {
    const everyoneFree = input.participants.every(
      (n) => availabilityOf({ agentName: n, range, clock, hours: hours.get(n)!, stopped: false, commitments, ...(input.ignoreMeetingId ? { ignoreMeetingId: input.ignoreMeetingId } : {}) }).status === "available"
    );
    if (!everyoneFree) return null;
    return preferPurpose(roomsFor(candidates, bookings, size, range, input.ignoreMeetingId))[0] ?? null;
  });
  if (!slot) {
    const window = `${formatWall(earliest, settings.timezone)} – ${formatWall(latest, settings.timezone)} (${settings.timezone})`;
    throw new WorkplaceError("no_common_availability", `no ${input.durationMinutes}-minute slot in ${window} when all ${size} participants are available and a room with ${size} seats is free${clock.outsideWorkingHours === "forbid" ? " within working hours" : ""}`);
  }
  return { startsAt: slot.range.start, endsAt: slot.range.end, roomId: slot.room.id, roomName: slot.room.name };
}

async function validateParticipants(tx: DrizzleTransaction, names: string[]): Promise<void> {
  if (!Array.isArray(names) || names.length === 0 || names.length > WORKPLACE_LIMITS.maxParticipants || names.some((n) => typeof n !== "string")) {
    throw new WorkplaceError("invalid_meeting", `a meeting needs 1-${WORKPLACE_LIMITS.maxParticipants} participants`, 400);
  }
  if (new Set(names).size !== names.length) throw new WorkplaceError("invalid_meeting", "participants are listed twice", 400);
  const known = new Set(await agentNames(tx));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) throw new WorkplaceError("unknown_participant", `no agent named ${unknown.map((u) => `"${u.slice(0, 60)}"`).join(", ")}`);
}

function validateDuration(minutes: number) {
  if (!intIn(minutes, WORKPLACE_LIMITS.minMinutes, WORKPLACE_LIMITS.maxMinutes)) throw new WorkplaceError("invalid_meeting", `a meeting lasts ${WORKPLACE_LIMITS.minMinutes}-${WORKPLACE_LIMITS.maxMinutes} minutes`, 400);
}

// ---------------------------------------------------------------------------
// Meetings: schedule, reschedule, cancel, outcome
// ---------------------------------------------------------------------------

export type Provenance = { actor: string; goalId?: string | null; runId?: string | null; invocationId?: string | null; workflowRunId?: string | null; taskInstanceId?: string | null };
const correlationOf = (p: Provenance): Correlation => ({ goalId: p.goalId ?? null, workflowRunId: p.workflowRunId ?? null, taskInstanceId: p.taskInstanceId ?? null, runId: p.runId ?? null, invocationId: p.invocationId ?? null });

async function lockAll(tx: DrizzleTransaction, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workplace:${key}`}))`);
}

/**
 * Checks an exact slot inside the locks: valid times, known and available participants (the meeting being
 * moved excluded), an active room with the seats and no overlapping booking. Throws the first real blocker.
 */
async function assertSlot(tx: DrizzleTransaction, input: { participants: string[]; startsAt: Date; endsAt: Date; roomId: string; now: Date; ignoreMeetingId?: string }): Promise<RoomRow> {
  await validateParticipants(tx, input.participants);
  if (!(input.startsAt instanceof Date) || !(input.endsAt instanceof Date) || Number.isNaN(input.startsAt.getTime()) || Number.isNaN(input.endsAt.getTime())) throw new WorkplaceError("invalid_meeting", "start and end must be valid times", 400);
  validateDuration(Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000));
  if (input.endsAt.getTime() - input.startsAt.getTime() !== Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000) * 60_000) throw new WorkplaceError("invalid_meeting", "times are whole minutes", 400);
  if (input.startsAt.getTime() < input.now.getTime()) throw new WorkplaceError("invalid_meeting", "a meeting cannot start in the past");
  if (input.startsAt.getTime() > input.now.getTime() + WORKPLACE_LIMITS.horizonDays * 86_400_000) throw new WorkplaceError("invalid_meeting", `a meeting starts within ${WORKPLACE_LIMITS.horizonDays} days`, 400);
  const room = await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.id, input.roomId) });
  if (!room) throw new WorkplaceError("room_not_found", "no such room", 404);
  if (!room.active) throw new WorkplaceError("room_inactive", `${room.name} is not in use`);
  if (room.capacity < input.participants.length) throw new WorkplaceError("insufficient_room_capacity", `${room.name} seats ${room.capacity}; the meeting has ${input.participants.length} participants`);
  const range = { start: input.startsAt, end: input.endsAt };
  const { bookings } = await loadCommitments(tx, range);
  if (bookings.some((b) => b.roomId === room.id && b.meetingId !== input.ignoreMeetingId && overlaps(b, range))) throw new WorkplaceError("room_conflict", `${room.name} is already booked then`);
  const availability = await availabilityFor(tx, input.participants, range, input.ignoreMeetingId ? { ignoreMeetingId: input.ignoreMeetingId } : {});
  const unavailable = availability.filter((a) => a.status === "unavailable");
  if (unavailable.length > 0) {
    const outside = unavailable.every((a) => a.reasons.every((r) => r === "outside working hours"));
    throw new WorkplaceError(outside ? "outside_working_hours" : "participant_unavailable", unavailable.map((a) => `${a.agentName}: ${a.reasons.join("; ")}`).join(". "));
  }
  const busy = availability.filter((a) => a.status === "busy");
  if (busy.length > 0) throw new WorkplaceError("participant_conflict", busy.map((a) => `${a.agentName}: ${a.reasons.join("; ")}`).join(". "));
  return room;
}

async function notify(
  tx: DrizzleTransaction,
  rows: { recipient: string; kind: (typeof NOTIFICATION_KINDS)[number]; title: string; body?: string; sender: string; meetingId?: string | null; goalId?: string | null; deliverAt?: Date; idempotencyKey: string }[],
  now = new Date()
) {
  if (rows.length === 0) return;
  await tx
    .insert(workplaceNotifications)
    .values(rows.map((r) => ({ ...r, body: r.body ?? "", meetingId: r.meetingId ?? null, goalId: r.goalId ?? null, deliverAt: r.deliverAt ?? now })))
    .onConflictDoNothing({ target: workplaceNotifications.idempotencyKey });
}

/**
 * Write derived notices (R2 Stage 11). Same table, same dedup: the unique idempotency key plus
 * `onConflictDoNothing` means re-deriving the same event's notice is a no-op, however often the sweep
 * runs. Exported because the derivation lives outside this module — but it is still the only way in, so
 * every notice keeps one shape.
 */
export async function recordNotices(
  tx: DrizzleTransaction,
  rows: { recipient: string; kind: (typeof NOTIFICATION_KINDS)[number]; title: string; body?: string; sender: string; meetingId?: string | null; goalId?: string | null; idempotencyKey: string }[],
  now = new Date()
): Promise<void> {
  await notify(tx, rows, now);
}

async function withdrawPendingReminders(tx: DrizzleTransaction, meetingId: string, now: Date) {
  await tx
    .update(workplaceNotifications)
    .set({ withdrawnAt: now })
    .where(and(eq(workplaceNotifications.meetingId, meetingId), eq(workplaceNotifications.kind, "meeting_reminder"), gt(workplaceNotifications.deliverAt, now), isNull(workplaceNotifications.withdrawnAt)));
}

function describe(settings: Settings, m: { title: string; startsAt: Date; endsAt: Date }, roomName: string) {
  return `${m.title} — ${formatWall(m.startsAt, settings.timezone)}–${formatWall(m.endsAt, settings.timezone).slice(11)} (${settings.timezone}) in ${roomName}`;
}

async function inviteAndRemind(tx: DrizzleTransaction, settings: Settings, meeting: MeetingRow, roomName: string, participants: string[], sender: string, kind: "meeting_invitation" | "meeting_changed", now: Date) {
  const text = describe(settings, meeting, roomName);
  if (kind === "meeting_changed" || settings.notifyInvitations) {
    await notify(
      tx,
      participants.map((p) => ({ recipient: `agent:${p}`, kind, title: kind === "meeting_invitation" ? `Invitation: ${meeting.title}` : `Moved: ${meeting.title}`, body: text, sender, meetingId: meeting.id, goalId: meeting.goalId, idempotencyKey: `${kind}:${meeting.id}:${meeting.revision}:${p}` })),
      now
    );
  }
  if (settings.notifyReminders && settings.reminderMinutes > 0) {
    const deliverAt = new Date(Math.max(now.getTime(), meeting.startsAt.getTime() - settings.reminderMinutes * 60_000));
    await notify(
      tx,
      participants.map((p) => ({ recipient: `agent:${p}`, kind: "meeting_reminder" as const, title: `Reminder: ${meeting.title}`, body: text, sender: "workplace", meetingId: meeting.id, goalId: meeting.goalId, deliverAt, idempotencyKey: `meeting_reminder:${meeting.id}:${meeting.revision}:${p}` })),
      now
    );
  }
}

export type ScheduleInput = { title: string; agenda?: string; participants: string[]; startsAt: Date; endsAt: Date; roomId: string };

export async function scheduleMeeting(tx: DrizzleTransaction, input: ScheduleInput, provenance: Provenance, now = new Date()): Promise<{ meetingId: string; eventKey: string }> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > WORKPLACE_LIMITS.titleChars) throw new WorkplaceError("invalid_meeting", `title must be 1-${WORKPLACE_LIMITS.titleChars} characters`, 400);
  const agenda = typeof input.agenda === "string" ? input.agenda.trim() : "";
  if (agenda.length > WORKPLACE_LIMITS.agendaChars) throw new WorkplaceError("invalid_meeting", `agenda is at most ${WORKPLACE_LIMITS.agendaChars} characters`, 400);
  await lockAll(tx, [`room:${input.roomId}`, ...(input.participants ?? []).map((p) => `agent:${p}`)]);
  const room = await assertSlot(tx, { participants: input.participants, startsAt: input.startsAt, endsAt: input.endsAt, roomId: input.roomId, now });
  const settings = await readSettings(tx);
  const [meeting] = await tx
    .insert(workplaceMeetings)
    .values({ title, agenda, organiser: provenance.actor, roomId: room.id, startsAt: input.startsAt, endsAt: input.endsAt, goalId: provenance.goalId ?? null, runId: provenance.runId ?? null, invocationId: provenance.invocationId ?? null })
    .returning();
  const organiserName = provenance.actor.startsWith("agent:") ? provenance.actor.slice(6) : null;
  await tx.insert(workplaceMeetingParticipants).values(input.participants.map((p) => ({ meetingId: meeting!.id, agentName: p, role: p === organiserName ? "organiser" : "participant" })));
  await inviteAndRemind(tx, settings, meeting!, room.name, input.participants, provenance.actor, "meeting_invitation", now);
  const eventKey = `meeting_scheduled:${meeting!.id}`;
  await emitLifecycleEvent(tx, {
    eventType: "meeting_scheduled",
    subjectId: meeting!.id,
    correlation: correlationOf(provenance),
    producer: PRODUCER,
    actor: provenance.actor,
    idempotencyKey: eventKey,
    payload: presencePayload(meeting!, room.name, input.participants),
  });
  return { meetingId: meeting!.id, eventKey };
}

/** What the world may show: exactly what the event log recorded for the meeting's current revision. */
function presencePayload(m: MeetingRow, roomName: string, participants: string[]) {
  return { meetingId: m.id, title: m.title, roomId: m.roomId, roomName, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString(), participants: [...participants].sort(), organiser: m.organiser, revision: m.revision };
}

async function changeableMeeting(tx: DrizzleTransaction, meetingId: string, now: Date, action: string): Promise<MeetingRow> {
  // One change at a time per meeting: a cancel and a move cannot both pass the check below.
  await lockAll(tx, [`meeting:${meetingId}`]);
  const m = await tx.query.workplaceMeetings.findFirst({ where: eq(workplaceMeetings.id, meetingId) });
  if (!m) throw new WorkplaceError("meeting_not_found", "no such meeting", 404);
  const status = meetingStatus(m, now, (await readSettings(tx)).gatherMinutes);
  if (!notBegun(status)) throw new WorkplaceError("meeting_not_changeable", `the meeting is ${status.replace("_", " ")}; only a meeting that has not started can be ${action}`);
  return m;
}

async function participantsOf(tx: DrizzleTransaction, meetingId: string): Promise<string[]> {
  return (await tx.select({ n: workplaceMeetingParticipants.agentName }).from(workplaceMeetingParticipants).where(eq(workplaceMeetingParticipants.meetingId, meetingId)).orderBy(asc(workplaceMeetingParticipants.agentName))).map((r) => r.n);
}

/** Moves a meeting that has not started (same participants). Never creates a second meeting. */
export async function rescheduleMeeting(tx: DrizzleTransaction, input: { meetingId: string; startsAt: Date; endsAt: Date; roomId: string }, provenance: Provenance, now = new Date()): Promise<{ meetingId: string; eventKey: string }> {
  const before = await changeableMeeting(tx, input.meetingId, now, "moved");
  const participants = await participantsOf(tx, before.id);
  await lockAll(tx, [`room:${input.roomId}`, `room:${before.roomId}`, ...participants.map((p) => `agent:${p}`)]);
  const room = await assertSlot(tx, { participants, startsAt: input.startsAt, endsAt: input.endsAt, roomId: input.roomId, now, ignoreMeetingId: before.id });
  if (before.startsAt.getTime() === input.startsAt.getTime() && before.endsAt.getTime() === input.endsAt.getTime() && before.roomId === input.roomId) {
    throw new WorkplaceError("invalid_meeting", "the meeting is already at that time and room", 400);
  }
  const settings = await readSettings(tx);
  await withdrawPendingReminders(tx, before.id, now);
  const [after] = await tx
    .update(workplaceMeetings)
    .set({ startsAt: input.startsAt, endsAt: input.endsAt, roomId: room.id, revision: before.revision + 1, updatedAt: now })
    .where(eq(workplaceMeetings.id, before.id))
    .returning();
  await inviteAndRemind(tx, settings, after!, room.name, participants, provenance.actor, "meeting_changed", now);
  const eventKey = `meeting_rescheduled:${after!.id}:${after!.revision}`;
  await emitLifecycleEvent(tx, {
    eventType: "meeting_rescheduled",
    subjectId: after!.id,
    correlation: correlationOf(provenance),
    producer: PRODUCER,
    actor: provenance.actor,
    idempotencyKey: eventKey,
    payload: { ...presencePayload(after!, room.name, participants), previous: { startsAt: before.startsAt.toISOString(), endsAt: before.endsAt.toISOString(), roomId: before.roomId } },
  });
  return { meetingId: after!.id, eventKey };
}

/** Cancels a meeting that has not started. The record is kept; its pending reminders are withdrawn. */
export async function cancelMeeting(tx: DrizzleTransaction, input: { meetingId: string; reason?: string }, provenance: Provenance, now = new Date()): Promise<{ meetingId: string; eventKey: string }> {
  const m = await changeableMeeting(tx, input.meetingId, now, "cancelled");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  const participants = await participantsOf(tx, m.id);
  await withdrawPendingReminders(tx, m.id, now);
  await tx.update(workplaceMeetings).set({ cancelledAt: now, cancelReason: reason || null, updatedAt: now }).where(eq(workplaceMeetings.id, m.id));
  await notify(
    tx,
    participants.map((p) => ({ recipient: `agent:${p}`, kind: "meeting_cancelled" as const, title: `Cancelled: ${m.title}`, body: reason, sender: provenance.actor, meetingId: m.id, goalId: m.goalId, idempotencyKey: `meeting_cancelled:${m.id}:${p}` })),
    now
  );
  const eventKey = `meeting_cancelled:${m.id}`;
  await emitLifecycleEvent(tx, { eventType: "meeting_cancelled", subjectId: m.id, correlation: correlationOf(provenance), producer: PRODUCER, actor: provenance.actor, idempotencyKey: eventKey, payload: { meetingId: m.id, title: m.title, reason: reason || null, participants } });
  return { meetingId: m.id, eventKey };
}

/**
 * Records notes and decisions on a meeting that has started or ended, each entry stamped with who recorded
 * it. Only an operator route calls this: model text never becomes a meeting outcome by itself.
 */
export async function recordMeetingOutcome(tx: DrizzleTransaction, meetingId: string, body: Body, actor: string, now = new Date()): Promise<{ eventKey: string }> {
  const bad = (m: string) => new WorkplaceError("invalid_meeting", m, 400);
  const extra = Object.keys(body).filter((k) => k !== "notes" && k !== "decisions");
  if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(", ")}`);
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "" && x.length <= WORKPLACE_LIMITS.entryChars) ? (v as string[]).map((x) => x.trim()) : null);
  const notes = list(body.notes);
  const decisions = list(body.decisions);
  if (!notes || !decisions) throw bad(`notes and decisions are lists of 1-${WORKPLACE_LIMITS.entryChars} character texts`);
  if (notes.length + decisions.length === 0) throw bad("nothing to record");
  const m = await tx.query.workplaceMeetings.findFirst({ where: eq(workplaceMeetings.id, meetingId) });
  if (!m) throw new WorkplaceError("meeting_not_found", "no such meeting", 404);
  const status = meetingStatus(m, now, (await readSettings(tx)).gatherMinutes);
  if (notBegun(status) || status === "cancelled") throw new WorkplaceError("meeting_not_changeable", `the meeting is ${status.replace("_", " ")}; notes and decisions are recorded once it has started`);
  await lockAll(tx, [`meeting:${m.id}`]);
  const fresh = (await tx.query.workplaceMeetings.findFirst({ where: eq(workplaceMeetings.id, meetingId) }))!;
  const stamp = (text: string): WorkplaceEntry => ({ text, actor, at: now.toISOString() });
  if (fresh.notes.length + notes.length > WORKPLACE_LIMITS.maxEntries || fresh.decisions.length + decisions.length > WORKPLACE_LIMITS.maxEntries) throw bad(`a meeting holds at most ${WORKPLACE_LIMITS.maxEntries} notes and decisions each`);
  await tx
    .update(workplaceMeetings)
    .set({ notes: [...fresh.notes, ...notes.map(stamp)], decisions: [...fresh.decisions, ...decisions.map(stamp)], updatedAt: now })
    .where(eq(workplaceMeetings.id, m.id));
  const eventKey = `meeting_outcome_recorded:${m.id}:${fresh.notes.length + fresh.decisions.length}`;
  await emitLifecycleEvent(tx, { eventType: "meeting_outcome_recorded", subjectId: m.id, correlation: { ...NO_CORRELATION, goalId: m.goalId }, producer: PRODUCER, actor, idempotencyKey: eventKey, payload: { meetingId: m.id, notes, decisions } });
  return { eventKey };
}

/** Links work explicitly started from a meeting decision (the Goal already exists, created by the runtime). */
export async function recordMeetingAction(tx: DrizzleTransaction, meetingId: string, input: { goalId: string; text: string }, actor: string, now = new Date()): Promise<{ eventKey: string }> {
  const m = await tx.query.workplaceMeetings.findFirst({ where: eq(workplaceMeetings.id, meetingId) });
  if (!m) throw new WorkplaceError("meeting_not_found", "no such meeting", 404);
  await tx
    .update(workplaceMeetings)
    .set({ actions: [...m.actions, { goalId: input.goalId, text: input.text, actor, at: now.toISOString() }], updatedAt: now })
    .where(eq(workplaceMeetings.id, m.id));
  const eventKey = `meeting_action_started:${m.id}:${input.goalId}`;
  await emitLifecycleEvent(tx, { eventType: "meeting_action_started", subjectId: m.id, correlation: { ...NO_CORRELATION, goalId: input.goalId }, producer: PRODUCER, actor, idempotencyKey: eventKey, payload: { meetingId: m.id, goalId: input.goalId, text: input.text } });
  return { eventKey };
}

// ---------------------------------------------------------------------------
// Calendar entries (appointments, breaks, unavailable periods, scheduled work, deadlines)
// ---------------------------------------------------------------------------

/**
 * Meetings whose time has come and which the Keep has not yet tried to hold: begun, not over, not
 * cancelled, never convened and never refused. Time decides the status; this asks only "is it now".
 */
export async function meetingsToConvene(tx: DrizzleTransaction, now = new Date()): Promise<string[]> {
  const rows = await tx
    .select({ id: workplaceMeetings.id })
    .from(workplaceMeetings)
    .where(
      and(
        isNull(workplaceMeetings.cancelledAt),
        isNull(workplaceMeetings.convenedAt),
        isNull(workplaceMeetings.notConvenedReason),
        lte(workplaceMeetings.startsAt, now),
        gt(workplaceMeetings.endsAt, now)
      )
    )
    .orderBy(asc(workplaceMeetings.startsAt))
    .limit(20);
  return rows.map((r) => r.id);
}

/** The Keep held this meeting: the round-table Workflow Run's Goal, and when it began. */
export async function markMeetingConvened(tx: DrizzleTransaction, meetingId: string, goalId: string, now = new Date()): Promise<{ eventKey: string }> {
  await tx.update(workplaceMeetings).set({ convenedGoalId: goalId, convenedAt: now, updatedAt: now }).where(eq(workplaceMeetings.id, meetingId));
  const eventKey = `meeting_convened:${meetingId}`;
  await emitLifecycleEvent(tx, { eventType: "meeting_convened", subjectId: meetingId, correlation: { ...NO_CORRELATION, goalId }, producer: PRODUCER, actor: "system", idempotencyKey: eventKey, payload: { meetingId, goalId } });
  return { eventKey };
}

/**
 * The Keep could NOT hold this meeting, and why — a participant was working, stopped or already in
 * another meeting. Recorded once, so the calendar says plainly that nobody met rather than leaving a
 * past meeting looking like one that happened.
 */
export async function markMeetingNotConvened(tx: DrizzleTransaction, meetingId: string, reason: string, now = new Date()): Promise<{ eventKey: string }> {
  await tx.update(workplaceMeetings).set({ notConvenedReason: reason.slice(0, WORKPLACE_LIMITS.entryChars), updatedAt: now }).where(eq(workplaceMeetings.id, meetingId));
  const eventKey = `meeting_not_convened:${meetingId}`;
  await emitLifecycleEvent(tx, { eventType: "meeting_not_convened", subjectId: meetingId, correlation: NO_CORRELATION, producer: PRODUCER, actor: "system", idempotencyKey: eventKey, payload: { meetingId, reason } });
  return { eventKey };
}

export async function createCalendarEntry(tx: DrizzleTransaction, body: Body, actor: string): Promise<{ id: string; eventKey: string }> {
  const bad = (m: string) => new WorkplaceError("invalid_calendar_entry", m, 400);
  const extra = Object.keys(body).filter((k) => !["agentName", "kind", "title", "startsAt", "endsAt"].includes(k));
  if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(", ")}`);
  if (!(CALENDAR_KINDS as readonly unknown[]).includes(body.kind)) throw bad(`kind must be one of ${CALENDAR_KINDS.join(", ")}`);
  if (typeof body.title !== "string" || body.title.trim() === "" || body.title.length > WORKPLACE_LIMITS.titleChars) throw bad(`title must be 1-${WORKPLACE_LIMITS.titleChars} characters`);
  const agentName = body.agentName ?? null;
  if (agentName !== null && (typeof agentName !== "string" || !(await agentExists(tx, agentName)))) throw new WorkplaceError("unknown_participant", "agentName must name an existing agent, or be null for the whole workplace", 400);
  const startsAt = new Date(String(body.startsAt));
  const endsAt = body.kind === "deadline" && body.endsAt === undefined ? startsAt : new Date(String(body.endsAt));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw bad("startsAt and endsAt must be ISO instants");
  if (body.kind === "deadline" ? endsAt < startsAt : endsAt <= startsAt) throw bad("the entry must end after it starts");
  if (endsAt.getTime() - startsAt.getTime() > 31 * 86_400_000) throw bad("an entry lasts at most 31 days");
  const [row] = await tx.insert(workplaceCalendarEvents).values({ agentName: agentName as string | null, kind: body.kind as string, title: (body.title as string).trim(), startsAt, endsAt, createdBy: actor }).returning();
  const eventKey = `workplace_calendar_entry_created:${row!.id}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_calendar_entry_created", subjectId: row!.id, correlation: NO_CORRELATION, producer: PRODUCER, actor, idempotencyKey: eventKey, payload: { entryId: row!.id, agentName, kind: row!.kind, title: row!.title, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
  return { id: row!.id, eventKey };
}

export async function cancelCalendarEntry(tx: DrizzleTransaction, id: string, actor: string, now = new Date()): Promise<{ eventKey: string }> {
  const row = await tx.query.workplaceCalendarEvents.findFirst({ where: eq(workplaceCalendarEvents.id, id) });
  if (!row) throw new WorkplaceError("invalid_calendar_entry", "no such calendar entry", 404);
  if (row.cancelledAt) throw new WorkplaceError("invalid_calendar_entry", "already cancelled");
  await tx.update(workplaceCalendarEvents).set({ cancelledAt: now }).where(eq(workplaceCalendarEvents.id, id));
  const eventKey = `workplace_calendar_entry_cancelled:${id}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_calendar_entry_cancelled", subjectId: id, correlation: NO_CORRELATION, producer: PRODUCER, actor, idempotencyKey: eventKey, payload: { entryId: id } });
  return { eventKey };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type MeetingView = {
  id: string;
  title: string;
  agenda: string;
  organiser: string;
  room: { id: string; name: string; purpose: string; capacity: number; locationAreaName: string | null };
  startsAt: string;
  endsAt: string;
  status: MeetingStatus;
  cancelledAt: string | null;
  cancelReason: string | null;
  participants: { agentName: string; role: string }[];
  notes: WorkplaceEntry[];
  decisions: WorkplaceEntry[];
  actions: (WorkplaceEntry & { goalId: string })[];
  goalId: string | null;
  runId: string | null;
  /** Whether the Keep actually HELD it: the round-table Goal and when, or why it could not be held. */
  convenedGoalId: string | null;
  convenedAt: string | null;
  notConvenedReason: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export async function listMeetings(tx: DrizzleTransaction, filter: { from: Date; to: Date; agentName?: string; roomId?: string; includeCancelled?: boolean; ids?: string[] }, now = new Date()): Promise<MeetingView[]> {
  const gather = (await readSettings(tx)).gatherMinutes;
  const conds = [lt(workplaceMeetings.startsAt, filter.to), gt(workplaceMeetings.endsAt, filter.from)];
  if (!filter.includeCancelled) conds.push(isNull(workplaceMeetings.cancelledAt));
  if (filter.roomId) conds.push(eq(workplaceMeetings.roomId, filter.roomId));
  if (filter.ids) conds.push(inArray(workplaceMeetings.id, filter.ids.length ? filter.ids : ["00000000-0000-0000-0000-000000000000"]));
  let rows = await tx.select().from(workplaceMeetings).where(and(...conds)).orderBy(asc(workplaceMeetings.startsAt)).limit(500);
  const ids = rows.map((r) => r.id);
  const parts = ids.length ? await tx.select().from(workplaceMeetingParticipants).where(inArray(workplaceMeetingParticipants.meetingId, ids)) : [];
  if (filter.agentName) rows = rows.filter((r) => parts.some((p) => p.meetingId === r.id && p.agentName === filter.agentName));
  const rooms = await listRooms(tx);
  return rows.map((m) => viewOf(m, rooms.find((r) => r.id === m.roomId)!, parts.filter((p) => p.meetingId === m.id), now, gather));
}

export async function getMeeting(tx: DrizzleTransaction, id: string, now = new Date()): Promise<MeetingView | null> {
  const m = await tx.query.workplaceMeetings.findFirst({ where: eq(workplaceMeetings.id, id) });
  if (!m) return null;
  const room = (await tx.query.workplaceRooms.findFirst({ where: eq(workplaceRooms.id, m.roomId) }))!;
  const parts = await tx.select().from(workplaceMeetingParticipants).where(eq(workplaceMeetingParticipants.meetingId, id));
  return viewOf(m, room, parts, now, (await readSettings(tx)).gatherMinutes);
}

function viewOf(m: MeetingRow, room: RoomRow, parts: { agentName: string; role: string }[], now: Date, gatherMinutes: number): MeetingView {
  return {
    id: m.id,
    title: m.title,
    agenda: m.agenda,
    organiser: m.organiser,
    room: { id: room.id, name: room.name, purpose: room.purpose, capacity: room.capacity, locationAreaName: room.locationAreaName },
    startsAt: m.startsAt.toISOString(),
    endsAt: m.endsAt.toISOString(),
    status: meetingStatus(m, now, gatherMinutes),
    cancelledAt: m.cancelledAt?.toISOString() ?? null,
    cancelReason: m.cancelReason,
    participants: parts.map((p) => ({ agentName: p.agentName, role: p.role })).sort((a, b) => a.agentName.localeCompare(b.agentName)),
    notes: m.notes,
    decisions: m.decisions,
    actions: m.actions,
    goalId: m.goalId,
    runId: m.runId,
    convenedGoalId: m.convenedGoalId,
    convenedAt: m.convenedAt?.toISOString() ?? null,
    notConvenedReason: m.notConvenedReason,
    revision: m.revision,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export async function listCalendarEntries(tx: DrizzleTransaction, filter: { from: Date; to: Date; agentName?: string }) {
  const conds = [isNull(workplaceCalendarEvents.cancelledAt), lte(workplaceCalendarEvents.startsAt, filter.to), or(gt(workplaceCalendarEvents.endsAt, filter.from), eq(workplaceCalendarEvents.startsAt, workplaceCalendarEvents.endsAt))!];
  if (filter.agentName) conds.push(or(eq(workplaceCalendarEvents.agentName, filter.agentName), isNull(workplaceCalendarEvents.agentName))!);
  const rows = await tx.select().from(workplaceCalendarEvents).where(and(...conds)).orderBy(asc(workplaceCalendarEvents.startsAt)).limit(500);
  return rows.map((r) => ({ id: r.id, agentName: r.agentName, kind: r.kind, title: r.title, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), createdBy: r.createdBy }));
}

/**
 * Who is gathering for or sitting in a meeting right now, for the world. Trusts only what the event log
 * recorded: a meeting counts only while its row matches the latest `meeting_scheduled` /
 * `meeting_rescheduled` event for its current revision and no `meeting_cancelled` event exists. A row
 * written or altered without its event draws nobody anywhere.
 */
export type Presence = { agentName: string; meetingId: string; title: string; roomName: string; locationAreaName: string | null; phase: "gathering" | "in_meeting"; startsAt: string; endsAt: string };
export async function meetingPresence(tx: DrizzleTransaction, now = new Date()): Promise<Presence[]> {
  const settings = await readSettings(tx);
  const soon = new Date(now.getTime() + settings.gatherMinutes * 60_000);
  const views = await listMeetings(tx, { from: now, to: new Date(soon.getTime() + 1) }, now);
  const current = views.filter((v) => new Date(v.startsAt) <= soon && new Date(v.endsAt) > now);
  if (current.length === 0) return [];
  const recorded = await tx
    .select({ type: events.eventType, subject: sql<string>`${events.payload}->>'meetingId'`, payload: events.payload })
    .from(events)
    .where(and(inArray(events.eventType, ["meeting_scheduled", "meeting_rescheduled", "meeting_cancelled"]), inArray(sql`${events.payload}->>'meetingId'`, current.map((v) => v.id))))
    .orderBy(desc(events.globalSeq));
  const out: Presence[] = [];
  for (const v of current) {
    const mine = recorded.filter((r) => r.subject === v.id);
    if (mine.some((r) => r.type === "meeting_cancelled")) continue;
    const latest = mine.find((r) => r.type !== "meeting_cancelled")?.payload as Record<string, unknown> | undefined;
    const participants = v.participants.map((p) => p.agentName).sort();
    const matches =
      latest &&
      latest.revision === v.revision &&
      latest.startsAt === v.startsAt &&
      latest.endsAt === v.endsAt &&
      latest.roomId === v.room.id &&
      JSON.stringify(latest.participants) === JSON.stringify(participants);
    if (!matches) continue;
    for (const p of participants) {
      out.push({ agentName: p, meetingId: v.id, title: v.title, roomName: v.room.name, locationAreaName: v.room.locationAreaName, phase: v.status === "in_progress" ? ("in_meeting" as const) : ("gathering" as const), startsAt: v.startsAt, endsAt: v.endsAt });
    }
  }
  // One place per agent: the meeting it is in beats the next one it would gather for (back-to-back meetings).
  const rank = (x: Presence) => (x.phase === "in_meeting" ? 0 : 1);
  const chosen = new Map<string, Presence>();
  for (const x of out.sort((a, b) => rank(a) - rank(b) || a.startsAt.localeCompare(b.startsAt))) if (!chosen.has(x.agentName)) chosen.set(x.agentName, x);
  return [...chosen.values()].sort((a, b) => a.agentName.localeCompare(b.agentName));
}

/** One agent's day in the workplace timezone: its meetings and calendar entries today, where it is now, and its next meeting. */
export async function agentSchedule(tx: DrizzleTransaction, agentName: string, now = new Date()) {
  const settings = await readSettings(tx);
  const today = wallClock(now, settings.timezone);
  const from = fromWallClock({ year: today.year, month: today.month, day: today.day, hour: 0, minute: 0 }, settings.timezone);
  const to = fromWallClock({ ...addDays(today, 1), hour: 0, minute: 0 }, settings.timezone);
  const meetings = await listMeetings(tx, { from, to, agentName, includeCancelled: true }, now);
  const upcoming = await listMeetings(tx, { from: now, to: new Date(now.getTime() + 14 * 86_400_000), agentName }, now);
  return {
    now: now.toISOString(),
    timezone: settings.timezone,
    day: { from: from.toISOString(), to: to.toISOString() },
    current: (await meetingPresence(tx, now)).find((p) => p.agentName === agentName) ?? null,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, status: m.status, roomName: m.room.name })),
    entries: await listCalendarEntries(tx, { from, to, agentName }),
    next: upcoming.find((m) => notBegun(m.status)) ? (({ id, title, startsAt, endsAt, room }) => ({ id, title, startsAt, endsAt, roomName: room.name }))(upcoming.find((m) => notBegun(m.status))!) : null,
  };
}

/** The meeting an agent is in right now (verified as `meetingPresence`), if any. */
/**
 * The meeting this agent is sitting in right now, if any. `ignoreMeetingId` excludes one meeting from the
 * answer — used when convening that very meeting, where being in it is the point rather than a clash.
 */
export async function inMeetingNow(tx: DrizzleTransaction, agentName: string, now = new Date(), ignoreMeetingId?: string) {
  return (await meetingPresence(tx, now)).find((p) => p.agentName === agentName && p.phase === "in_meeting" && p.meetingId !== ignoreMeetingId) ?? null;
}

export async function listNotifications(tx: DrizzleTransaction, filter: { recipient?: string; limit?: number }, now = new Date()) {
  const conds = [lte(workplaceNotifications.deliverAt, now), isNull(workplaceNotifications.withdrawnAt)];
  if (filter.recipient) conds.push(eq(workplaceNotifications.recipient, filter.recipient));
  const rows = await tx.select().from(workplaceNotifications).where(and(...conds)).orderBy(desc(workplaceNotifications.deliverAt)).limit(Math.min(filter.limit ?? 100, 200));
  return rows.map((r) => ({ id: r.id, recipient: r.recipient, kind: r.kind, title: r.title, body: r.body, sender: r.sender, meetingId: r.meetingId, goalId: r.goalId, channel: r.channel, deliverAt: r.deliverAt.toISOString(), readAt: r.readAt?.toISOString() ?? null }));
}

/** An operator message to named agents, or an announcement to all of them. Internal records only; no chat, no model. */
export async function sendMessage(tx: DrizzleTransaction, body: Body, actor: string): Promise<{ count: number; eventKey: string }> {
  const bad = (m: string) => new WorkplaceError("invalid_message", m, 400);
  const extra = Object.keys(body).filter((k) => !["kind", "recipients", "title", "body"].includes(k));
  if (extra.length > 0) throw bad(`unknown field(s): ${extra.join(", ")}`);
  if (body.kind !== "message" && body.kind !== "announcement") throw bad('kind must be "message" or "announcement"');
  if (typeof body.title !== "string" || body.title.trim() === "" || body.title.length > WORKPLACE_LIMITS.titleChars) throw bad(`title must be 1-${WORKPLACE_LIMITS.titleChars} characters`);
  if (body.body !== undefined && (typeof body.body !== "string" || body.body.length > WORKPLACE_LIMITS.entryChars)) throw bad(`body is at most ${WORKPLACE_LIMITS.entryChars} characters`);
  const all = await agentNames(tx);
  let recipients: string[];
  if (body.kind === "announcement") {
    if (body.recipients !== undefined) throw bad("an announcement goes to every agent; give no recipients");
    if (!(await readSettings(tx)).notifyAnnouncements) throw new WorkplaceError("invalid_message", "announcements are turned off in Settings");
    recipients = all;
  } else {
    if (!Array.isArray(body.recipients) || body.recipients.length === 0 || body.recipients.length > WORKPLACE_LIMITS.maxParticipants || !body.recipients.every((r) => typeof r === "string" && all.includes(r))) throw bad("recipients must name existing agents");
    recipients = [...new Set(body.recipients as string[])];
  }
  const batch = randomUUID();
  await notify(tx, recipients.map((r) => ({ recipient: `agent:${r}`, kind: body.kind as "message" | "announcement", title: (body.title as string).trim(), body: ((body.body as string | undefined) ?? "").trim(), sender: actor, idempotencyKey: `${body.kind}:${batch}:${r}` })));
  const eventKey = `workplace_message_sent:${batch}`;
  await emitLifecycleEvent(tx, { eventType: "workplace_message_sent", subjectId: batch, correlation: NO_CORRELATION, producer: PRODUCER, actor, idempotencyKey: eventKey, payload: { kind: body.kind, recipients, title: (body.title as string).trim() } });
  return { count: recipients.length, eventKey };
}

/** A work assignment notice, written beside the delegation that assigned the work. */
export async function notifyWorkAssigned(tx: DrizzleTransaction, input: { agentNames: string[]; goalId: string; title: string; sender: string; workflowRunId: string }) {
  await notify(tx, input.agentNames.map((a) => ({ recipient: `agent:${a}`, kind: "work_assigned" as const, title: `Assigned: ${input.title.slice(0, 100)}`, sender: input.sender, goalId: input.goalId, idempotencyKey: `work_assigned:${input.workflowRunId}:${a}` })));
}

export async function markNotificationRead(tx: DrizzleTransaction, id: string, now = new Date()): Promise<void> {
  const row = await tx.query.workplaceNotifications.findFirst({ where: eq(workplaceNotifications.id, id) });
  if (!row) throw new WorkplaceError("invalid_message", "no such notification", 404);
  if (!row.readAt) await tx.update(workplaceNotifications).set({ readAt: now }).where(eq(workplaceNotifications.id, id));
}

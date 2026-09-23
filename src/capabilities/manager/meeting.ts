/**
 * Meetings as a Manager mission (workplace). The Manager's model only interprets the objective into a
 * bounded meeting REQUEST (what, who, how long, roughly when, which room); code does everything else:
 * resolves participants against the Registry, finds the earliest time everyone is available and a room
 * that fits (`../../workplace/workplace.ts`), refuses duplicates and stale references, and writes a
 * record. The governed `workplace.schedule_meeting` invocation then names that record, and the next
 * deterministic position re-validates it against the database as it is NOW and applies it.
 * The model never does date arithmetic, conflict detection or room selection.
 */
import { eq } from "drizzle-orm";
import { agentDefinitions, runs, taskInstances, workflowRuns } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import {
  TIMING_WINDOWS,
  WorkplaceError,
  agentNames,
  cancelMeeting,
  getMeeting,
  listMeetings,
  listRooms,
  proposeMeeting,
  readSettings,
  rescheduleMeeting,
  scheduleMeeting,
  timingWindow,
  upcomingMeetingTitled,
  type Provenance,
  type TimingWindow,
} from "../../workplace/workplace.js";
import { formatWall } from "../../workplace/zonedTime.js";
import { latestAgents } from "./mission.js";
import { MEETING_ACTIONS, type MeetingAction } from "../workplace/capability.js";
import type { Blocker, MissionReason } from "./capability.js";

/** Plan-level meeting request. Always present; `needed: false` for ordinary delegation. */
export const MEETING_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    needed: { type: "boolean" },
    action: { type: "string", enum: ["none", ...MEETING_ACTIONS] },
    meetingId: { type: "string" },
    title: { type: "string" },
    agenda: { type: "string" },
    everyone: { type: "boolean" },
    participants: { type: "array", items: { type: "string" } },
    /** A word from the agents' own role or objective ("research", "review"): code resolves who that is. */
    roleLike: { type: "string" },
    /** Everyone who has worked on this Goal (its id from the calendar or the mission): resolved by code. */
    goalId: { type: "string" },
    durationMinutes: { type: "integer" },
    timing: { type: "string", enum: [...TIMING_WINDOWS] },
    at: { type: "string" },
    roomName: { type: "string" },
  },
  required: ["needed", "action", "meetingId", "title", "agenda", "everyone", "participants", "roleLike", "goalId", "durationMinutes", "timing", "at", "roomName"],
  additionalProperties: false,
} as const;

/** Objectives that are about the calendar. Decides only whether the Manager is shown the calendar; code validates any request. */
const MEETING_OBJECTIVE = /\b(meet(ing|ings|up)?|calendar|schedul\w*|reschedul\w*|availab\w*|free|book|room|appointment|cancel|postpone|move .*(meeting|call)|get .* together|gather|huddle|stand-?up|sync)\b/i;
export function asksForMeeting(objective: string): boolean {
  return MEETING_OBJECTIVE.test(objective);
}

export type MeetingRecord = {
  action: MeetingAction;
  meetingId: string | null;
  title: string;
  agenda: string;
  participants: string[];
  startsAt: string | null;
  endsAt: string | null;
  roomId: string | null;
  roomName: string | null;
  previous: { startsAt: string; endsAt: string; roomName: string } | null;
};

const WORKPLACE_TO_MISSION: Record<string, MissionReason> = {
  invalid_meeting: "invalid_meeting",
  unknown_participant: "unknown_participant",
  participant_unavailable: "participant_unavailable",
  participant_conflict: "participant_conflict",
  outside_working_hours: "outside_working_hours",
  room_not_found: "room_not_found",
  room_inactive: "room_inactive",
  insufficient_room_capacity: "insufficient_room_capacity",
  room_conflict: "room_conflict",
  no_common_availability: "no_common_availability",
  meeting_not_found: "meeting_not_found",
  meeting_not_changeable: "meeting_not_changeable",
};
export const missionCodeOf = (e: WorkplaceError): MissionReason => WORKPLACE_TO_MISSION[e.code] ?? "validation_rejected";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Who the meeting is for, resolved by CODE from the Registry and the runtime — never by the model's idea of
 * who exists. The request may say `everyone`, name agents exactly, give a word from their own role or
 * objective ("research", "review"), or give a Goal whose workers should meet; the sets are combined and
 * only names the Registry holds survive. An icon never selects anyone: what an agent is pictured as says
 * nothing about what it may do.
 */
async function resolveParticipants(tx: DrizzleTransaction, r: Record<string, unknown>): Promise<{ names: string[]; unknown: string[] }> {
  const all = await agentNames(tx);
  if (r.everyone === true) return { names: all, unknown: [] };
  const chosen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of Array.isArray(r.participants) ? r.participants : []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const match = all.find((a) => a.toLowerCase() === raw.trim().toLowerCase());
    // A name the Registry does not hold is refused, never quietly dropped.
    if (match) chosen.add(match);
    else unknown.push(raw.trim().slice(0, 60));
  }
  const roleLike = typeof r.roleLike === "string" ? r.roleLike.trim().slice(0, 40).toLowerCase() : "";
  if (roleLike.length >= 3) {
    for (const a of await latestAgents(tx)) {
      if (`${a.name} ${a.role} ${a.objective}`.toLowerCase().includes(roleLike)) chosen.add(a.name);
    }
  }
  const goalId = typeof r.goalId === "string" ? r.goalId.trim() : "";
  if (/^[0-9a-f-]{36}$/i.test(goalId)) {
    const rows = await tx
      .selectDistinct({ name: agentDefinitions.name })
      .from(runs)
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
      .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
      .where(eq(workflowRuns.goalId, goalId));
    for (const row of rows) chosen.add(row.name);
  }
  return { names: [...chosen].sort(), unknown };
}

/** Validates the model's meeting request against the records; returns the code-decided meeting or the real blockers. */
export async function validateMeetingRequest(
  tx: DrizzleTransaction,
  request: unknown,
  opts: { managerName: string; now: Date }
): Promise<{ ok: true; meeting: MeetingRecord } | { ok: false; errors: string[]; blockers: Blocker[] }> {
  const refuse = (code: MissionReason, detail: string) => ({ ok: false as const, errors: [detail], blockers: [{ code, detail }] });
  const r = (request && typeof request === "object" && !Array.isArray(request) ? request : {}) as Record<string, unknown>;
  const action = r.action as MeetingAction;
  if (!(MEETING_ACTIONS as readonly unknown[]).includes(action)) return refuse("validation_rejected", `the meeting request's action must be one of ${MEETING_ACTIONS.join(", ")}.`);
  const settings = await readSettings(tx);
  try {
    if (action === "schedule") {
      const title = text(r.title, 120);
      if (!title) return refuse("invalid_meeting", "a meeting needs a title.");
      const resolved = await resolveParticipants(tx, r);
      if (resolved.unknown.length > 0) return refuse("unknown_participant", `no agent named ${resolved.unknown.map((u) => `"${u}"`).join(", ")}; the Manager can only invite agents that exist.`);
      const participants = resolved.names;
      if (participants.length === 0) return refuse("invalid_meeting", "the request names no participants the Registry knows.");
      const duration = typeof r.durationMinutes === "number" && r.durationMinutes > 0 ? Math.round(r.durationMinutes) : settings.defaultMeetingMinutes;
      const timing = (TIMING_WINDOWS as readonly unknown[]).includes(r.timing) ? (r.timing as TimingWindow) : "asap";
      const window = timingWindow(settings, { window: timing, ...(typeof r.at === "string" && r.at ? { at: r.at } : {}) }, opts.now, duration);
      if (!window) return refuse("invalid_meeting", 'a meeting "at" a time needs a local time "YYYY-MM-DDTHH:MM".');
      const duplicate = await upcomingMeetingTitled(tx, title, opts.now);
      if (duplicate) return refuse("duplicate_meeting", `"${title}" is already scheduled (meeting ${duplicate.id}); move or cancel it instead of creating a second one.`);
      const roomName = text(r.roomName, 60) || null;
      const p = await proposeMeeting(tx, { participants, durationMinutes: duration, window, now: opts.now, roomName });
      return { ok: true, meeting: { action, meetingId: null, title, agenda: text(r.agenda, 2_000), participants, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), roomId: p.roomId, roomName: p.roomName, previous: null } };
    }

    const meetingId = text(r.meetingId, 64);
    const existing = /^[0-9a-f-]{36}$/i.test(meetingId) ? await getMeeting(tx, meetingId, opts.now) : null;
    if (!existing) return refuse("meeting_not_found", `no meeting has the id "${meetingId.slice(0, 40)}"; the Manager can only change a meeting from the calendar.`);
    if (existing.status !== "scheduled" && existing.status !== "starting") return refuse("meeting_not_changeable", `"${existing.title}" is ${existing.status.replace("_", " ")}; only a meeting that has not started can be ${action === "cancel" ? "cancelled" : "moved"}.`);
    const previous = { startsAt: existing.startsAt, endsAt: existing.endsAt, roomName: existing.room.name };
    const base = { action, meetingId: existing.id, title: existing.title, agenda: existing.agenda, participants: existing.participants.map((p) => p.agentName), previous };
    if (action === "cancel") return { ok: true, meeting: { ...base, startsAt: null, endsAt: null, roomId: null, roomName: null } };

    const currentMinutes = Math.round((Date.parse(existing.endsAt) - Date.parse(existing.startsAt)) / 60_000);
    const duration = typeof r.durationMinutes === "number" && r.durationMinutes > 0 ? Math.round(r.durationMinutes) : currentMinutes;
    const timing = (TIMING_WINDOWS as readonly unknown[]).includes(r.timing) ? (r.timing as TimingWindow) : "asap";
    const window = timingWindow(settings, { window: timing, ...(typeof r.at === "string" && r.at ? { at: r.at } : {}) }, opts.now, duration);
    if (!window) return refuse("invalid_meeting", 'a meeting "at" a time needs a local time "YYYY-MM-DDTHH:MM".');
    const p = await proposeMeeting(tx, { participants: base.participants, durationMinutes: duration, window, now: opts.now, roomName: text(r.roomName, 60) || null, ignoreMeetingId: existing.id });
    if (p.startsAt.toISOString() === existing.startsAt && p.endsAt.toISOString() === existing.endsAt && p.roomId === existing.room.id) {
      return refuse("meeting_not_changeable", `the earliest valid time in that window is where "${existing.title}" already is.`);
    }
    return { ok: true, meeting: { ...base, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), roomId: p.roomId, roomName: p.roomName } };
  } catch (error) {
    if (error instanceof WorkplaceError) return refuse(missionCodeOf(error), error.message);
    throw error;
  }
}

/**
 * Applies a validated meeting record: the workplace write re-checks every rule inside its locks, so a
 * record that went stale since planning (someone booked the room, an agent was stopped) fails with its
 * real reason and writes nothing.
 */
export async function applyMeetingRecord(tx: DrizzleTransaction, meeting: MeetingRecord, provenance: Provenance, now: Date): Promise<{ meetingId: string }> {
  try {
    if (meeting.action === "schedule") {
      return await scheduleMeeting(tx, { title: meeting.title, agenda: meeting.agenda, participants: meeting.participants, startsAt: new Date(meeting.startsAt!), endsAt: new Date(meeting.endsAt!), roomId: meeting.roomId! }, provenance, now);
    }
    if (meeting.action === "reschedule") {
      return await rescheduleMeeting(tx, { meetingId: meeting.meetingId!, startsAt: new Date(meeting.startsAt!), endsAt: new Date(meeting.endsAt!), roomId: meeting.roomId! }, provenance, now);
    }
    return await cancelMeeting(tx, { meetingId: meeting.meetingId!, reason: "cancelled by the Manager at the operator's request" }, provenance, now);
  } catch (error) {
    if (error instanceof WorkplaceError) throw new Error(`manager: ${missionCodeOf(error)}: the meeting no longer validates: ${error.message}`);
    throw error;
  }
}

/** The compact calendar the Manager plans from (`workplace.inspect_calendar`): no histories, no notes, at most 20 meetings. */
export async function calendarView(tx: DrizzleTransaction, now: Date) {
  const settings = await readSettings(tx);
  const tz = settings.timezone;
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const meetings = (await listMeetings(tx, { from: now, to: new Date(now.getTime() + 7 * 86_400_000) }, now)).slice(0, 20);
  return {
    now: formatWall(now, tz),
    timezone: tz,
    workingHours: `${hm(settings.workStartMinute)}-${hm(settings.workEndMinute)} on ISO weekdays ${settings.workingDays.join(",")}`,
    outsideWorkingHours: settings.outsideWorkingHours,
    defaultMeetingMinutes: settings.defaultMeetingMinutes,
    rooms: (await listRooms(tx)).filter((r) => r.active).map((r) => ({ name: r.name, purpose: r.purpose, capacity: r.capacity })),
    meetings: meetings.map((m) => ({
      id: m.id,
      title: m.title,
      when: `${formatWall(new Date(m.startsAt), tz)}-${formatWall(new Date(m.endsAt), tz).slice(11)}`,
      room: m.room.name,
      status: m.status,
      participants: m.participants.length <= 8 ? m.participants.map((p) => p.agentName) : `${m.participants.length} agents`,
    })),
  };
}

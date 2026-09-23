/**
 * The internal workplace (calendar, meetings, rooms, notifications) for the operator.
 *
 *   GET  /workplace/settings                        — settings, rooms, per-agent hours and the allowed values
 *   POST /workplace/settings                        — change workplace settings (timezone, hours, meeting and notification defaults)
 *   POST /workplace/agent-hours/:name               — an agent's own working hours (null fields use the workplace's)
 *   POST /workplace/rooms, /workplace/rooms/:id     — create or change a room (deactivate, never delete)
 *   GET  /workplace/calendar?from&to&agent&room     — meetings and calendar entries overlapping [from, to), with the clock
 *   GET  /workplace/meetings/:id                    — one meeting, cancelled or not
 *   POST /workplace/meetings                        — schedule: exact { startsAt, endsAt, roomId } or found { durationMinutes, timing }
 *   POST /workplace/meetings/:id/reschedule         — move a meeting that has not started (exact or found)
 *   POST /workplace/meetings/:id/cancel             — cancel a meeting that has not started; kept, never deleted
 *   POST /workplace/meetings/:id/outcome            — { notes?, decisions? } once it has started
 *   POST /workplace/meetings/:id/actions            — { decision }: start a Manager mission from a recorded decision
 *   POST /workplace/availability                    — { participants, from, to }: who is available, busy or unavailable
 *   GET  /workplace/agents/:name/schedule           — an agent's day (Keep timezone): meetings, entries, where it is now, next meeting
 *   GET  /workplace/presence                        — agents gathering for or in a meeting now (event-verified)
 *   GET  /workplace/notifications?recipient         — delivered internal notifications, newest first (with the operator's pending approvals, derived)
 *   POST /workplace/notifications/:id/read
 *   POST /workplace/messages                        — { kind: message|announcement, recipients?, title, body? }
 *   POST /workplace/calendar-entries, /workplace/calendar-entries/:id/cancel
 *
 * The operator acts directly here (actor `human:operator`), as with Goals and the world. The Manager
 * never uses these routes: it acts through its governed `workplace.*` capabilities. Every rule lives in
 * `../../workplace/workplace.ts`; every write emits its event, relayed after commit. POST for writes.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "../server.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { desc, eq } from "drizzle-orm";
import { agentDefinitions, approvals, capabilities, invocations, runs } from "../../db/schema.js";
import { activeAreaNames } from "../../world/worldConfig.js";
import { isUuid } from "../requestGuards.js";
import { relayCommittedEvent } from "../liveEventRelay.js";
import { startMission } from "./manager.js";
import {
  CALENDAR_KINDS,
  NOTIFICATION_KINDS,
  ROOM_PURPOSES,
  TIMING_WINDOWS,
  WorkplaceError,
  agentSchedule,
  availabilityFor,
  cancelCalendarEntry,
  cancelMeeting,
  createCalendarEntry,
  createRoom,
  getMeeting,
  listAgentHours,
  listCalendarEntries,
  listMeetings,
  listNotifications,
  listRooms,
  roomsOffTheMap,
  markNotificationRead,
  meetingPresence,
  proposeMeeting,
  readSettings,
  recordMeetingAction,
  recordMeetingOutcome,
  rescheduleMeeting,
  scheduleMeeting,
  sendMessage,
  timingWindow,
  updateAgentHours,
  updateRoom,
  updateSettings,
  type TimingWindow,
} from "../../workplace/workplace.js";

const OPERATOR = "human:operator";
type Body = Record<string, unknown>;

async function guarded(reply: FastifyReply, deps: ApiDeps, work: (tx: DrizzleTransaction) => Promise<{ eventKey?: string; eventKeys?: string[] } & Record<string, unknown>>, status = 200) {
  try {
    const result = await deps.db.transaction((tx) => work(tx as unknown as DrizzleTransaction));
    for (const key of [...(result.eventKey ? [result.eventKey] : []), ...(result.eventKeys ?? [])]) await relayCommittedEvent(deps.db, key);
    const { eventKey: _k, eventKeys: _ks, ...rest } = result;
    return reply.status(status).send(rest);
  } catch (error) {
    if (error instanceof WorkplaceError) return reply.status(error.status).send({ error: error.message, code: error.code });
    throw error;
  }
}

const objectBody = (body: unknown): Body | null => (body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null);
const instant = (v: unknown) => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** Exact times, or the earliest valid slot for a duration and timing window. Returns start, end and room. */
async function slotFrom(tx: DrizzleTransaction, body: Body, participants: string[], now: Date, ignoreMeetingId?: string) {
  if (body.startsAt !== undefined || body.endsAt !== undefined || body.roomId !== undefined) {
    const startsAt = instant(body.startsAt);
    const endsAt = instant(body.endsAt);
    if (!startsAt || !endsAt || typeof body.roomId !== "string" || !isUuid(body.roomId)) throw new WorkplaceError("invalid_meeting", "give startsAt and endsAt (ISO instants) and roomId, or durationMinutes and timing", 400);
    return { startsAt, endsAt, roomId: body.roomId };
  }
  const settings = await readSettings(tx);
  const duration = body.durationMinutes ?? settings.defaultMeetingMinutes;
  const timing = objectBody(body.timing) ?? { window: "asap" };
  if (!(TIMING_WINDOWS as readonly unknown[]).includes(timing.window)) throw new WorkplaceError("invalid_meeting", `timing.window must be one of ${TIMING_WINDOWS.join(", ")}`, 400);
  const window = timingWindow(settings, { window: timing.window as TimingWindow, ...(typeof timing.at === "string" ? { at: timing.at } : {}) }, now, Number(duration));
  if (!window) throw new WorkplaceError("invalid_meeting", 'timing.at must be a local time "YYYY-MM-DDTHH:MM"', 400);
  const p = await proposeMeeting(tx, { participants, durationMinutes: Number(duration), window, now, roomName: typeof body.roomName === "string" ? body.roomName : null, ...(ignoreMeetingId ? { ignoreMeetingId } : {}) });
  return { startsAt: p.startsAt, endsAt: p.endsAt, roomId: p.roomId };
}

export function registerWorkplaceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const read = <T>(work: (tx: DrizzleTransaction) => Promise<T>) => deps.db.transaction((tx) => work(tx as unknown as DrizzleTransaction), { isolationLevel: "repeatable read", accessMode: "read only" });

  app.get("/workplace/settings", async (_request, reply) => {
    const data = await read(async (tx) => {
      const rooms = await listRooms(tx);
      const areas = await activeAreaNames(tx);
      return {
        settings: await readSettings(tx),
        // A room whose area this world does not have is named plainly, never quietly dropped.
        rooms: rooms.map((r) => ({ ...r, onTheMap: r.locationAreaName !== null && areas.includes(r.locationAreaName) })),
        offTheMap: roomsOffTheMap(rooms, areas).map((r) => r.name),
        areas,
        agentHours: await listAgentHours(tx),
      };
    });
    return reply.send({ ...data, allowed: { roomPurposes: ROOM_PURPOSES, calendarKinds: CALENDAR_KINDS, notificationKinds: NOTIFICATION_KINDS, timingWindows: TIMING_WINDOWS } });
  });

  app.post("/workplace/settings", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    return guarded(reply, deps, (tx) => updateSettings(tx, body, OPERATOR));
  });

  app.post<{ Params: { name: string } }>("/workplace/agent-hours/:name", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    return guarded(reply, deps, (tx) => updateAgentHours(tx, request.params.name, body, OPERATOR));
  });

  app.post("/workplace/rooms", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    return guarded(reply, deps, (tx) => createRoom(tx, body, OPERATOR), 201);
  });

  app.post<{ Params: { id: string } }>("/workplace/rooms/:id", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body || !isUuid(request.params.id)) return reply.status(400).send({ error: "A JSON object body and a room UUID are required." });
    return guarded(reply, deps, (tx) => updateRoom(tx, request.params.id, body, OPERATOR));
  });

  app.get<{ Querystring: { from?: string; to?: string; agent?: string; room?: string } }>("/workplace/calendar", async (request, reply) => {
    const from = instant(request.query.from);
    const to = instant(request.query.to);
    if (!from || !to || to <= from || to.getTime() - from.getTime() > 62 * 86_400_000) return reply.status(400).send({ error: "from and to are ISO instants, at most 62 days apart" });
    if (request.query.room && !isUuid(request.query.room)) return reply.status(400).send({ error: "room must be a UUID" });
    const now = new Date();
    const data = await read(async (tx) => ({
      now: now.toISOString(),
      settings: await readSettings(tx),
      rooms: await listRooms(tx),
      meetings: await listMeetings(tx, { from, to, includeCancelled: true, ...(request.query.agent ? { agentName: request.query.agent } : {}), ...(request.query.room ? { roomId: request.query.room } : {}) }, now),
      entries: await listCalendarEntries(tx, { from, to, ...(request.query.agent ? { agentName: request.query.agent } : {}) }),
    }));
    return reply.send(data);
  });

  app.get<{ Params: { id: string } }>("/workplace/meetings/:id", async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: "id must be a UUID" });
    const data = await read(async (tx) => ({ meeting: await getMeeting(tx, request.params.id), settings: await readSettings(tx) }));
    if (!data.meeting) return reply.status(404).send({ error: "No such meeting" });
    return reply.send(data);
  });

  app.post("/workplace/meetings", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    const extra = Object.keys(body).filter((k) => !["title", "agenda", "participants", "startsAt", "endsAt", "roomId", "durationMinutes", "timing", "roomName"].includes(k));
    if (extra.length > 0) return reply.status(400).send({ error: `unknown field(s): ${extra.join(", ")}` });
    const now = new Date();
    return guarded(
      reply,
      deps,
      async (tx) => {
        const participants = body.participants as string[];
        const slot = await slotFrom(tx, body, participants, now);
        const done = await scheduleMeeting(tx, { title: body.title as string, agenda: body.agenda as string, participants, ...slot }, { actor: OPERATOR }, now);
        return { ...done, meeting: await getMeeting(tx, done.meetingId, now) };
      },
      201
    );
  });

  app.post<{ Params: { id: string } }>("/workplace/meetings/:id/reschedule", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body || !isUuid(request.params.id)) return reply.status(400).send({ error: "A JSON object body and a meeting UUID are required." });
    const now = new Date();
    return guarded(reply, deps, async (tx) => {
      const current = await getMeeting(tx, request.params.id, now);
      if (!current) throw new WorkplaceError("meeting_not_found", "no such meeting", 404);
      const slot = await slotFrom(tx, { durationMinutes: Math.round((Date.parse(current.endsAt) - Date.parse(current.startsAt)) / 60_000), ...body }, current.participants.map((p) => p.agentName), now, current.id);
      const done = await rescheduleMeeting(tx, { meetingId: current.id, ...slot }, { actor: OPERATOR }, now);
      return { ...done, meeting: await getMeeting(tx, done.meetingId, now) };
    });
  });

  app.post<{ Params: { id: string } }>("/workplace/meetings/:id/cancel", async (request, reply) => {
    const body = objectBody(request.body ?? {});
    if (!body || !isUuid(request.params.id)) return reply.status(400).send({ error: "A meeting UUID is required." });
    return guarded(reply, deps, (tx) => cancelMeeting(tx, { meetingId: request.params.id, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }, { actor: OPERATOR }));
  });

  app.post<{ Params: { id: string } }>("/workplace/meetings/:id/outcome", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body || !isUuid(request.params.id)) return reply.status(400).send({ error: "A JSON object body and a meeting UUID are required." });
    return guarded(reply, deps, (tx) => recordMeetingOutcome(tx, request.params.id, body, OPERATOR));
  });

  app.post<{ Params: { id: string } }>("/workplace/meetings/:id/actions", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body || !isUuid(request.params.id) || typeof body.decision !== "number") return reply.status(400).send({ error: "{ decision } (the index of a recorded decision) and a meeting UUID are required." });
    const meeting = await read((tx) => getMeeting(tx, request.params.id));
    const decision = meeting?.decisions[body.decision as number];
    if (!meeting || !decision) return reply.status(404).send({ error: "No such meeting decision" });
    if (meeting.actions.some((a) => a.text === decision.text)) return reply.status(409).send({ error: "Work was already started from this decision." });
    // The work goes through the Manager's governed mission path; this route only links it to the meeting.
    const mission = await startMission(deps, `Follow up the decision from the meeting "${meeting.title}": ${decision.text}`);
    if ("status" in mission) return reply.status(mission.status).send(mission.body);
    return guarded(reply, deps, async (tx) => ({ ...(await recordMeetingAction(tx, meeting.id, { goalId: mission.goalId, text: decision.text }, OPERATOR)), goalId: mission.goalId }), 202);
  });

  app.post("/workplace/availability", async (request, reply) => {
    const body = objectBody(request.body);
    const from = instant(body?.from);
    const to = instant(body?.to);
    if (!body || !Array.isArray(body.participants) || !body.participants.every((p) => typeof p === "string") || body.participants.length > 50 || !from || !to || to <= from || to.getTime() - from.getTime() > 14 * 86_400_000) {
      return reply.status(400).send({ error: "{ participants: names (at most 50), from, to } with to after from, at most 14 days" });
    }
    const availability = await read((tx) => availabilityFor(tx, body.participants as string[], { start: from, end: to }));
    return reply.send({ availability });
  });

  app.get<{ Params: { name: string } }>("/workplace/agents/:name/schedule", async (request, reply) => {
    const name = request.params.name;
    if (!name || name.length > 120) return reply.status(400).send({ error: "an agent name is required" });
    return reply.send(await read((tx) => agentSchedule(tx, name)));
  });

  app.get("/workplace/presence", async (_request, reply) => {
    const now = new Date();
    return reply.send({ now: now.toISOString(), presence: await read((tx) => meetingPresence(tx, now)) });
  });

  app.get<{ Querystring: { recipient?: string; limit?: string } }>("/workplace/notifications", async (request, reply) => {
    const notifications = await read((tx) => listNotifications(tx, { ...(request.query.recipient ? { recipient: request.query.recipient } : {}), limit: Number(request.query.limit ?? 100) || 100 }));
    // An approval waiting on the operator is a notice too — derived from the approval itself, never a copy
    // of it: it is resolved in Approvals, and nothing here can change it.
    const waiting =
      request.query.recipient && request.query.recipient !== "operator"
        ? []
        : (
            await read((tx) =>
              tx
                .select({ id: approvals.id, createdAt: approvals.createdAt, capability: capabilities.name, agentName: agentDefinitions.name })
                .from(approvals)
                .innerJoin(invocations, eq(invocations.id, approvals.invocationId))
                .leftJoin(capabilities, eq(capabilities.id, invocations.capabilityId))
                .innerJoin(runs, eq(runs.id, invocations.runId))
                .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
                .where(eq(approvals.status, "pending"))
                .orderBy(desc(approvals.createdAt))
                .limit(20)
            )
          ).map((a) => ({
            id: `approval:${a.id}`,
            recipient: "operator",
            kind: "approval_required",
            title: `${a.agentName ?? "An agent"} is waiting for your approval${a.capability ? ` (${a.capability})` : ""}`,
            body: "",
            sender: "governance",
            meetingId: null,
            goalId: null,
            channel: "internal",
            deliverAt: a.createdAt.toISOString(),
            readAt: null,
          }));
    return reply.send({ notifications: [...waiting, ...notifications].sort((a, b) => b.deliverAt.localeCompare(a.deliverAt)) });
  });

  app.post<{ Params: { id: string } }>("/workplace/notifications/:id/read", async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: "id must be a UUID" });
    return guarded(reply, deps, async (tx) => {
      await markNotificationRead(tx, request.params.id);
      return { read: true };
    });
  });

  app.post("/workplace/messages", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    return guarded(reply, deps, (tx) => sendMessage(tx, body, OPERATOR), 201);
  });

  app.post("/workplace/calendar-entries", async (request, reply) => {
    const body = objectBody(request.body);
    if (!body) return reply.status(400).send({ error: "The request body must be a JSON object." });
    return guarded(reply, deps, (tx) => createCalendarEntry(tx, body, OPERATOR), 201);
  });

  app.post<{ Params: { id: string } }>("/workplace/calendar-entries/:id/cancel", async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: "id must be a UUID" });
    return guarded(reply, deps, (tx) => cancelCalendarEntry(tx, request.params.id, OPERATOR));
  });
}

/**
 * What every agent in the Keep is doing RIGHT NOW — one answer, computed by code from authoritative rows.
 *
 * Before this, five server-side vocabularies answered the same question in different words (the
 * availability engine's `available|busy|unavailable`, the Manager's `MISSION_REASONS`, Talk's refusal
 * `reason`, and two of the Keeper's), and the browser derived three more. They disagreed: a break blocked
 * meeting booking but not delegation; working hours gated meetings but nothing else; "stopped" was
 * computed with five different scope coverages. This module is the single deterministic answer the read
 * APIs, the living world and the Keeper all render.
 *
 * NOTHING here is presentation, and nothing here is authority. It writes no row, emits no event, calls no
 * model, and awards nothing. It reads: execution stops, unfinished Runs and their Task Instances, the
 * steps of unfinished Workflow Runs, event-verified meeting presence, and the workplace diary.
 *
 * The order below is the Keep's real hierarchy — an authority fact beats a runtime fact beats a diary
 * fact beats "nothing to do". Read it top to bottom:
 *
 *   stopped            an emergency stop covers this agent. Authority; always first.
 *   awaiting_approval  a Run of its is waiting for the operator. It cannot proceed and neither can we.
 *   in_meeting         event-verified presence in a meeting happening now.
 *   working            an unfinished Run that is actually active.
 *   waiting_dependency a step of an unfinished Workflow Run names it, and an earlier step has not finished.
 *   on_break           a `break` entry in its diary covers now.
 *   outside_hours      outside its working hours, and the Keep forbids work outside them.
 *   unavailable        an `unavailable` diary entry, or another blocking commitment.
 *   available          nothing is stopping it and it has nothing to do.
 *
 * `waiting_dependency` is deliberately named for what the runtime can prove. The interpreter is strictly
 * single-active-step, so a later step has no Task Instance until the earlier one finishes: the truthful
 * fact is "assigned work whose turn has not come", not "waiting for Alice specifically".
 */
import { asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { agentDefinitions, executionStops, goals, runs, taskDefinitions, taskInstances, workflowDefinitions, workflowRuns } from "../db/schema.js";
import { isLinearGraphDefinition } from "../workflow/graphTypes.js";
import { availabilityInputs, listMeetings, meetingPresence } from "../workplace/workplace.js";
import { availabilityOf, nextAvailableFrom } from "../workplace/availability.js";

export const AGENT_STATES = [
  "stopped",
  "awaiting_approval",
  "in_meeting",
  "working",
  "waiting_dependency",
  "on_break",
  "outside_hours",
  "unavailable",
  "available",
] as const;
export type AgentStateName = (typeof AGENT_STATES)[number];

export type AgentStateRow = {
  agentName: string;
  state: AgentStateName;
  /** One short sentence an operator can read. Never model text. */
  detail: string;
  /** When this state is known to end, or when the agent is next free. Null when unknown or already free. */
  until: string | null;
  /** The work it is doing or waiting on, when there is any. */
  work: { runId: string | null; goalId: string | null; goalTitle: string | null; taskKind: string | null } | null;
  /** The next meeting in its diary, however far ahead the window reaches. */
  nextMeeting: { meetingId: string; title: string; roomName: string; startsAt: string } | null;
};

const HORIZON_DAYS = 7;

/**
 * Every persistent agent's state at `now`. All shared reads happen ONCE, not per agent: presence, stops
 * and the diary are each computed a single time, because the living world polls this.
 */
export async function agentStates(tx: DrizzleTransaction, now = new Date()): Promise<AgentStateRow[]> {
  const versions = await tx.select({ id: agentDefinitions.id, name: agentDefinitions.name }).from(agentDefinitions);
  const names = [...new Set(versions.map((v) => v.name))].sort();
  if (names.length === 0) return [];
  const idsByName = new Map(names.map((n) => [n, versions.filter((v) => v.name === n).map((v) => v.id)]));

  const stops = await tx.select({ scope: executionStops.scope, ref: executionStops.scopeRefId }).from(executionStops).where(isNull(executionStops.liftedAt));
  const globallyStopped = stops.some((s) => s.scope === "global");
  const stoppedIds = new Set(stops.filter((s) => s.scope === "agent_definition").map((s) => (s.ref ?? "").toLowerCase()));

  const presence = await meetingPresence(tx, now);
  const horizon = { start: now, end: new Date(now.getTime() + HORIZON_DAYS * 86_400_000) };
  const meetings = await listMeetings(tx, { from: now, to: horizon.end }, now);
  const { clock, hours, commitments } = await availabilityInputs(tx, names, { start: now, end: new Date(now.getTime() + 60_000) });

  // Unfinished Runs, with the task and goal they belong to, in one pass.
  const live = await tx
    .select({
      runId: runs.id,
      runStatus: runs.status,
      agentId: runs.agentDefinitionId,
      taskStatus: taskInstances.status,
      taskKind: taskDefinitions.kind,
      workflowRunStatus: workflowRuns.status,
      goalId: goals.id,
      goalTitle: goals.title,
    })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .leftJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
    .leftJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
    .leftJoin(goals, eq(goals.id, workflowRuns.goalId))
    .where(notInArray(runs.status, ["completed", "failed"]))
    .orderBy(asc(runs.startedAt));

  // Steps of unfinished Workflow Runs whose turn has not come: assigned work that cannot start yet.
  const unfinished = await tx
    .select({ variables: workflowRuns.variables, graph: workflowDefinitions.graphDefinition, goalId: workflowRuns.goalId })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId))
    .where(inArray(workflowRuns.status, ["in_progress", "paused"]));
  const goalTitles = new Map(
    unfinished.length > 0
      ? (await tx.select({ id: goals.id, title: goals.title }).from(goals).where(inArray(goals.id, [...new Set(unfinished.map((u) => u.goalId))]))).map((g) => [g.id, g.title])
      : []
  );
  const assigned = new Map<string, { goalId: string; goalTitle: string | null }>();
  for (const wr of unfinished) {
    if (!isLinearGraphDefinition(wr.graph)) continue;
    const slots = ((wr.variables ?? {}) as { stepRunIds?: (string | null)[] }).stepRunIds ?? [];
    for (const [i, step] of wr.graph.steps.entries()) {
      if (!step.agentDefinitionId) continue;
      const name = versions.find((v) => v.id === step.agentDefinitionId)?.name;
      if (!name || assigned.has(name)) continue;
      const slot = slots[i] ?? null;
      const slotRun = slot ? await tx.query.runs.findFirst({ where: eq(runs.id, slot) }) : undefined;
      if (!slotRun || !["completed", "failed"].includes(slotRun.status)) assigned.set(name, { goalId: wr.goalId, goalTitle: goalTitles.get(wr.goalId) ?? null });
    }
  }

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return names.map((name) => {
    const ids = (idsByName.get(name) ?? []).map((id) => id.toLowerCase());
    const mine = live.filter((r) => r.agentId && ids.includes(r.agentId.toLowerCase()));
    const work = (r: (typeof live)[number]) => ({ runId: r.runId, goalId: r.goalId, goalTitle: r.goalTitle, taskKind: r.taskKind });
    const nextMeetingRow = meetings.find((m) => m.status !== "cancelled" && m.participants.some((p) => p.agentName === name));
    const nextMeeting = nextMeetingRow ? { meetingId: nextMeetingRow.id, title: nextMeetingRow.title, roomName: nextMeetingRow.room.name, startsAt: nextMeetingRow.startsAt } : null;
    const row = (state: AgentStateName, detail: string, until: string | null, w: AgentStateRow["work"] = null): AgentStateRow => ({ agentName: name, state, detail, until, work: w, nextMeeting });

    if (globallyStopped || ids.some((id) => stoppedIds.has(id))) return row("stopped", "An emergency stop covers this agent.", null);

    const waitingApproval = mine.find((r) => r.taskStatus === "awaiting_approval" || r.runStatus === "awaiting_approval");
    if (waitingApproval) return row("awaiting_approval", "Waiting for the operator to decide an approval.", null, work(waitingApproval));

    const meeting = presence.find((p) => p.agentName === name && p.phase === "in_meeting");
    if (meeting) return row("in_meeting", `In "${meeting.title}" in ${meeting.roomName}.`, meeting.endsAt);

    const working = mine.find((r) => r.taskStatus === "active" && r.workflowRunStatus !== "paused");
    if (working) return row("working", working.goalTitle ? `Working on "${working.goalTitle}".` : "Working.", null, work(working));

    const paused = mine.find((r) => r.workflowRunStatus === "paused");
    if (paused) return row("waiting_dependency", "Its workflow run is paused, so its step is holding.", null, work(paused));

    const queued = assigned.get(name);
    if (queued) return row("waiting_dependency", queued.goalTitle ? `Assigned to "${queued.goalTitle}", waiting for an earlier step to finish.` : "Assigned work whose turn has not come.", null, { runId: null, goalId: queued.goalId, goalTitle: queued.goalTitle, taskKind: null });

    // The diary last: it never overrides a runtime fact, it only explains an agent that has nothing to do.
    const hoursOf = hours.get(name)!;
    const free = availabilityOf({ agentName: name, range: { start: now, end: new Date(now.getTime() + 1) }, clock, hours: hoursOf, stopped: false, commitments });
    if (free.status !== "available") {
      const until = iso(nextAvailableFrom({ clock, hours: hoursOf, commitments, agentName: name, from: now }));
      const onBreak = free.reasons.find((r) => r.startsWith("break:"));
      if (onBreak) return row("on_break", `On a break (${onBreak.slice("break:".length).trim()}).`, until);
      if (free.reasons.includes("outside working hours")) return row("outside_hours", "Outside its working hours.", until);
      return row("unavailable", free.reasons[0] ?? "Unavailable.", until);
    }
    return row("available", "Available, with nothing to do.", null);
  });
}

/** `agentStates` in its own read-only snapshot, for the read APIs. */
export function readAgentStates(db: Database, now = new Date()): Promise<AgentStateRow[]> {
  return db.transaction((tx) => agentStates(tx as unknown as DrizzleTransaction, now), { isolationLevel: "repeatable read", accessMode: "read only" });
}

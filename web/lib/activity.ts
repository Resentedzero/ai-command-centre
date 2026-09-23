/**
 * Runtime activity → workstation activity (plan §13). One rule table, first match wins, read from
 * what `GET /agents/active` reports about a Run's latest Invocation. Presentation only: it chooses
 * which kind of desk an agent is drawn at, and nothing else. A category with no desk in the
 * configured world falls back to a generic desk (`allocateWorkstations`).
 */
import type { AgentCardData, ActiveStop, AgentState, MeetingPresence } from "./api";
import type { Desire } from "./living";

export type RunActivity = NonNullable<AgentCardData["activity"]>;

export const ACTIVITY_RULES: { activity: string; when: (a: RunActivity) => boolean; label: string }[] = [
  // Keeper Think puts records into words (its model call's intent is "write"), but the work is thinking.
  { activity: "think", when: (a) => a.taskKind === "keeper_answer", label: "thinking" },
  // A Talk is the agent thinking about what the operator asked it.
  { activity: "think", when: (a) => a.taskKind === "agent_talk", label: "thinking" },
  // The Manager plans and reviews at a thinking desk; the work it delegates is drawn by what that work does.
  { activity: "think", when: (a) => a.taskKind === "manager_plan", label: "planning" },
  { activity: "think", when: (a) => a.taskKind === "manager_review", label: "reviewing" },
  { activity: "research", when: (a) => a.capability?.startsWith("research.") === true, label: "research" },
  { activity: "publishing", when: (a) => a.capability === "publish.report", label: "publishing" },
  { activity: "analysis", when: (a) => a.intent === "analyse", label: "analysis" },
  { activity: "writing", when: (a) => a.intent === "write", label: "writing" },
  { activity: "think", when: (a) => a.invocationKind === "llm", label: "thinking" },
  { activity: "generic", when: () => true, label: "working" },
];

export function activityOf(a: RunActivity | null | undefined): { activity: string; label: string } {
  const rule = a ? ACTIVITY_RULES.find((r) => r.when(a))! : ACTIVITY_RULES.at(-1)!;
  return { activity: rule.activity, label: rule.label };
}

/** Whether an engaged stop covers this run (by its run, workflow run, goal or agent version). */
function stopCovers(stop: ActiveStop, row: AgentCardData, definitionIds: string[]): boolean {
  const ref = stop.scopeRefId?.toLowerCase();
  if (stop.scope === "global") return true;
  if (!ref) return false;
  if (stop.scope === "agent_definition") return definitionIds.some((id) => id.toLowerCase() === ref);
  if (stop.scope === "run") return row.runId.toLowerCase() === ref;
  if (stop.scope === "workflow_run") return row.workflowRunId?.toLowerCase() === ref;
  if (stop.scope === "goal") return row.goalId?.toLowerCase() === ref;
  return false;
}

/**
 * What the runtime says one persistent agent is doing, from its unfinished Runs, the engaged stops and
 * its real meeting (workplace). One priority order, no second state machine:
 * stopped › awaiting approval › real meeting › working › paused › queued › idle (ambient).
 * A real meeting outranks work in progress: the agent is at the meeting, and its run keeps running
 * without it (nothing new is given to an agent in a meeting — Talk and the Manager's roster refuse it).
 */
export function desireFor(rows: AgentCardData[], stops: ActiveStop[], definitionIds: string[], meeting: MeetingPresence | null = null, state: AgentState | null = null): Desire {
  // The server decides WHAT the agent is doing (`GET /agents/state`, src/api/agentState.ts): one
  // deterministic answer over stops, runs, meetings and the diary. The browser only decides how to draw
  // it, and still picks the desk from the run's own activity. Three states exist only on the server —
  // a break, being off the clock, and assigned work whose turn has not come — so without this fact the
  // world could only ever guess "idle" for them.
  if (state) {
    switch (state.state) {
      case "stopped":
        return { kind: "stopped", runIds: rows.map((r) => r.runId) };
      case "on_break":
        return { kind: "break", detail: state.detail, until: state.until };
      case "outside_hours":
      case "unavailable":
        return { kind: "off", detail: state.detail, until: state.until };
      case "waiting_dependency":
        if (rows.every((r) => r.workflowRunStatus !== "paused")) return { kind: "waiting_dependency", detail: state.detail };
        break;
      default:
        break;
    }
  }
  const agentStopped = stops.some((s) => s.scope === "global" || (s.scope === "agent_definition" && definitionIds.some((id) => id.toLowerCase() === s.scopeRefId?.toLowerCase())));
  const inMeeting: Desire | null = meeting
    ? { kind: "meeting", meetingId: meeting.meetingId, title: meeting.title, roomName: meeting.roomName, areaName: meeting.locationAreaName, phase: meeting.phase, endsAt: meeting.endsAt }
    : null;
  if (rows.length === 0) return agentStopped ? { kind: "stopped", runIds: [] } : (inMeeting ?? { kind: "idle" });
  const free = rows.filter((r) => !stops.some((s) => stopCovers(s, r, definitionIds)));
  if (free.length === 0) return { kind: "stopped", runIds: rows.map((r) => r.runId) };
  const waiting = free.filter((r) => r.taskStatus === "awaiting_approval");
  if (waiting.length > 0) return { kind: "wait", runIds: waiting.map((r) => r.runId) };
  if (inMeeting) return inMeeting;
  // A paused Workflow Run holds its step: never drawn as work, whatever its Task Instance still reads.
  const working = free.filter((r) => r.taskStatus === "active" && r.workflowRunStatus !== "paused");
  if (working.length > 0) return { kind: "work", activity: activityOf(working[0]!.activity).activity, runIds: working.map((r) => r.runId) };
  const paused = free.filter((r) => r.workflowRunStatus === "paused");
  if (paused.length > 0) return { kind: "paused", runIds: paused.map((r) => r.runId) };
  return { kind: "queued", runIds: free.map((r) => r.runId) };
}

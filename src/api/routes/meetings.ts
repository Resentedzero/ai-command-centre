/**
 * Convening: the point where a meeting in the diary becomes work the Keep actually does.
 *
 * A meeting row is a plan. Nothing in the runtime ever made one happen — a past `endsAt` only meant the
 * clock had moved. `sweepMeetingsToConvene` (a loop in `api/start.ts`, like the approval and recovery
 * sweeps) finds meetings whose time has come and holds them: a Goal in the "Meetings" Project and a linear
 * Workflow Run whose steps are the round table itself (`capabilities/meeting/buildInvocationSpecs.ts`).
 *
 * CODE decides, never a model:
 *   - whether it is time (`meetingsToConvene`: begun, not over, not cancelled, never tried before);
 *   - whether the room can actually sit (every participant free by `unavailabilityCode`, ignoring THIS
 *     meeting — the participants are of course "in" it);
 *   - who speaks, in what order (the participant list, alphabetical, as the diary holds it).
 * A meeting that cannot be held is recorded as not held, with the reason. It is never quietly skipped, and
 * no step ever pretends someone attended.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { agentDefinitions, goals, projects } from "../../db/schema.js";
import { getMeeting, markMeetingConvened, markMeetingNotConvened, meetingsToConvene } from "../../workplace/workplace.js";
import { unavailabilityCode } from "../../capabilities/manager/mission.js";
import { findManagerRefs } from "../../definitions/lookupSeed.js";
import { MEETINGS_PROJECT_NAME, MEETING_CONTRIBUTION_TASK_NAME, MEETING_OUTCOME_TASK_NAME } from "../../definitions/seed.js";
import { taskDefinitions } from "../../db/schema.js";
import { createWorkflowDefinition } from "../../definitions/registryWrites.js";
import { startWorkflowRun } from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsFromDefinitions } from "../../workflow/buildInvocationSpecsFromDefinitions.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import type { LinearGraphDefinition, LinearGraphStep } from "../../workflow/graphTypes.js";

/** The newest version of a seeded Task Definition by name. */
async function latestTask(tx: DrizzleTransaction, name: string) {
  const rows = await tx.query.taskDefinitions.findMany({ where: eq(taskDefinitions.name, name) });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

/** The newest version of an agent by its persistent name. */
async function latestAgent(tx: DrizzleTransaction, name: string) {
  const rows = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, name) });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

/**
 * Holds one meeting, or records truthfully why it could not be held. Returns the Workflow Run that IS the
 * meeting, or null when nothing was started (already held, not time, or nobody could come).
 */
export async function convene(db: Database, meetingId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as DrizzleTransaction;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`meeting:convene:${meetingId}`}))`);
    const meeting = await getMeeting(t, meetingId);
    // Re-checked inside the lock: another process may have held it, or the operator cancelled it.
    if (!meeting || meeting.status !== "in_progress" || meeting.convenedAt || meeting.notConvenedReason) return null;

    const refs = await findManagerRefs(t);
    const contributionTask = await latestTask(t, MEETING_CONTRIBUTION_TASK_NAME);
    const outcomeTask = await latestTask(t, MEETING_OUTCOME_TASK_NAME);
    const project = await tx.query.projects.findFirst({ where: eq(projects.name, MEETINGS_PROJECT_NAME) });
    if (!refs || !contributionTask || !outcomeTask || !project) {
      await markMeetingNotConvened(t, meetingId, 'the Keep is not set up to hold meetings yet: run "npm run seed".');
      return null;
    }

    // Everyone must actually be free to attend. Being in THIS meeting is not a reason to miss it, so the
    // meeting's own presence is what `unavailabilityCode` would report and is excluded here.
    const speakers: { name: string; id: string; version: number }[] = [];
    for (const p of meeting.participants) {
      const agent = await latestAgent(t, p.agentName);
      if (!agent) {
        await markMeetingNotConvened(t, meetingId, `${p.agentName} is no longer part of the Keep.`);
        return null;
      }
      const blocked = await unavailabilityCode(t, p.agentName, { ignoreMeetingId: meetingId, ignoreSchedule: true });
      if (blocked) {
        await markMeetingNotConvened(t, meetingId, `${p.agentName} could not attend: it ${blocked.detail}.`);
        return null;
      }
      speakers.push({ name: p.agentName, id: agent.id, version: agent.version });
    }
    if (speakers.length === 0) {
      await markMeetingNotConvened(t, meetingId, "the meeting had no participants.");
      return null;
    }

    const [goal] = await tx
      .insert(goals)
      .values({ projectId: project.id, title: `Meeting: ${meeting.title}`.slice(0, 200), description: meeting.agenda || meeting.title, status: "active" })
      .returning();

    const steps: LinearGraphStep[] = speakers.map((s, i) => ({
      stepId: `speaker_${i + 1}`,
      label: `${s.name} speaks`,
      taskDefinitionId: contributionTask.id,
      taskDefinitionVersion: contributionTask.version,
      agentDefinitionId: s.id,
      agentDefinitionVersion: s.version,
      parameters: { meetingId },
    }));
    steps.push({
      stepId: "outcome",
      label: "Manager records the outcome",
      taskDefinitionId: outcomeTask.id,
      taskDefinitionVersion: outcomeTask.version,
      agentDefinitionId: refs.agent.id,
      agentDefinitionVersion: refs.agent.version,
      parameters: { meetingId },
    });
    const graph: LinearGraphDefinition = { kind: "linear", description: `The round table for "${meeting.title}": each participant speaks in turn, then the Manager records what it produced.`, steps };

    const definition = await createWorkflowDefinition(
      t,
      { name: `Meeting: ${meeting.title}`.slice(0, 120), description: graph.description, graphDefinition: graph },
      "system"
    );
    const started = await startWorkflowRun(t, definition.id, goal!.id);
    await markMeetingConvened(t, meetingId, goal!.id);
    return started.workflowRunId;
  });
}

/**
 * Every meeting whose time has come. One at a time, each in its own transaction, so one meeting that
 * cannot be held never stops the next.
 */
export async function sweepMeetingsToConvene(db: Database): Promise<string[]> {
  const due = await db.transaction((tx) => meetingsToConvene(tx as unknown as DrizzleTransaction));
  const held: string[] = [];
  for (const meetingId of due) {
    const workflowRunId = await convene(db, meetingId);
    if (!workflowRunId) continue;
    held.push(workflowRunId);
    const relay = createWorkflowRelay(db);
    await relay.track(workflowRunId, { fresh: true });
    await relay.flush();
    await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, buildInvocationSpecsFromDefinitions);
  }
  return held;
}

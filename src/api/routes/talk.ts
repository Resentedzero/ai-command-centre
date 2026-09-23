/**
 * Talk to an agent (R2 character interaction): `POST /agents/:id/talk` — "request work from this agent".
 *
 * Body: `{ message }` and nothing else (any other field → 400; the browser cannot name a tier, Grant,
 * version, workflow or another agent). The backend resolves `:id` to the persistent agent (its NAME)
 * and runs its LATEST version, through a one-step Workflow whose step names that version — created
 * once through the Registry and reused. The request becomes an ordinary Goal in the "Direct requests"
 * Project; from there the Workflow Interpreter, Executor, Context Compiler, Policy, Budget Governor,
 * Model Router, stops, events and Artifacts handle it exactly like any other work
 * (`../../capabilities/agentTalk/buildInvocationSpecs.ts`). No model is called here.
 *
 * THE MANAGER. Talking to the Manager starts a mission with the message as its objective (`./manager.ts`).
 *
 * REFUSED BEFORE ANY WORK EXISTS (409, nothing written):
 * - `stopped`: a global stop, or a stop on any version of the agent, is engaged. (The Executor would
 *   halt it anyway; refusing first keeps a stopped agent from collecting Goals it cannot run.)
 * - `awaiting_approval` / `paused` / `busy`: the agent already has unfinished work. A Talk never
 *   interrupts it and never runs beside it; there is no queue.
 * The check and the start share one transaction, serialised per agent name, so two quick presses
 * cannot start two Talks.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import { agentDefinitions, runs, taskInstances, workflowDefinitions, workflowRuns, goals } from "../../db/schema.js";
import { findManagerRefs, findTalkRefs } from "../../definitions/lookupSeed.js";
import { startMission } from "./manager.js";
import { createWorkflowDefinition, RegistryWriteError } from "../../definitions/registryWrites.js";
import { findActiveStops, GLOBAL_STOP_REF } from "../../governance/executionStop.js";
import { isLinearGraphDefinition } from "../../workflow/graphTypes.js";
import { createWorkflowRelay, relayCommittedEvent } from "../liveEventRelay.js";
import { driveInBackground, insertGoalWithWorkflowRun } from "./goals.js";
import { inMeetingNow } from "../../workplace/workplace.js";
import type { DrizzleTransaction } from "../../events/emit.js";

export const MAX_TALK_MESSAGE = 2_000;
const OPERATOR = "human:operator";

type Refusal = { status: 400 | 404 | 409 | 503; body: Record<string, unknown> };

export function registerTalkRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{ Params: { id: string } }>("/agents/:id/talk", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: "The request body must be a JSON object." });
    const unknown = Object.keys(body).filter((k) => k !== "message");
    if (unknown.length > 0) return reply.status(400).send({ error: `unknown field(s): ${unknown.join(", ")}. A talk carries only a message.` });
    const message = (body as { message?: unknown }).message;
    if (typeof message !== "string" || message.trim() === "" || message.length > MAX_TALK_MESSAGE) {
      return reply.status(400).send({ error: `message must be 1 to ${MAX_TALK_MESSAGE} characters` });
    }
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: "agent id must be a UUID" });

    // Talking to the Manager gives it an objective: a governed mission, never a chat reply.
    const talkedTo = await deps.db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, request.params.id) });
    const manager = talkedTo ? await deps.db.transaction((tx) => findManagerRefs(tx), { accessMode: "read only" }) : null;
    if (talkedTo && manager && talkedTo.name === manager.agent.name) {
      const mission = await startMission(deps, message.trim());
      if ("status" in mission) return reply.status(mission.status).send(mission.body);
      return reply.status(202).send({ ...mission, mission: true, status: "planning" });
    }

    let result: Refusal | { goalId: string; workflowRunId: string; agent: { id: string; name: string; version: number }; eventKeys: string[] };
    try {
      result = await deps.db.transaction(async (tx): Promise<typeof result> => {
        const chosen = await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, request.params.id) });
        if (!chosen) return { status: 404, body: { error: `No agent definition found for id "${request.params.id}"` } };
        // One Talk start at a time per persistent agent.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`talk:${chosen.name}`}))`);
        const versions = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, chosen.name) });
        const agent = versions.sort((a, b) => b.version - a.version)[0]!;
        const versionIds = versions.map((v) => v.id);

        const stops = await findActiveStops(tx, [
          { scope: "global", scopeRefId: GLOBAL_STOP_REF },
          ...versionIds.map((id) => ({ scope: "agent_definition" as const, scopeRefId: id.toLowerCase() })),
        ]);
        if (stops.length > 0) {
          return { status: 409, body: { reason: "stopped", error: `${agent.name} is stopped (${stops[0]!.scope} stop${stops[0]!.reason ? `: ${stops[0]!.reason}` : ""}). Lift the stop before talking to it.` } };
        }
        // A real meeting (event-verified) holds the agent: no new work starts beside it.
        const meeting = await inMeetingNow(tx as unknown as DrizzleTransaction, agent.name);
        if (meeting) return { status: 409, body: { reason: "in_meeting", meetingId: meeting.meetingId, error: `${agent.name} is in a meeting ("${meeting.title}", ${meeting.roomName}) until ${meeting.endsAt}.` } };

        const refs = await findTalkRefs(tx);
        if (!refs) return { status: 503, body: { error: 'Talk is not set up yet: run "npm run seed".' } };

        // Unfinished work by any version: runs, plus Talk workflow runs whose step is not provisioned yet.
        const unfinished = await tx
          .select({ runId: runs.id, taskStatus: taskInstances.status, workflowRunStatus: workflowRuns.status, goalTitle: goals.title })
          .from(runs)
          .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
          .leftJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
          .leftJoin(goals, eq(goals.id, workflowRuns.goalId))
          .where(and(inArray(runs.agentDefinitionId, versionIds), notInArray(runs.status, ["completed", "failed"])));
        const busy = unfinished.find((u) => u.taskStatus === "awaiting_approval") ?? unfinished.find((u) => u.workflowRunStatus === "paused") ?? unfinished[0];
        if (busy) {
          const reason = busy.taskStatus === "awaiting_approval" ? "awaiting_approval" : busy.workflowRunStatus === "paused" ? "paused" : "busy";
          const words = reason === "awaiting_approval" ? "is waiting for an approval" : reason === "paused" ? "has paused work" : "is already working";
          return { status: 409, body: { reason, runId: busy.runId, goalTitle: busy.goalTitle, error: `${agent.name} ${words}${busy.goalTitle ? ` on "${busy.goalTitle}"` : ""}. A talk never interrupts or runs beside it.` } };
        }

        // The agent's Talk Workflow: one step, this version, the Talk Task Definition. Reused, else created by the Registry.
        const name = `${agent.name} v${agent.version} · talk`;
        const sameName = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, name) });
        const existing = sameName.find((w) => {
          const step = isLinearGraphDefinition(w.graphDefinition) && w.graphDefinition.steps.length === 1 ? w.graphDefinition.steps[0]! : null;
          return step?.agentDefinitionId === agent.id && step.agentDefinitionVersion === agent.version && step.taskDefinitionId === refs.taskDefinitionId && step.taskDefinitionVersion === refs.taskDefinitionVersion;
        });
        const eventKeys: string[] = [];
        let workflowDefinitionId: string;
        if (existing) {
          // A Talk already in flight on this workflow (its step not provisioned yet) is unfinished work too.
          const pending = await tx.query.workflowRuns.findFirst({ where: and(eq(workflowRuns.workflowDefinitionId, existing.id), inArray(workflowRuns.status, ["in_progress", "paused"])) });
          if (pending) return { status: 409, body: { reason: "busy", error: `${agent.name} is already answering a talk. A talk never runs beside another.` } };
          workflowDefinitionId = existing.id;
        } else {
          const created = await createWorkflowDefinition(
            tx,
            {
              name,
              ...(sameName.length > 0 ? { previousVersion: Math.max(...sameName.map((w) => w.version)) } : {}),
              graphDefinition: {
                kind: "linear",
                description: `The operator talks to ${agent.name} directly from the world. One reply; no tools, no actions.`,
                steps: [{ stepId: "reply", label: "Reply", taskDefinitionId: refs.taskDefinitionId, taskDefinitionVersion: refs.taskDefinitionVersion, agentDefinitionId: agent.id, agentDefinitionVersion: agent.version }],
              },
            },
            OPERATOR
          );
          workflowDefinitionId = created.id;
          eventKeys.push(created.eventIdempotencyKey);
        }

        const title = `${agent.name}: ${message.trim().replace(/\s+/g, " ").slice(0, 80)}`;
        const started = await insertGoalWithWorkflowRun(tx, { title, description: message.trim(), workflowDefinitionId, projectId: refs.projectId });
        if ("error" in started) return { status: 400, body: { error: started.error } };
        return { ...started, agent: { id: agent.id, name: agent.name, version: agent.version }, eventKeys };
      });
    } catch (error) {
      if (error instanceof RegistryWriteError) return reply.status(error.status).send({ error: error.message });
      throw error;
    }
    if ("status" in result) return reply.status(result.status).send(result.body);

    for (const key of result.eventKeys) await relayCommittedEvent(deps.db, key);
    const relay = createWorkflowRelay(deps.db);
    await relay.track(result.workflowRunId, { fresh: true });
    await relay.flush();
    driveInBackground(relay, result.workflowRunId);
    return reply.status(202).send({ goalId: result.goalId, workflowRunId: result.workflowRunId, agent: result.agent, status: "in_progress" });
  });
}

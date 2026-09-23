/**
 * The internal functions behind the Manager's two Capabilities. Both do all their reading and
 * checking in `prepare` (inside the builder's transaction, from stored rows); `execute` only returns
 * what `prepare` settled. Neither writes anything: delegation takes effect in the Manager plan's
 * following deterministic position, and only after this invocation was allowed by Policy, stops and
 * budget and completed.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { answerQuestion } from "../../keeper/explainIntent.js";
import { loopActionFor } from "../shared/loopActions.js";
import { codeWrittenRecord, countMission, grantsOf, latestAgents, unavailability } from "./mission.js";
import { MANAGER_DELEGATE_CAPABILITY, MANAGER_DELEGATE_RECORD, MANAGER_INSPECT_WORKFORCE_CAPABILITY, MISSION_LIMITS } from "./capability.js";
export { MANAGER_DELEGATE_RECORD, MANAGER_WORKFORCE_READ } from "./capability.js";

import { goals, runs, taskInstances, workflowRuns } from "../../db/schema.js";
import { eq } from "drizzle-orm";


const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A compact roster: one short record per agent, never histories, events, artifacts or other agents' context. */
export const managerWorkforceRead: InternalToolFunction = {
  capabilityName: MANAGER_INSPECT_WORKFORCE_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const exclude = typeof proposedActionSnapshot.excludeAgent === "string" ? proposedActionSnapshot.excludeAgent : null;
    const agents = [];
    for (const a of await latestAgents(tx)) {
      if (a.name === exclude) continue;
      const held = await grantsOf(tx, a);
      const profile = (a.executionProfile ?? {}) as { preferredTier?: string };
      const speciality = (await answerQuestion(tx, { subject: { type: "agent", id: a.id }, intent: "specialisation" })).headline;
      const specialist = /is a .+ specialist/.test(speciality);
      const unavailable = await unavailability(tx, a.name);
      // Only what planning needs: fields that are always the same ("available", "no specialisation yet") or
      // never used (the version: code binds the latest) are left out. Token audit, hardening pass.
      agents.push({
        name: a.name,
        role: clip(a.role, 80),
        objective: clip(a.objective, 160),
        tier: profile.preferredTier ?? "default",
        ...(unavailable ? { unavailable } : {}),
        ...(specialist ? { speciality: clip(speciality, 120) } : {}),
        loopTools: [...held.entries()].filter(([name, perms]) => loopActionFor(name) && perms.includes(loopActionFor(name)!.permission)).map(([name]) => name),
      });
    }
    return {
      inputs: { workforce: { agents, limits: { maxTasksPerPlan: MISSION_LIMITS.maxTasksPerPlan, maxWorkerIterations: MISSION_LIMITS.maxWorkerIterations } } },
      costClass: "local_retrieval",
      estimatedCost: 0,
    };
  },
  async execute({ inputs }) {
    return inputs.workforce as Record<string, unknown>;
  },
};

/**
 * Delegation. The snapshot names the code-written validation record the plan (or review) produced;
 * `prepare` re-reads it and confirms it was written by code (a deterministic invocation, hash intact) in a
 * Manager plan or review step of a mission; anything else is refused before Policy is asked. The tasks and
 * the mission limits are re-validated by the start step at the last boundary before any write.
 */
export const managerDelegateRecord: InternalToolFunction = {
  capabilityName: MANAGER_DELEGATE_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot }) {
    const record = await codeWrittenRecord(tx, proposedActionSnapshot.recordArtifactId);
    if (!record || record.content.valid !== true || record.content.delegate !== true) throw new Error(`${MANAGER_DELEGATE_RECORD}: no valid code-written plan record was named (fail closed).`);
    const run = await tx.query.runs.findFirst({ where: eq(runs.id, record.runId) });
    const ti = run ? await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) }) : undefined;
    const wr = ti?.workflowRunId ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, ti.workflowRunId) }) : undefined;
    const goal = wr ? await tx.query.goals.findFirst({ where: eq(goals.id, wr.goalId) }) : undefined;
    const manager = run?.agentDefinitionId ? await tx.query.agentDefinitions.findFirst({ where: (d, { eq: e }) => e(d.id, run.agentDefinitionId!) }) : undefined;
    if (!goal || !manager) throw new Error(`${MANAGER_DELEGATE_RECORD}: the plan record belongs to no mission (fail closed).`);
    // Limits and the tasks themselves are checked again by the start step, inside its transaction, just
    // before anything is written — where a refusal is recorded with its reason code.
    const used = await countMission(tx, goal.id);
    const proposed = (Array.isArray(record.content.tasks) ? record.content.tasks : []) as { stepId: string; agentName: string }[];
    return {
      inputs: { goalId: goal.id, round: used.workflowRuns, tasks: proposed.map(({ stepId, agentName }) => ({ stepId, agentName })), recordArtifactId: proposedActionSnapshot.recordArtifactId },
      costClass: "local_retrieval",
      estimatedCost: 0,
    };
  },
  async execute({ inputs }) {
    return { delegation: inputs };
  },
};

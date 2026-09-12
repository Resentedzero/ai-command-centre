/**
 * `buildInvocationSpecsForTaskDefinition` — Unit 10, Ruling 2
 * (task-10-brief.md): the real, production `InvocationSpecBuilder`
 * `advanceWorkflowRun` (`./interpreter.js`) needs, routing by
 * `params.taskDefinitionId` to whichever of Unit 9's two real
 * per-Task-Definition builders applies —
 * `buildResearchReportInvocationSpecs` (step 0) or
 * `buildPublishReportInvocationSpecs` (step 1), each partially applied with
 * `tx` and its own config object. Mirrors
 * `tests/capabilities/publishReport.integration.test.ts`'s
 * `buildCombinedBuilder` test fixture exactly, as real, reusable `src/`
 * code — this unit's brief explicitly calls that test's fixture out as the
 * pattern to follow.
 *
 * `query` (research step) / `destinationRelativePath` (publish step) are
 * derived deterministically from data already resolvable from
 * `params.taskInstanceId` alone (the step's own Goal title; a path keyed by
 * the step's own `taskInstanceId`) — never from external mutable request
 * state — so the returned specs stay byte-identical across repeated calls
 * for the same step, which `InvocationSpecBuilder`'s own contract requires
 * (`./interpreter.js`'s header, Ruling 3: "REQUIRED to be
 * deterministic/idempotent for the same inputs").
 */
import { eq } from "drizzle-orm";
import { goals, taskInstances, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { buildResearchReportInvocationSpecs } from "../capabilities/researchRetrieve/buildInvocationSpecs.js";
import { buildPublishReportInvocationSpecs } from "../capabilities/publishReport/buildInvocationSpecs.js";
import { DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../definitions/seed.js";
import type { SeededWorkflowRefs } from "../definitions/lookupSeed.js";
import type { InvocationSpecBuilder } from "./interpreter.js";

/** Deterministic per-step research query — the step's own Goal title, falling back to the taskInstanceId if the Goal can't be resolved. */
async function resolveResearchQuery(tx: DrizzleTransaction, taskInstanceId: string): Promise<string> {
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) });
  const workflowRunId = taskInstance?.workflowRunId;
  if (!workflowRunId) return `Research for task instance ${taskInstanceId}`;

  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!workflowRun) return `Research for task instance ${taskInstanceId}`;

  const goal = await tx.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) });
  return goal?.title ?? `Research for task instance ${taskInstanceId}`;
}

export function buildInvocationSpecsForTaskDefinition(tx: DrizzleTransaction, seed: SeededWorkflowRefs): InvocationSpecBuilder {
  return async (params) => {
    if (params.taskDefinitionId === seed.taskDefinitionId) {
      const query = await resolveResearchQuery(tx, params.taskInstanceId);
      return buildResearchReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.agentDefinitionId,
          agentDefinitionVersion: seed.agentDefinitionVersion,
          capabilityId: seed.capabilityId,
          toolBindingId: seed.toolBindingId,
          query,
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
        },
        params
      );
    }

    if (params.taskDefinitionId === seed.reviewAndPublishTaskDefinitionId) {
      return buildPublishReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.publisherAgentDefinitionId,
          agentDefinitionVersion: seed.publisherAgentDefinitionVersion,
          capabilityId: seed.publishCapabilityId,
          toolBindingId: seed.publishToolBindingId,
          researchReportTaskDefinitionId: seed.taskDefinitionId,
          destinationRelativePath: `reports/${params.taskInstanceId}.json`,
        },
        params
      );
    }

    throw new Error(`buildInvocationSpecsForTaskDefinition: unexpected taskDefinitionId "${params.taskDefinitionId}"`);
  };
}

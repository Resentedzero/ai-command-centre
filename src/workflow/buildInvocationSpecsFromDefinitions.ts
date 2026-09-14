/**
 * `buildInvocationSpecsFromDefinitions` — the production `InvocationSpecBuilder`
 * (spec §18.3). Everything a step's plan needs is read from persisted
 * Definitions, never from a caller or a seed:
 *
 *   Task Instance -> its Workflow Run -> the Workflow Definition's graph step
 *   (located by the Task Instance's slot in the Run's step bookkeeping)
 *     -> the step's Agent Definition (id + version) and parameters
 *     -> the Task Definition (id + version) -> its `kind`
 *     -> the registered plan for that kind (`../capabilities/taskPlans.ts`).
 *
 * Fails closed when any link is missing: a step with no Agent, an Agent or Task
 * Definition that does not exist, a step that does not match the Task Instance,
 * or a kind with no registered plan. Binding an Agent here authorizes nothing:
 * every Tool Invocation still needs that Agent version's Grant, through Policy.
 *
 * Deterministic: it reads only immutable Definition rows and the step
 * bookkeeping written before the builder is first called, so a resume plans the
 * same step identically.
 */
import { and, eq } from "drizzle-orm";
import { agentDefinitions, taskDefinitions, taskInstances, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { taskPlanBuilderFor } from "../capabilities/taskPlans.js";
import { bindRunAgent, findRunByTaskInstanceId } from "../capabilities/shared/runProvisioning.js";
import { provisionRunBudgets } from "../governance/runBudgetPolicy.js";
import { loadGraphDefinition, type InvocationSpecBuilder } from "./interpreter.js";

export function buildInvocationSpecsFromDefinitions(tx: DrizzleTransaction): InvocationSpecBuilder {
  return async (params) => {
    const fail = (reason: string): never => {
      throw new Error(`buildInvocationSpecsFromDefinitions: task_instance "${params.taskInstanceId}" ${reason} (fail closed).`);
    };

    const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, params.taskInstanceId) });
    if (!taskInstance) return fail("does not exist");
    if (!taskInstance.workflowRunId) return fail("is not a workflow step");

    const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) });
    if (!workflowRun) return fail("belongs to a workflow run that does not exist");

    const graph = await loadGraphDefinition(tx, workflowRun.workflowDefinitionId, workflowRun.workflowDefinitionVersion);
    const slots = (workflowRun.variables as { stepTaskInstanceIds?: unknown } | null)?.stepTaskInstanceIds;
    const stepIndex = Array.isArray(slots) ? slots.indexOf(taskInstance.id) : -1;
    const step = stepIndex >= 0 ? graph.steps[stepIndex] : undefined;
    if (!step) return fail("has no step slot in its workflow run");
    if (step.taskDefinitionId !== params.taskDefinitionId || step.taskDefinitionVersion !== params.taskDefinitionVersion) {
      return fail(`does not match step ${stepIndex} of its workflow definition`);
    }
    if (step.agentDefinitionId === undefined || step.agentDefinitionVersion === undefined) {
      return fail(`is step ${stepIndex}, which binds no Agent Definition`);
    }

    const agent = await tx.query.agentDefinitions.findFirst({
      where: and(eq(agentDefinitions.id, step.agentDefinitionId), eq(agentDefinitions.version, step.agentDefinitionVersion)),
    });
    if (!agent) return fail(`is step ${stepIndex}, whose Agent Definition ${step.agentDefinitionId} v${step.agentDefinitionVersion} does not exist`);

    const taskDefinition = await tx.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.id, step.taskDefinitionId), eq(taskDefinitions.version, step.taskDefinitionVersion)),
    });
    if (!taskDefinition) return fail(`is step ${stepIndex}, whose Task Definition does not exist`);
    const plan = taskPlanBuilderFor(taskDefinition.kind);

    // The step's Run IS the binding of this Agent version to the Task Instance
    // (spec §3b), and its budgets are governance's ceilings. Done here, before
    // any plan runs, so no plan can skip either. Both idempotent on resume.
    const run = await findRunByTaskInstanceId(tx, taskInstance.id);
    await bindRunAgent(tx, run.id, agent.id, agent.version);
    await provisionRunBudgets(tx, run.id);

    return await plan(tx, {
      taskDefinition,
      agentDefinitionId: agent.id,
      agentDefinitionVersion: agent.version,
      parameters: step.parameters ?? {},
      params,
    });
  };
}

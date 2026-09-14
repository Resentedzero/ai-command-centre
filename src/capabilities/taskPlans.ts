/**
 * Task plan registry (spec Phase 11 "Reusable primitives", §18.3).
 *
 * A Task Definition's `kind` names the reusable plan that turns one of its Task
 * Instances into an invocation plan. Workflows reuse a kind with different
 * parameters (a graph step's `parameters`). Adding a new kind of work is a
 * registered plan builder here plus Definition rows; the Interpreter, Executor,
 * governance and API are unchanged. The step's Agent, the Task Definition row and
 * the parameters are resolved from persisted Definitions by
 * `../workflow/buildInvocationSpecsFromDefinitions.ts`, never passed in by a caller.
 *
 * A plan builder carries the same contract as `InvocationSpecBuilder`
 * (`../workflow/interpreter.ts`): deterministic for the same persisted rows,
 * because it is called again on every resume.
 */
import { eq } from "drizzle-orm";
import { goals, taskDefinitions, taskInstances, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { ContextBudget } from "../context/types.js";
import type { PlannedInvocationSpec } from "../execution/types.js";
import type { InvocationSpecBuilder } from "../workflow/interpreter.js";
import { buildResearchReportInvocationSpecs } from "./researchRetrieve/buildInvocationSpecs.js";
import { buildPublishReportInvocationSpecs } from "./publishReport/buildInvocationSpecs.js";

export type TaskPlanContext = {
  taskDefinition: typeof taskDefinitions.$inferSelect;
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  parameters: Record<string, unknown>;
  params: Parameters<InvocationSpecBuilder>[0];
};

export type TaskPlanBuilder = (tx: DrizzleTransaction, ctx: TaskPlanContext) => Promise<PlannedInvocationSpec[]>;

const planBuilders = new Map<string, TaskPlanBuilder>();

/** Registers the plan for a Task Definition `kind`. A kind is never reassigned. */
export function registerTaskPlanBuilder(kind: string, builder: TaskPlanBuilder): void {
  if (planBuilders.has(kind)) throw new Error(`registerTaskPlanBuilder: kind "${kind}" is already registered.`);
  planBuilders.set(kind, builder);
}

export function hasTaskPlan(kind: string): boolean {
  return planBuilders.has(kind);
}

export function taskPlanBuilderFor(kind: string): TaskPlanBuilder {
  const builder = planBuilders.get(kind);
  if (!builder) throw new Error(`No task plan is registered for Task Definition kind "${kind}" (fail closed).`);
  return builder;
}

const CONTEXT_BUDGET_FIELDS: (keyof ContextBudget)[] = [
  "maxInputTokens",
  "maxArtifactTokens",
  "maxRetrievedItems",
  "maxToolSchemaTokens",
  "compressionThreshold",
  "freshnessRequirementSeconds",
  "expectedOutputTokens",
];

/** A Task Definition's `default_context_budget`, required complete: a missing field is an error, never a default. */
export function requireContextBudget(value: unknown, taskDefinitionName: string): ContextBudget {
  const budget = (value ?? {}) as Record<string, unknown>;
  for (const field of CONTEXT_BUDGET_FIELDS) {
    if (typeof budget[field] !== "number" || !Number.isFinite(budget[field])) {
      throw new Error(`Task Definition "${taskDefinitionName}" has no valid default_context_budget.${field} (fail closed).`);
    }
  }
  return Object.fromEntries(CONTEXT_BUDGET_FIELDS.map((f) => [f, budget[f]])) as ContextBudget;
}

function requireStringParameter(ctx: TaskPlanContext, name: string): string {
  const value = ctx.parameters[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Task Definition kind "${ctx.taskDefinition.kind}" requires the step parameter "${name}" (fail closed).`);
  }
  return value;
}

/** The research query: the Goal the step's Workflow Run serves. Deterministic for the step. */
async function goalTitleFor(tx: DrizzleTransaction, taskInstanceId: string): Promise<string> {
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) });
  const workflowRun = taskInstance?.workflowRunId
    ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) })
    : undefined;
  const goal = workflowRun ? await tx.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) }) : undefined;
  return goal?.title ?? `Research for task instance ${taskInstanceId}`;
}

/** Retrieve with `research.retrieve`, synthesize with an LLM, mark the result as the Run's report. */
export const RESEARCH_REPORT_TASK_KIND = "research_report";

/** Publish the report produced by an earlier step (parameter `sourceTaskDefinitionId`) with `publish.report`. */
export const PUBLISH_REPORT_TASK_KIND = "publish_report";

registerTaskPlanBuilder(RESEARCH_REPORT_TASK_KIND, async (tx, ctx) =>
  buildResearchReportInvocationSpecs(
    tx,
    {
      agentDefinitionId: ctx.agentDefinitionId,
      agentDefinitionVersion: ctx.agentDefinitionVersion,
      query: await goalTitleFor(tx, ctx.params.taskInstanceId),
      contextBudget: requireContextBudget(ctx.taskDefinition.defaultContextBudget, ctx.taskDefinition.name),
    },
    ctx.params
  )
);

registerTaskPlanBuilder(PUBLISH_REPORT_TASK_KIND, async (tx, ctx) =>
  buildPublishReportInvocationSpecs(
    tx,
    {
      agentDefinitionId: ctx.agentDefinitionId,
      agentDefinitionVersion: ctx.agentDefinitionVersion,
      researchReportTaskDefinitionId: requireStringParameter(ctx, "sourceTaskDefinitionId"),
      destinationRelativePath: `reports/${ctx.params.taskInstanceId}.json`,
    },
    ctx.params
  )
);

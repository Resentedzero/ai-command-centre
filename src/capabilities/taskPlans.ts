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
import type { LinearGraphDefinition } from "../workflow/graphTypes.js";
import { buildAgentTaskInvocationSpecs, validateAgentTaskStep, type AgentTaskParameters } from "./agentTask/buildInvocationSpecs.js";
import { buildCheckpointInvocationSpecs, validateCheckpointStep, type CheckpointParameters } from "./reviewCheckpoint/buildInvocationSpecs.js";
import { loadExecutionProfile } from "./shared/agentProfile.js";
import { parseStepInputs } from "./shared/stepInputs.js";

export type TaskPlanContext = {
  taskDefinition: typeof taskDefinitions.$inferSelect;
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  parameters: Record<string, unknown>;
  params: Parameters<InvocationSpecBuilder>[0];
};

export type TaskPlanBuilder = (tx: DrizzleTransaction, ctx: TaskPlanContext) => Promise<PlannedInvocationSpec[]>;

/**
 * V1.1 (R3): a kind's check of a workflow step's parameters, run by the Registry when a
 * Workflow Definition is saved, so an invalid workflow fails before it can run. Returns
 * why the step is invalid, or null. The plan still fails closed at run time.
 */
export type StepParameterValidator = (
  tx: DrizzleTransaction,
  ctx: { parameters: Record<string, unknown>; graph: LinearGraphDefinition; stepIndex: number; agentDefinitionId: string; agentDefinitionVersion: number }
) => Promise<string | null>;

const planBuilders = new Map<string, TaskPlanBuilder>();
const stepValidators = new Map<string, StepParameterValidator>();

/** Registers the plan (and optionally the step-parameter check) for a Task Definition `kind`. A kind is never reassigned. */
export function registerTaskPlanBuilder(kind: string, builder: TaskPlanBuilder, options: { validateStepParameters?: StepParameterValidator } = {}): void {
  if (planBuilders.has(kind)) throw new Error(`registerTaskPlanBuilder: kind "${kind}" is already registered.`);
  planBuilders.set(kind, builder);
  if (options.validateStepParameters) stepValidators.set(kind, options.validateStepParameters);
}

/** The kind's save-time verdict on a step's parameters: why it is invalid, or null (also for a kind with no check). */
export async function validateStepParameters(tx: DrizzleTransaction, kind: string, ctx: Parameters<StepParameterValidator>[1]): Promise<string | null> {
  const validate = stepValidators.get(kind);
  return validate ? await validate(tx, ctx) : null;
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

registerTaskPlanBuilder(
  PUBLISH_REPORT_TASK_KIND,
  async (tx, ctx) =>
    buildPublishReportInvocationSpecs(
      tx,
      {
        agentDefinitionId: ctx.agentDefinitionId,
        agentDefinitionVersion: ctx.agentDefinitionVersion,
        researchReportTaskDefinitionId: requireStringParameter(ctx, "sourceTaskDefinitionId"),
        destinationRelativePath: `reports/${ctx.params.taskInstanceId}.json`,
      },
      ctx.params
    ),
  {
    validateStepParameters: async (_tx, ctx) => {
      const source = ctx.parameters.sourceTaskDefinitionId;
      if (typeof source !== "string" || source === "") return `publish_report requires the step parameter "sourceTaskDefinitionId".`;
      if (!ctx.graph.steps.slice(0, ctx.stepIndex).some((s) => s.taskDefinitionId === source)) {
        return `"sourceTaskDefinitionId" must be the Task Definition of an earlier step.`;
      }
      return null;
    },
  }
);

/** V1.1: a general agent step that writes a deliverable from an instruction and explicitly selected earlier outputs. */
export const AGENT_TASK_KIND = "agent_task";

/** V1.1: an explicit approval gate over earlier outputs (`review.checkpoint`, ALWAYS_APPROVE). */
export const OPERATOR_CHECKPOINT_KIND = "operator_checkpoint";

/** Step parameters, re-checked at run time with the same rules as at save time (a Definition edited by SQL still fails closed). */
function stepParameters<T>(ctx: TaskPlanContext, check: (p: Record<string, unknown>) => string | null): T {
  const problem = check(ctx.parameters);
  if (problem) throw new Error(`Task Definition kind "${ctx.taskDefinition.kind}": ${problem} (fail closed).`);
  const inputs = parseStepInputs(ctx.parameters.inputs);
  if (!inputs.ok) throw new Error(`Task Definition kind "${ctx.taskDefinition.kind}": ${inputs.reason} (fail closed).`);
  return { ...ctx.parameters, inputs: inputs.inputs } as T;
}

registerTaskPlanBuilder(
  AGENT_TASK_KIND,
  async (tx, ctx) =>
    buildAgentTaskInvocationSpecs(
      tx,
      {
        parameters: stepParameters<AgentTaskParameters>(ctx, (p) =>
          typeof p.instruction === "string" && p.instruction.trim() !== "" ? null : `requires the step parameter "instruction"`
        ),
        contextBudget: requireContextBudget(ctx.taskDefinition.defaultContextBudget, ctx.taskDefinition.name),
        profile: await loadExecutionProfile(tx, ctx.agentDefinitionId, ctx.agentDefinitionVersion),
      },
      ctx.params
    ),
  { validateStepParameters: async (_tx, ctx) => validateAgentTaskStep(ctx) }
);

registerTaskPlanBuilder(
  OPERATOR_CHECKPOINT_KIND,
  async (tx, ctx) =>
    buildCheckpointInvocationSpecs(
      tx,
      {
        agentDefinitionId: ctx.agentDefinitionId,
        agentDefinitionVersion: ctx.agentDefinitionVersion,
        parameters: stepParameters<CheckpointParameters>(ctx, (p) =>
          typeof p.question === "string" && p.question.trim() !== "" ? null : `requires the step parameter "question"`
        ),
      },
      ctx.params
    ),
  { validateStepParameters: validateCheckpointStep }
);

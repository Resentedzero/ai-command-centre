/**
 * `LinearGraphDefinition` — Unit 7's minimal Workflow graph shape (frozen
 * verbatim from the task-7 brief). MVP scope is linear-only: a flat ordered
 * list of steps, no branching/looping/multiple-paths (see interpreter.ts's
 * module header and the task-7 brief's "Out of scope" section).
 *
 * `workflow_definitions.graph_definition` is stored as generic
 * `jsonb`/`Record<string, unknown>` (Unit 1's schema makes no assumption
 * about graph shape). `isLinearGraphDefinition` is the one, sole place that
 * casts that generic JSON into this concrete shape — and it FAILS CLOSED: a
 * malformed or wrong-shape value is never silently coerced, defaulted, or
 * partially accepted. It returns `false`, and every caller in
 * `interpreter.ts` (`startWorkflowRun`, `advanceWorkflowRun`) throws a clear
 * error rather than proceeding with partially-valid data. This matters
 * because a mis-shapen graph silently accepted here would corrupt the
 * `stepTaskInstanceIds` bookkeeping (see interpreter.ts's Ruling 1) in ways
 * that are hard to detect after the fact — e.g. a graph with zero steps
 * would make "the last step" undefined everywhere it's referenced.
 *
 * A zero-step graph is deliberately rejected here too (`steps.length === 0`
 * fails the guard): a Workflow Run over an empty step list has no
 * meaningful "last step" for Ruling 2/algorithm steps 8-11 to reason about,
 * and MVP scope only ever exercises exactly 2 steps regardless.
 */
export type LinearGraphStep = {
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /**
   * The Agent Definition this step's Run is bound to (spec §3b: a Run IS the
   * binding of an Agent Definition version to a Task Instance). Part of the
   * Workflow composition (spec §18.3). Optional in the shape, so a graph without
   * it still parses; the definitions-driven builder refuses to plan such a step
   * (`buildInvocationSpecsFromDefinitions`). Both fields or neither.
   */
  agentDefinitionId?: string;
  agentDefinitionVersion?: number;
  /** Parameters for the step's Task Definition kind (spec Phase 11: reusable kinds, different parameters). */
  parameters?: Record<string, unknown>;
  /**
   * V1.1: a stable id, unique within the graph, by which later steps address this
   * step's output (`parameters.inputs[].fromStepId`) and a richer graph form can name
   * nodes later. Optional: V1 graphs have none.
   */
  stepId?: string;
  /** V1.1: the operator's name for the step. */
  label?: string;
};

export type LinearGraphDefinition = {
  kind: "linear";
  steps: LinearGraphStep[];
  /** V1.1: what the workflow is for, in the operator's words. */
  description?: string;
};

function isStep(value: unknown): value is LinearGraphStep {
  if (value === null || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  if (typeof step.taskDefinitionId !== "string" || typeof step.taskDefinitionVersion !== "number") return false;
  if ((step.agentDefinitionId === undefined) !== (step.agentDefinitionVersion === undefined)) return false;
  if (step.agentDefinitionId !== undefined && typeof step.agentDefinitionId !== "string") return false;
  if (step.agentDefinitionVersion !== undefined && typeof step.agentDefinitionVersion !== "number") return false;
  if (step.parameters !== undefined && (step.parameters === null || typeof step.parameters !== "object" || Array.isArray(step.parameters))) {
    return false;
  }
  if (step.stepId !== undefined && typeof step.stepId !== "string") return false;
  if (step.label !== undefined && typeof step.label !== "string") return false;
  return true;
}

export function isLinearGraphDefinition(value: unknown): value is LinearGraphDefinition {
  if (value === null || typeof value !== "object") return false;
  const graph = value as Record<string, unknown>;
  if (graph.kind !== "linear") return false;
  if (!Array.isArray(graph.steps)) return false;
  if (graph.steps.length === 0) return false;
  if (graph.description !== undefined && typeof graph.description !== "string") return false;
  return graph.steps.every(isStep);
}

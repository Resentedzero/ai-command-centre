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
export type LinearGraphDefinition = {
  kind: "linear";
  steps: { taskDefinitionId: string; taskDefinitionVersion: number }[];
};

function isStep(value: unknown): value is { taskDefinitionId: string; taskDefinitionVersion: number } {
  if (value === null || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  return typeof step.taskDefinitionId === "string" && typeof step.taskDefinitionVersion === "number";
}

export function isLinearGraphDefinition(value: unknown): value is LinearGraphDefinition {
  if (value === null || typeof value !== "object") return false;
  const graph = value as Record<string, unknown>;
  if (graph.kind !== "linear") return false;
  if (!Array.isArray(graph.steps)) return false;
  if (graph.steps.length === 0) return false;
  return graph.steps.every(isStep);
}

/**
 * `advanceWorkflowRunUntilBlocked` — Unit 10, Ruling 3 fix round 1 (the
 * coordinator's correction to the original task-10-brief.md ruling, which
 * called `advanceWorkflowRun` exactly once per mutating route). A single
 * `advanceWorkflowRun` call only ever advances ONE step
 * (`src/workflow/interpreter.ts`'s own documented algorithm: "do NOT create
 * the next step's Task Instance within this same call — a subsequent
 * advanceWorkflowRun call does that"), so calling it exactly once per
 * request left a Workflow Run permanently stuck after its first step
 * completed, with no route able to progress it further (see
 * task-10-report.md's original "Concerns" section for the full writeup of
 * that gap). This function loops the frozen `advanceWorkflowRun` up to the
 * Workflow Run's own step count instead, so one mutating request drives the
 * run as far as automatically possible.
 *
 * Bound and termination argument (why `steps.length` calls always suffices,
 * and why no fixed-point/"no more progress possible" detection is needed):
 * per `interpreter.ts`'s own documented algorithm, every `advanceWorkflowRun`
 * call does EXACTLY ONE of:
 *   (a) create and fully run a brand-new step (`createAndRunStep`) — for
 *       this MVP's builders, the step's entire builder-internal work
 *       (including Task A's own two-phase tool->llm dance, Unit 9's
 *       documented design) completes within that ONE call; or
 *   (b) resume an existing step that is `awaiting_approval` and find it
 *       STILL pending (`resumeStep` -> `resumeToolSpec`'s
 *       `approval.status === "pending"` no-op branch) — a cheap read-only
 *       call that writes nothing.
 * So across up to `steps.length` calls, either every step gets created and
 * the Workflow Run reaches a terminal status ("completed"/"failed"), or some
 * step gets created and halts at a genuine `awaiting_approval`
 * human-blocking point — after which every further call within the budget
 * is the cheap no-op (b). That is a small amount of wasted work, not a
 * correctness problem, and it is NEVER more calls than there are steps to
 * create — a deliberate, documented trade-off against needing to detect
 * "no more progress possible" some other way, acceptable for a solo, local
 * MVP with no concurrency.
 *
 * Stops early the moment a call returns "completed", "failed", or "paused"
 * (the brief's correction only names "completed"/"failed"; "paused" is
 * included too since a call after that is equally a wasted no-op read —
 * `advanceWorkflowRun` short-circuits at its own top for a paused run). If
 * the loop is exhausted while still "in_progress", that IS the correct,
 * expected outcome for a run that has reached a genuine human-approval
 * gate — not a failure of this loop.
 *
 * `steps.length` is derived generically from the Workflow Run's own
 * Workflow Definition graph (never hardcoded to this MVP's known 2-step
 * seed), via the same fail-closed `isLinearGraphDefinition` guard
 * `interpreter.ts` itself uses.
 */
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { advanceWorkflowRun, type InvocationSpecBuilder } from "./interpreter.js";
import { isLinearGraphDefinition } from "./graphTypes.js";

type AdvanceResult = { status: "in_progress" | "completed" | "failed" | "paused" };

async function getWorkflowRunStepCount(tx: DrizzleTransaction, workflowRunId: string): Promise<number> {
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!workflowRun) {
    throw new Error(`advanceWorkflowRunUntilBlocked: no workflow_runs row found for id "${workflowRunId}"`);
  }

  const definition = await tx.query.workflowDefinitions.findFirst({
    where: and(
      eq(workflowDefinitions.id, workflowRun.workflowDefinitionId),
      eq(workflowDefinitions.version, workflowRun.workflowDefinitionVersion)
    ),
  });
  if (!definition) {
    throw new Error(
      `advanceWorkflowRunUntilBlocked: no workflow_definitions row found for id "${workflowRun.workflowDefinitionId}" ` +
        `version ${workflowRun.workflowDefinitionVersion}`
    );
  }
  if (!isLinearGraphDefinition(definition.graphDefinition)) {
    throw new Error(
      `advanceWorkflowRunUntilBlocked: workflow_definitions "${definition.id}" v${definition.version} has a ` +
        "graph_definition that is not a valid LinearGraphDefinition (fail closed)."
    );
  }

  return definition.graphDefinition.steps.length;
}

export async function advanceWorkflowRunUntilBlocked(
  tx: DrizzleTransaction,
  workflowRunId: string,
  buildInvocationSpecs: InvocationSpecBuilder
): Promise<AdvanceResult> {
  const maxCalls = await getWorkflowRunStepCount(tx, workflowRunId);

  let result: AdvanceResult = { status: "in_progress" };
  for (let i = 0; i < maxCalls; i++) {
    result = await advanceWorkflowRun(tx, workflowRunId, buildInvocationSpecs);
    if (result.status === "completed" || result.status === "failed" || result.status === "paused") {
      return result;
    }
  }
  return result;
}

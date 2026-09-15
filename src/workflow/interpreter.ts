/**
 * `startWorkflowRun` / `advanceWorkflowRun` / `pauseWorkflowRun` /
 * `resumeWorkflowRun` — Unit 7's Workflow Interpreter (Phase 11), strictly
 * scoped to linear, 2-task, Workflow-created Task Instances. This module
 * NEVER calls an LLM and contains no policy/budget/routing logic inline —
 * it only sequences Task Instance/Run creation and delegates actual
 * invocation execution to Unit 6's `executeRun`. It NEVER imports Unit 6's
 * OTHER (standalone) Task Instance creation export from
 * `../execution/taskInstance.js` — only `createWorkflowTaskInstance` —
 * enforced structurally by a grep-based test
 * in `tests/workflow/interpreter.test.ts` (Phase 3b's distinct-code-paths
 * requirement).
 *
 * ---------------------------------------------------------------------------
 * Pre-dispatch rulings this module implements (task-7-brief.md)
 * ---------------------------------------------------------------------------
 *
 * Ruling 1 — step-progress bookkeeping lives in `workflow_runs.variables`,
 * shaped `{ stepTaskInstanceIds: (string|null)[] }` per the brief, verbatim
 * — one slot per step in the graph, `null` until that step's Task Instance
 * is created. Same technique Unit 6 used for `runs.budget_envelope`
 * (interpreter-owned scratch state, never read by other units).
 *
 * EXTENSION beyond the brief's literal shape (documented, not silent): a
 * parallel `stepRunIds: (string|null)[]` key is stored alongside it, filled
 * in lockstep with `stepTaskInstanceIds`. Reason: `runs` has NO unique index
 * on `task_instance_id` (unlike e.g. `approvals.invocation_id`, which Unit 3
 * gave one specifically so `reauthorize`'s lookup is deterministic by
 * construction rather than an arbitrary `findFirst` pick). Re-deriving "the
 * run for this step" via `findFirst({where: eq(runs.taskInstanceId, ...)})`
 * on resume would be exactly the nondeterministic-lookup hazard Unit 3/6
 * already had to design around elsewhere — this unit avoids it by storing
 * the id it already has at creation time instead of re-querying for it.
 * `variables` is interpreter-owned scratch state (Ruling 1's own framing),
 * so adding a second key to it is consistent with, not a deviation from,
 * the ruling.
 *
 * Ruling 2 — this module, not `executeRun`, is what ever writes
 * `task_instances.status` after creation. The mapping from `RunOutcome`'s
 * status to the Task Instance's status is an EXPLICIT switch
 * (`mapRunOutcomeToTaskInstanceStatus` below), not a bare `outcome.status`
 * copy. `RunOutcome` is the Executor's type, not this unit's, and the two
 * vocabularies already differ: `dispatch_required` and `in_flight` both map to
 * `active`. The explicit switch has no `default` case, so — combined with
 * `noImplicitReturns` in this project's tsconfig — a new `RunOutcome` status
 * becomes a compile error here, not a silently-written unknown
 * `task_instances.status` value.
 *
 * Ruling 3 — `advanceWorkflowRun` takes a required `buildInvocationSpecs`
 * callback (type `InvocationSpecBuilder`) so it can obtain the
 * `InvocationSpec[]` for a step without knowing anything about that step's
 * Task Definition — that knowledge belongs to the step planner
 * (`./buildInvocationSpecsFromDefinitions.ts`, `../capabilities/taskPlans.ts`). Note this
 * callback's frozen signature does NOT include `tx`: a real (future) caller
 * constructs it as a closure over whatever `tx`/context it needs (e.g.
 * `const build = (p) => unit9RealBuilder(tx, p)`), exactly the pattern this
 * module's own tests use to seed DB state (an agent binding) a "tool" spec
 * needs before `executeRun` can authorize it — see the test file's
 * `buildInvocationSpecs` fixtures, and the "runs row" note below.
 * `buildInvocationSpecs` is called again, with the same params, on every
 * resume of an `awaiting_approval` step (algorithm step 6) — it is REQUIRED
 * to be deterministic/idempotent for the same inputs (same RESULT each
 * call), mirroring the exact assumption `executeRun` already makes about
 * its own `invocationSpecs` argument across repeated calls. This unit's own
 * approval-gated test fixture performs a database write on every call (to
 * bind an agent to the run — see below) but writes the exact same values
 * every time, so it is idempotent-by-RESULT even though not side-effect-free
 * — that distinction is deliberate and is the only viable shape a real
 * builder for an approval-gated step can take, given the constraints below.
 *
 * ---------------------------------------------------------------------------
 * Deviation from the brief's literal algorithm step 4 (documented, not
 * silently "resolved as written")
 * ---------------------------------------------------------------------------
 * The brief's prose for finding "the current step" says: "the first index
 * whose taskInstanceId is null, OR — if all are non-null — check the LAST
 * step's Task Instance status". Taken completely literally, a run in state
 * `[id0, null]` (step 0 still `awaiting_approval`, step 1 never started)
 * would identify index 1 (the first null) as "the step to create" — which
 * would create step 2's Task Instance while step 1 hasn't reached
 * `completed`, directly violating the brief's own required test ("does not
 * create step 2's Task Instance until step 1 reaches completed") and the
 * algorithm's own steps 8-11 (which gate creating the next step behind the
 * CURRENT one reaching `completed`).
 *
 * The correct, internally-consistent reading — confirmed against steps
 * 8-11's state machine — is: find the LAST NON-NULL step (not the first
 * null one), inspect THAT Task Instance's status, and only create the next
 * step when it is `completed`. This subsumes the brief's explicit
 * "all-non-null -> check the last step" case (the last non-null step IS the
 * last step in the graph) and additionally covers every earlier-step case
 * the literal step-4 text under-specifies. `advanceWorkflowRun` below
 * implements this corrected version. `tests/workflow/interpreter.test.ts`'s
 * step-gating test drives this exact `[id0, null]` state (step 0 sitting at
 * `awaiting_approval`) through a normal, non-paused `advanceWorkflowRun`
 * call and asserts both the resulting Task Instance count AND the sequence
 * of `taskDefinitionId`s the builder was invoked with, to pin this
 * corrected behavior against a regression back to "first null index".
 *
 * ---------------------------------------------------------------------------
 * Other documented choices
 * ---------------------------------------------------------------------------
 * - Malformed/wrong-shape `graph_definition`: fails closed via
 *   `isLinearGraphDefinition` (see graphTypes.ts) — throws, never coerces.
 * - A workflow-created step's Task Instance `input` is always `{}`: no
 *   variable-passing/mapping mechanism exists in this unit's frozen
 *   interfaces (workflow_runs.variables is reserved for step bookkeeping
 *   per Ruling 1, and InvocationSpecBuilder's params carry only
 *   taskDefinitionId/Version, taskInstanceId, and input). A future unit
 *   wanting to pass prior-step output into the next step's input needs a
 *   real mapping spec this unit does not attempt to invent.
 * - `pauseWorkflowRun` is valid only from `"in_progress"` (throws otherwise,
 *   including when already `"paused"` or terminal) — fail-closed/explicit,
 *   consistent with this codebase's general convention (e.g. graph-shape
 *   validation) of refusing ambiguous states rather than silently no-oping.
 * - `resumeWorkflowRun` is valid only from `"paused"` (throws otherwise) —
 *   the brief explicitly permits either choice; throwing was picked for the
 *   same fail-closed consistency reason.
 * - `RunOutcome.status === "awaiting_approval"` maps to
 *   `{status: "in_progress"}` at the Workflow Run level (algorithm step 11):
 *   the Workflow Run itself is not paused, only its current step's Run is
 *   waiting. A caller wanting to distinguish "genuinely advancing" from
 *   "blocked on approval" checks the Task Instance/Approval state directly
 *   — `advanceWorkflowRun`'s return type has no separate value for this by
 *   design (frozen interface).
 * - The `runs` row created for a workflow step (in `createAndRunStep`) is
 *   inserted with ONLY `taskInstanceId` and `status: "active"` —
 *   `agentDefinitionId`/`agentDefinitionVersion` are left null. This module
 *   has no channel to learn that binding: `InvocationSpecBuilder`'s frozen
 *   signature carries no `tx` and no agent-binding field, and
 *   `startWorkflowRun`/`advanceWorkflowRun`'s own frozen signatures carry
 *   nothing either. CONSEQUENCE (a real constraint on the step planner, not
 *   just a note): a "tool" InvocationSpec built for a workflow step CANNOT
 *   be authorized by `resolveCapabilityGrant` (Unit 6) unless something
 *   binds `runs.agentDefinitionId`/`Version` for that run before
 *   `executeRun` processes it — and the ONLY hook available at the right
 *   moment (after the run row exists, before `executeRun` is called) is the
 *   `buildInvocationSpecs` closure itself, via whatever `tx`/context it
 *   closes over. This module's own tests exercise exactly that pattern to
 *   drive a step to `awaiting_approval`.
 * - `createAndRunStep` writes `workflow_runs.variables` once, immediately after
 *   creating the `runs` row and before calling `buildInvocationSpecs`/`executeRun`.
 *   The only other write is `startRetryRun` (retry policy, 2026-09-15), which
 *   points the step's `stepRunIds` slot at the retry Run; it runs after the
 *   failed attempt, possibly in the same call.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { goals, runs, taskInstances, workflowDefinitions, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { createWorkflowTaskInstance } from "../execution/taskInstance.js";
import { executeRun, isSettleableStepFailure, settleRunAfterStepFailure } from "../execution/executor.js";
import type { PendingDispatch, PlannedInvocationSpec, RunOutcome } from "../execution/types.js";
import {
  emitLifecycleEvent,
  NO_CORRELATION,
  recordTaskInstanceTransition,
  type Correlation,
} from "../events/lifecycle.js";
import { isLinearGraphDefinition, type LinearGraphDefinition } from "./graphTypes.js";
import { decideRetry, type RetryDecision } from "../governance/retryPolicy.js";

/**
 * Ruling 3's required extension to the brief's frozen `advanceWorkflowRun`
 * signature — see module header for the full rationale. Given a step's
 * Task-Definition identity and its freshly-created (or resumed) Task
 * Instance, produces the `InvocationSpec[]` Unit 6's `executeRun` will run.
 * MUST be deterministic/idempotent for the same inputs (called again,
 * unchanged, on every resume of an `awaiting_approval` step).
 *
 * Returns `PlannedInvocationSpec[]`, not `InvocationSpec[]` (final-review
 * Finding 4): an individual position may be a thunk the Executor resolves
 * against earlier positions' actual Artifact ids — see
 * `../execution/types.js`'s `DeferredInvocationSpec`. This widening is a
 * CONSEQUENCE of the Executor's parameter type, not a change to this module's
 * role: the builder is still called exactly ONCE per step, still returns that
 * step's whole plan up front, and the plan's length and order are still fixed
 * before `executeRun` runs. Nothing about WHICH steps run, or in what order,
 * moves out of this module.
 */
export type InvocationSpecBuilder = (params: {
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  taskInstanceId: string;
  input: Record<string, unknown>;
}) => Promise<PlannedInvocationSpec[]>;

/**
 * `dispatch_required` (Phase 9): the current step's Run yielded at an LLM or
 * Tool Invocation committed as `executing`. The caller must commit this
 * transaction, dispatch with no transaction open, record the outcome, then
 * advance again. See `./advanceWorkflowRunUntilBlocked.ts`, the driver that
 * does exactly that.
 */
export type AdvanceResult =
  | { status: "in_progress" | "completed" | "failed" | "paused" }
  | { status: "dispatch_required"; dispatch: PendingDispatch };
type WorkflowRunRow = typeof workflowRuns.$inferSelect;

// ---------------------------------------------------------------------------
// workflow_runs.variables bookkeeping (Ruling 1 + the stepRunIds extension)
// ---------------------------------------------------------------------------

type StepBookkeeping = { stepTaskInstanceIds: (string | null)[]; stepRunIds: (string | null)[] };

function isIdArray(value: unknown): value is (string | null)[] {
  return Array.isArray(value) && value.every((id) => id === null || typeof id === "string");
}

function isStepBookkeeping(value: unknown): value is StepBookkeeping {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isIdArray(v.stepTaskInstanceIds) && isIdArray(v.stepRunIds);
}

function readBookkeeping(variables: Record<string, unknown> | null): StepBookkeeping {
  if (!isStepBookkeeping(variables)) {
    throw new Error(
      "advanceWorkflowRun: workflow_runs.variables.stepTaskInstanceIds/stepRunIds is missing or malformed — " +
        "expected arrays of (string|null) as initialized by startWorkflowRun (fail closed)."
    );
  }
  return variables;
}

/** Ruling 2: explicit, exhaustive mapping — see module header for why this is not a bare `outcome.status` copy. */
function mapRunOutcomeToTaskInstanceStatus(
  status: RunOutcome["status"]
): "completed" | "failed" | "awaiting_approval" | "active" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "awaiting_approval":
      return "awaiting_approval";
    // The step's Run is mid-Invocation (Phase 9): spec §3d's `active`.
    case "dispatch_required":
    case "in_flight":
      return "active";
  }
}

export async function loadGraphDefinition(
  tx: DrizzleTransaction,
  workflowDefinitionId: string,
  workflowDefinitionVersion: number
): Promise<LinearGraphDefinition> {
  const row = await tx.query.workflowDefinitions.findFirst({
    where: and(eq(workflowDefinitions.id, workflowDefinitionId), eq(workflowDefinitions.version, workflowDefinitionVersion)),
  });
  if (!row) {
    throw new Error(
      `advanceWorkflowRun: no workflow_definitions row found for id "${workflowDefinitionId}" version ${workflowDefinitionVersion}`
    );
  }
  if (!isLinearGraphDefinition(row.graphDefinition)) {
    throw new Error(
      `advanceWorkflowRun: workflow_definitions "${workflowDefinitionId}" v${workflowDefinitionVersion} has a ` +
        "graph_definition that is not a valid LinearGraphDefinition (fail closed — never silently coerced)."
    );
  }
  return row.graphDefinition;
}

// ---------------------------------------------------------------------------
// startWorkflowRun
// ---------------------------------------------------------------------------

export async function startWorkflowRun(
  tx: DrizzleTransaction,
  workflowDefinitionId: string,
  goalId: string
): Promise<{ workflowRunId: string }> {
  const definition = await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.id, workflowDefinitionId) });
  if (!definition) {
    throw new Error(`startWorkflowRun: no workflow_definitions row found for id "${workflowDefinitionId}"`);
  }
  if (!isLinearGraphDefinition(definition.graphDefinition)) {
    throw new Error(
      `startWorkflowRun: workflow_definitions "${workflowDefinitionId}" has a graph_definition that is not a ` +
        "valid LinearGraphDefinition (fail closed)."
    );
  }

  const goal = await tx.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!goal) {
    throw new Error(`startWorkflowRun: no goals row found for id "${goalId}"`);
  }

  const stepCount = definition.graphDefinition.steps.length;
  const stepTaskInstanceIds: (string | null)[] = new Array(stepCount).fill(null);
  const stepRunIds: (string | null)[] = new Array(stepCount).fill(null);

  const [row] = await tx
    .insert(workflowRuns)
    .values({
      workflowDefinitionId: definition.id,
      workflowDefinitionVersion: definition.version,
      goalId,
      status: "in_progress",
      variables: { stepTaskInstanceIds, stepRunIds },
    })
    .returning();

  await emitLifecycleEvent(tx, {
    eventType: "workflow_run_started",
    subjectId: row!.id,
    correlation: { ...NO_CORRELATION, goalId, workflowRunId: row!.id },
    producer: "workflow-interpreter",
    payload: { workflowDefinitionId: definition.id, workflowDefinitionVersion: definition.version },
  });
  // A new unfinished Workflow Run makes a finished Goal active again (R-GOAL1).
  await recordGoalStatus(tx, goalId, row!.id, { ...NO_CORRELATION, goalId, workflowRunId: row!.id });
  return { workflowRunId: row!.id };
}

// ---------------------------------------------------------------------------
// pauseWorkflowRun / resumeWorkflowRun
// ---------------------------------------------------------------------------

/** No Workflow Run has this id. Typed so the API can answer 404 rather than 500. */
export class WorkflowRunNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunNotFoundError";
  }
}

/** The Workflow Run exists but is not in the state the operation requires. Typed so the API can answer 409. */
export class WorkflowRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunStateError";
  }
}

export async function pauseWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<void> {
  const row = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!row) {
    throw new WorkflowRunNotFoundError(`pauseWorkflowRun: no workflow_runs row found for id "${workflowRunId}"`);
  }
  if (row.status !== "in_progress") {
    throw new WorkflowRunStateError(
      `pauseWorkflowRun: workflow_run "${workflowRunId}" is not "in_progress" (status="${row.status}") — ` +
        "pause is only valid from \"in_progress\" (documented choice, see module header)."
    );
  }
  // Conditional on the status just checked: without it, a pause racing an
  // advance that is finishing this Workflow Run would wait for the advance's
  // row lock, then overwrite its `completed`/`failed` with `paused`.
  const updated = await tx
    .update(workflowRuns)
    .set({ status: "paused" })
    .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "in_progress")))
    .returning({ id: workflowRuns.id });
  if (updated.length === 0) {
    throw new WorkflowRunStateError(
      `pauseWorkflowRun: workflow_run "${workflowRunId}" stopped being "in_progress" before it could be paused.`
    );
  }
  await recordPauseTransition(tx, "workflow_run_paused", row.id, row.goalId);
}

/**
 * `workflow_run_paused` / `workflow_run_resumed` (operator decision R-EV1, spec §3e),
 * same transaction as the status write. A Workflow Run can be paused and resumed many
 * times, so each emission has its own key. Only the operator's routes pause or resume.
 */
async function recordPauseTransition(
  tx: DrizzleTransaction,
  eventType: "workflow_run_paused" | "workflow_run_resumed",
  workflowRunId: string,
  goalId: string
): Promise<void> {
  await emitLifecycleEvent(tx, {
    eventType,
    subjectId: workflowRunId,
    idempotencyKey: `${eventType}:${workflowRunId}:${randomUUID()}`,
    correlation: { ...NO_CORRELATION, goalId, workflowRunId },
    producer: "workflow-interpreter",
    actor: "human:operator",
    payload:
      eventType === "workflow_run_paused" ? { from: "in_progress", to: "paused" } : { from: "paused", to: "in_progress" },
  });
}

export async function resumeWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<void> {
  const row = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!row) {
    throw new WorkflowRunNotFoundError(`resumeWorkflowRun: no workflow_runs row found for id "${workflowRunId}"`);
  }
  if (row.status !== "paused") {
    throw new WorkflowRunStateError(
      `resumeWorkflowRun: workflow_run "${workflowRunId}" is not "paused" (status="${row.status}") — ` +
        "resume is only valid from \"paused\" (documented choice, see module header)."
    );
  }
  const updated = await tx
    .update(workflowRuns)
    .set({ status: "in_progress" })
    .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "paused")))
    .returning({ id: workflowRuns.id });
  if (updated.length === 0) {
    throw new WorkflowRunStateError(
      `resumeWorkflowRun: workflow_run "${workflowRunId}" stopped being "paused" before it could be resumed.`
    );
  }
  await recordPauseTransition(tx, "workflow_run_resumed", row.id, row.goalId);
}

// ---------------------------------------------------------------------------
// advanceWorkflowRun and its helpers
// ---------------------------------------------------------------------------

/** The step being resolved, with everything its lifecycle events are correlated by. */
type StepRef = { workflowRunId: string; goalId: string; taskInstanceId: string; runId: string };

function stepCorrelation(step: StepRef): Correlation {
  return { goalId: step.goalId, workflowRunId: step.workflowRunId, taskInstanceId: step.taskInstanceId, runId: step.runId, invocationId: null };
}

/** Terminal Workflow Run status + its §8.2 event, same transaction. Correlated to the Run that ended it. */
async function finishWorkflowRun(tx: DrizzleTransaction, step: StepRef, status: "completed" | "failed"): Promise<void> {
  await tx.update(workflowRuns).set({ status, completedAt: new Date() }).where(eq(workflowRuns.id, step.workflowRunId));
  await emitLifecycleEvent(tx, {
    eventType: status === "completed" ? "workflow_run_completed" : "workflow_run_failed",
    subjectId: step.workflowRunId,
    correlation: stepCorrelation(step),
    producer: "workflow-interpreter",
  });
  await recordGoalStatus(tx, step.goalId, step.workflowRunId, stepCorrelation(step));
}

export type GoalStatus = "active" | "completed" | "failed";

/**
 * A Goal's status, derived from its Workflow Runs' statuses (operator decision R-GOAL1):
 * `active` while it has no Workflow Run or any of them is not finished (`in_progress`,
 * `paused`); once every one has finished, `completed` if every one completed, otherwise
 * `failed`.
 */
export function deriveGoalStatus(workflowRunStatuses: readonly string[]): GoalStatus {
  const finished = (s: string) => s === "completed" || s === "failed";
  if (workflowRunStatuses.length === 0 || !workflowRunStatuses.every(finished)) return "active";
  return workflowRunStatuses.every((s) => s === "completed") ? "completed" : "failed";
}

/**
 * Re-derives a Goal's status after one of its Workflow Runs started or finished, and
 * records a change as `goal_completed`, `goal_failed` or `goal_transitioned` in the same
 * transaction (§3e). A no-op when the derived status is unchanged; returns whether it
 * changed. Keyed by the Workflow Run that caused it, since a Goal can change status more
 * than once. `backfill` marks the one-time repair in `backfillGoalStatuses`.
 */
async function recordGoalStatus(
  tx: DrizzleTransaction,
  goalId: string,
  workflowRunId: string | null,
  correlation: Correlation,
  backfill = false
): Promise<boolean> {
  const goal = await tx.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!goal) return false;
  const statuses = await tx.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.goalId, goalId));
  const to = deriveGoalStatus(statuses.map((r) => r.status));
  if (to === goal.status) return false;

  await tx.update(goals).set({ status: to }).where(eq(goals.id, goalId));
  const eventType = to === "completed" ? "goal_completed" : to === "failed" ? "goal_failed" : "goal_transitioned";
  await emitLifecycleEvent(tx, {
    eventType,
    subjectId: goalId,
    idempotencyKey: backfill ? `${eventType}:${goalId}:backfill:${workflowRunId ?? "none"}` : `${eventType}:${goalId}:${workflowRunId}`,
    correlation,
    producer: backfill ? "goal-status-backfill" : "workflow-interpreter",
    payload: { from: goal.status, to, workflowRunId, ...(backfill ? { backfill: true } : {}) },
  });
  return true;
}

/**
 * One-time repair (CLI2 QA finding M1): Goals whose Workflow Runs finished before R-GOAL1
 * was built still read `active`. Re-derives every Goal with the same rule and records each
 * stale one through `recordGoalStatus`, as a `goal-status-backfill` event dated now, so the
 * status is repaired without back-dating history. Writes only stale `goals.status` values
 * and their events, never a Workflow Run. Idempotent: a second pass finds nothing stale.
 * Goal rows are locked first, so a concurrent Workflow Run finish waits for it (this takes
 * no Workflow Run lock, so no cycle). Returns the ids of the Goals it changed.
 */
export async function backfillGoalStatuses(tx: DrizzleTransaction): Promise<string[]> {
  const all = await tx.select({ id: goals.id }).from(goals).orderBy(goals.createdAt, goals.id).for("update");
  const changed: string[] = [];
  for (const { id } of all) {
    const [latest] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.goalId, id))
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(1);
    const workflowRunId = latest?.id ?? null;
    if (await recordGoalStatus(tx, id, workflowRunId, { ...NO_CORRELATION, goalId: id, workflowRunId }, true)) changed.push(id);
  }
  return changed;
}

/**
 * Retries the step (spec §3d): a NEW Run against the same Task Instance, which stays
 * unfinished, so its history is not mutated. The retry policy decided it
 * (`../governance/retryPolicy.ts`), including any tier floor for §10.4 escalation. The
 * new Run is executed by the next advance, as a resumed step.
 */
async function startRetryRun(
  tx: DrizzleTransaction,
  step: StepRef,
  retry: Extract<RetryDecision, { retry: true }>
): Promise<AdvanceResult> {
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, step.taskInstanceId) });
  if (taskInstance && taskInstance.status !== "active") {
    await tx.update(taskInstances).set({ status: "active", updatedAt: new Date() }).where(eq(taskInstances.id, step.taskInstanceId));
    await recordTaskInstanceTransition(tx, {
      taskInstanceId: step.taskInstanceId,
      from: taskInstance.status,
      to: "active",
      correlation: stepCorrelation(step),
      producer: "workflow-interpreter",
    });
  }

  const [runRow] = await tx
    .insert(runs)
    .values({ taskInstanceId: step.taskInstanceId, status: "active", attempt: retry.attempt, minimumModelTier: retry.minimumModelTier })
    .returning();
  const retryStep: StepRef = { ...step, runId: runRow!.id };
  await emitLifecycleEvent(tx, {
    eventType: "run_started",
    subjectId: retryStep.runId,
    correlation: stepCorrelation(retryStep),
    producer: "workflow-interpreter",
    payload: { attempt: retry.attempt, retryOfRunId: step.runId, cause: retry.cause, minimumModelTier: retry.minimumModelTier },
  });

  // The step's current Run is now the retry (Ruling 1's stepRunIds extension).
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, step.workflowRunId) });
  const bookkeeping = readBookkeeping(workflowRun?.variables ?? null);
  const stepIndex = bookkeeping.stepTaskInstanceIds.indexOf(step.taskInstanceId);
  if (stepIndex === -1) {
    throw new Error(`advanceWorkflowRun: task_instance "${step.taskInstanceId}" has no step slot in workflow_run "${step.workflowRunId}".`);
  }
  const stepRunIds = [...bookkeeping.stepRunIds];
  stepRunIds[stepIndex] = retryStep.runId;
  await tx
    .update(workflowRuns)
    .set({ variables: { ...(workflowRun!.variables ?? {}), stepRunIds } })
    .where(eq(workflowRuns.id, step.workflowRunId));
  return { status: "in_progress" };
}

async function resolveStepOutcome(
  tx: DrizzleTransaction,
  step: StepRef,
  isLastStep: boolean,
  outcome: RunOutcome
): Promise<AdvanceResult> {
  if (outcome.status === "failed") {
    const retry = await decideRetry(tx, step.taskInstanceId, step.runId);
    if (retry.retry) return startRetryRun(tx, step, retry);
  }

  const taskInstanceStatus = mapRunOutcomeToTaskInstanceStatus(outcome.status);
  const previous = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, step.taskInstanceId) });
  await tx
    .update(taskInstances)
    .set({ status: taskInstanceStatus, updatedAt: new Date() })
    .where(eq(taskInstances.id, step.taskInstanceId));
  await recordTaskInstanceTransition(tx, {
    taskInstanceId: step.taskInstanceId,
    from: previous?.status ?? null,
    to: taskInstanceStatus,
    correlation: stepCorrelation(step),
    producer: "workflow-interpreter",
  });

  if (outcome.status === "completed") {
    if (isLastStep) {
      await finishWorkflowRun(tx, step, "completed");
      return { status: "completed" };
    }
    // Step 9: do NOT create the next step's Task Instance within this same
    // call — a subsequent advanceWorkflowRun call does that.
    return { status: "in_progress" };
  }

  if (outcome.status === "failed") {
    await finishWorkflowRun(tx, step, "failed");
    return { status: "failed" };
  }

  if (outcome.status === "dispatch_required") {
    return { status: "dispatch_required", dispatch: outcome.dispatch };
  }

  // "awaiting_approval" (step 11) — see module header's documented choice — or
  // "in_flight" (another caller is dispatching this step right now).
  return { status: "in_progress" };
}

/**
 * Applies a Run's terminal FAILURE to its Workflow step, outside a normal
 * advance — for a Run failed by interruption recovery (Phase 9), which happens
 * at startup with no builder and no advance in progress. Without this, a
 * recovered Workflow Run would sit `in_progress` with nothing left to drive it.
 *
 * Mirrors what `advanceWorkflowRun` records for a failed step (Ruling 2: this
 * module is what writes Task Instance status). A no-op for a standalone Task
 * Instance, a Run that has not failed, or a Workflow Run already terminal.
 */
export async function settleWorkflowStepForFailedRun(tx: DrizzleTransaction, runId: string): Promise<void> {
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run || run.status !== "failed") return;
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
  if (!taskInstance?.workflowRunId) return;

  const [workflowRun] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, taskInstance.workflowRunId))
    .for("update");
  if (!workflowRun) return;
  // A retryable failure leaves the Task Instance and Workflow Run unfinished: the
  // startup re-drive (or the operator's resume of a paused run) then starts the retry
  // through the ordinary advance, where every check runs again.
  if ((await decideRetry(tx, taskInstance.id, runId)).retry) return;
  const step: StepRef = {
    workflowRunId: workflowRun.id,
    goalId: workflowRun.goalId,
    taskInstanceId: taskInstance.id,
    runId,
  };
  await tx.update(taskInstances).set({ status: "failed", updatedAt: new Date() }).where(eq(taskInstances.id, taskInstance.id));
  await recordTaskInstanceTransition(tx, {
    taskInstanceId: taskInstance.id,
    from: taskInstance.status,
    to: "failed",
    correlation: stepCorrelation(step),
    producer: "workflow-interpreter",
  });
  if (workflowRun.status !== "completed" && workflowRun.status !== "failed") {
    await finishWorkflowRun(tx, step, "failed");
  }
}

/**
 * Builds a step's specs and executes its Run, recording a failure of either as
 * the step's outcome instead of leaving the Workflow Run stuck.
 *
 * Without this, a builder or Executor throw rolled back the whole advance: a
 * step waiting on an Approval kept its budget hold, and every later advance —
 * including the approval, the TTL sweep and the startup re-drive — repeated the
 * same throw forever (DURABLE_EXECUTION §4.2).
 *
 * The attempt runs in a SAVEPOINT, so a throw undoes exactly what the attempt
 * did and leaves this transaction usable. A settleable error is then recorded
 * by `settleRunAfterStepFailure` and the step resolves as failed; the Workflow
 * Run fails with it. A transient database error, or a Run this process is still
 * dispatching, is rethrown unchanged: the next advance may succeed.
 */
async function executeStepSettlingFailures(
  tx: DrizzleTransaction,
  step: StepRef,
  isLastStep: boolean,
  build: () => Promise<PlannedInvocationSpec[]>
): Promise<AdvanceResult> {
  // A uniquely named savepoint rather than drizzle's nested `tx.transaction`,
  // whose savepoints are named by depth (`sp1`, …): any nested savepoint taken
  // inside the step would share that name, and ROLLBACK TO would then undo only
  // back to the inner one. Statements run on the outer `tx`, which the builder
  // and its specs close over; a savepoint covers the whole connection.
  let outcome: RunOutcome;
  await tx.execute(sql.raw(`savepoint ${STEP_ATTEMPT_SAVEPOINT}`));
  try {
    outcome = await executeRun(tx, step.runId, await build());
  } catch (error) {
    if (!isSettleableStepFailure(error)) throw error;
    await tx.execute(sql.raw(`rollback to savepoint ${STEP_ATTEMPT_SAVEPOINT}`));
    const settlement = await settleRunAfterStepFailure(tx, step.runId, error);
    if (settlement.kind === "in_flight") throw error;
    // eslint-disable-next-line no-console
    console.error(`advanceWorkflowRun: step for run "${step.runId}" failed and was settled:`, error);
    outcome = { status: settlement.status, runId: step.runId };
  }
  await tx.execute(sql.raw(`release savepoint ${STEP_ATTEMPT_SAVEPOINT}`));
  return resolveStepOutcome(tx, step, isLastStep, outcome);
}

const STEP_ATTEMPT_SAVEPOINT = "step_attempt";

/** Algorithm step 5: create a NEW step's Task Instance + Run, then run it fresh. */
async function createAndRunStep(
  tx: DrizzleTransaction,
  workflowRun: WorkflowRunRow,
  graph: LinearGraphDefinition,
  stepIndex: number,
  bookkeeping: StepBookkeeping,
  buildInvocationSpecs: InvocationSpecBuilder
): Promise<AdvanceResult> {
  const step = graph.steps[stepIndex]!;

  // The workflow-path creator, never the standalone one — see module header / structural test.
  const { taskInstanceId } = await createWorkflowTaskInstance(tx, step.taskDefinitionId, workflowRun.id, {});

  const [runRow] = await tx.insert(runs).values({ taskInstanceId, status: "active" }).returning();
  const runId = runRow!.id;

  const stepRef: StepRef = { workflowRunId: workflowRun.id, goalId: workflowRun.goalId, taskInstanceId, runId };
  await emitLifecycleEvent(tx, {
    eventType: "task_instance_created",
    subjectId: taskInstanceId,
    correlation: stepCorrelation(stepRef),
    producer: "workflow-interpreter",
    payload: { taskDefinitionId: step.taskDefinitionId, taskDefinitionVersion: step.taskDefinitionVersion, stepIndex },
  });
  await emitLifecycleEvent(tx, {
    eventType: "run_started",
    subjectId: runId,
    correlation: stepCorrelation(stepRef),
    producer: "workflow-interpreter",
  });

  // Single write of both bookkeeping arrays together — see module header's
  // "writes variables exactly ONCE per call" note.
  const updatedTaskInstanceIds = [...bookkeeping.stepTaskInstanceIds];
  updatedTaskInstanceIds[stepIndex] = taskInstanceId;
  const updatedRunIds = [...bookkeeping.stepRunIds];
  updatedRunIds[stepIndex] = runId;
  await tx
    .update(workflowRuns)
    .set({
      variables: {
        ...(workflowRun.variables ?? {}),
        stepTaskInstanceIds: updatedTaskInstanceIds,
        stepRunIds: updatedRunIds,
      },
    })
    .where(eq(workflowRuns.id, workflowRun.id));

  return executeStepSettlingFailures(tx, stepRef, stepIndex === graph.steps.length - 1, () =>
    buildInvocationSpecs({
      taskDefinitionId: step.taskDefinitionId,
      taskDefinitionVersion: step.taskDefinitionVersion,
      taskInstanceId,
      input: {},
    })
  );
}

/** Algorithm step 6: resume the EXISTING Run for a step whose Task Instance already exists and is non-terminal. */
async function resumeStep(
  tx: DrizzleTransaction,
  workflowRun: WorkflowRunRow,
  graph: LinearGraphDefinition,
  stepIndex: number,
  taskInstanceId: string,
  runId: string,
  buildInvocationSpecs: InvocationSpecBuilder
): Promise<AdvanceResult> {
  const step = graph.steps[stepIndex]!;

  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) });
  if (!taskInstance) {
    throw new Error(`advanceWorkflowRun: no task_instances row found for id "${taskInstanceId}"`);
  }

  // Resuming the SAME runId stored at creation time (Ruling 1's
  // stepRunIds extension) — never re-derived via a taskInstanceId lookup,
  // which would be nondeterministic without a unique index. See module header.
  return executeStepSettlingFailures(
    tx,
    { workflowRunId: workflowRun.id, goalId: workflowRun.goalId, taskInstanceId, runId },
    stepIndex === graph.steps.length - 1,
    // Called again, deliberately, with the same params — see InvocationSpecBuilder's doc comment.
    () =>
      buildInvocationSpecs({
        taskDefinitionId: step.taskDefinitionId,
        taskDefinitionVersion: step.taskDefinitionVersion,
        taskInstanceId,
        input: (taskInstance.input as Record<string, unknown> | null) ?? {},
      })
  );
}

export async function advanceWorkflowRun(
  tx: DrizzleTransaction,
  workflowRunId: string,
  buildInvocationSpecs: InvocationSpecBuilder
): Promise<AdvanceResult> {
  // Locked for the whole advance (Phase 9). A request no longer holds one
  // transaction end to end, so two concurrent advances of the same Workflow
  // Run could otherwise both read an unfilled step slot and create two Task
  // Instances for it. The second waits, then reads the first's committed
  // bookkeeping. Lock order: this row before any Run/Invocation row.
  const [workflowRun] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).for("update");
  if (!workflowRun) {
    throw new Error(`advanceWorkflowRun: no workflow_runs row found for id "${workflowRunId}"`);
  }

  // Algorithm steps 1-2: paused/terminal short-circuits — idempotent on repeated calls.
  if (workflowRun.status === "paused") return { status: "paused" };
  if (workflowRun.status === "completed") return { status: "completed" };
  if (workflowRun.status === "failed") return { status: "failed" };

  const graph = await loadGraphDefinition(tx, workflowRun.workflowDefinitionId, workflowRun.workflowDefinitionVersion);
  const bookkeeping = readBookkeeping(workflowRun.variables);
  const { stepTaskInstanceIds, stepRunIds } = bookkeeping;

  if (stepTaskInstanceIds.length !== graph.steps.length || stepRunIds.length !== graph.steps.length) {
    throw new Error(
      `advanceWorkflowRun: workflow_run "${workflowRunId}"'s bookkeeping array lengths ` +
        `(taskInstanceIds=${stepTaskInstanceIds.length}, runIds=${stepRunIds.length}) do not match its graph's ` +
        `step count (${graph.steps.length}).`
    );
  }

  const lastIndex = graph.steps.length - 1;

  // Find the last non-null (i.e. already-started) step — see module header's
  // "Deviation from the brief's literal algorithm step 4" note for why this,
  // rather than "the first null index", is the correct current-step pointer.
  let lastFilledIndex = -1;
  for (let i = 0; i < stepTaskInstanceIds.length; i++) {
    if (stepTaskInstanceIds[i] !== null) {
      lastFilledIndex = i;
    } else {
      break; // steps fill strictly left-to-right; a null here means nothing after it is filled either
    }
  }

  if (lastFilledIndex === -1) {
    // No step has started yet — algorithm step 5, for step 0.
    return createAndRunStep(tx, workflowRun, graph, 0, bookkeeping, buildInvocationSpecs);
  }

  const currentTaskInstanceId = stepTaskInstanceIds[lastFilledIndex]!;
  const currentRunId = stepRunIds[lastFilledIndex];
  if (!currentRunId) {
    throw new Error(
      `advanceWorkflowRun: workflow_run "${workflowRunId}" has stepTaskInstanceIds[${lastFilledIndex}] set but ` +
        `stepRunIds[${lastFilledIndex}] is null — inconsistent bookkeeping (both are always written together).`
    );
  }

  const currentTaskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, currentTaskInstanceId) });
  if (!currentTaskInstance) {
    throw new Error(`advanceWorkflowRun: no task_instances row found for id "${currentTaskInstanceId}" (step ${lastFilledIndex}).`);
  }

  if (currentTaskInstance.status === "completed") {
    if (lastFilledIndex === lastIndex) {
      // Algorithm step 4's "all non-null, last step completed" case.
      await finishWorkflowRun(
        tx,
        { workflowRunId, goalId: workflowRun.goalId, taskInstanceId: currentTaskInstanceId, runId: currentRunId },
        "completed"
      );
      return { status: "completed" };
    }
    // This step is done and it wasn't the last one — a NEW advanceWorkflowRun
    // call (this one) creates the next step (algorithm step 5).
    return createAndRunStep(tx, workflowRun, graph, lastFilledIndex + 1, bookkeeping, buildInvocationSpecs);
  }

  if (currentTaskInstance.status === "failed") {
    // Algorithm step 4's "all non-null, last step failed" case, generalized:
    // a failure at ANY step halts the whole Workflow Run immediately.
    await finishWorkflowRun(
      tx,
      { workflowRunId, goalId: workflowRun.goalId, taskInstanceId: currentTaskInstanceId, runId: currentRunId },
      "failed"
    );
    return { status: "failed" };
  }

  // The step's current Run already failed (a dispatch recorded its failure, or the
  // startup sweep settled it and left a retryable Task Instance unfinished): resolve
  // the failure — retry or finish — without building a plan for a Run that is over.
  const currentRun = await tx.query.runs.findFirst({ where: eq(runs.id, currentRunId) });
  if (currentRun?.status === "failed") {
    return resolveStepOutcome(
      tx,
      { workflowRunId, goalId: workflowRun.goalId, taskInstanceId: currentTaskInstanceId, runId: currentRunId },
      lastFilledIndex === lastIndex,
      { status: "failed", runId: currentRunId }
    );
  }

  // Non-terminal (e.g. "awaiting_approval") — resume the existing step's Run,
  // never create a new Task Instance for it (algorithm step 6).
  return resumeStep(tx, workflowRun, graph, lastFilledIndex, currentTaskInstanceId, currentRunId, buildInvocationSpecs);
}

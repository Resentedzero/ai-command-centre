/**
 * Lifecycle and accounting events (spec §8.2): the facts that make Workflow
 * Runs, Task Instances, Runs, Artifacts and budget consumption reconstructible
 * from the immutable log, as §3e/§8 require ("current state is a
 * same-transaction projection over those events").
 *
 * Every helper here is called in the SAME transaction as the status/counter
 * write it records — never before, never after.
 *
 * Correlation is filled as completely as the emitter can know it. Events about
 * a step (Task Instance, Run, the Workflow Run's terminal state) are correlated
 * to the step's RUN, so they share that Run's per-run `sequence_no` and take
 * only that Run's event advisory lock — not the global null-run bucket, which
 * would add a lock shared across every Run to transactions already holding
 * per-run locks. Of the events in this module, only `goal_created` and
 * `workflow_run_started` (which precede any Run) use the null-run sequence in
 * practice; `budget_consumed` falls back to it only for a reservation with no
 * run hold, which no current caller makes. Elsewhere, `capability_grant_revoked`
 * and the emergency-stop events use it by design.
 *
 * Idempotency keys are `<eventType>:<subjectId>` for events that can happen
 * once per subject. `task_instance_transitioned` can recur (e.g. active ->
 * awaiting_approval twice in one Run), so its key is unique per emission; its
 * callers emit it only when the status actually changes.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runs, taskInstances, workflowRuns } from "../db/schema.js";
import { emitEvent, type DrizzleTransaction } from "./emit.js";
import type { EventEnvelope } from "./types.js";

export type Correlation = EventEnvelope["correlation"];

export const NO_CORRELATION: Correlation = {
  goalId: null,
  workflowRunId: null,
  taskInstanceId: null,
  runId: null,
  invocationId: null,
};

/** Full correlation for anything scoped to a Run: run -> task instance -> workflow run -> goal. Tolerates missing rows. */
export async function correlationForRun(
  tx: DrizzleTransaction,
  runId: string,
  invocationId: string | null = null
): Promise<Correlation> {
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  const taskInstance = run
    ? await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) })
    : undefined;
  const workflowRun = taskInstance?.workflowRunId
    ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) })
    : undefined;
  return {
    goalId: workflowRun?.goalId ?? null,
    workflowRunId: taskInstance?.workflowRunId ?? null,
    taskInstanceId: run?.taskInstanceId ?? null,
    runId,
    invocationId,
  };
}

export async function emitLifecycleEvent(
  tx: DrizzleTransaction,
  input: {
    eventType: string;
    /** The entity the event is about; forms the default idempotency key. */
    subjectId: string;
    correlation: Correlation;
    producer: string;
    actor?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }
): Promise<void> {
  await emitEvent(tx, {
    idempotencyKey: input.idempotencyKey ?? `${input.eventType}:${input.subjectId}`,
    eventType: input.eventType,
    eventVersion: 1,
    causationId: null,
    correlation: input.correlation,
    actor: input.actor ?? "system",
    producer: input.producer,
    payload: input.payload ?? {},
    usage: null,
  });
}

/**
 * Records a Task Instance status change: `task_instance_completed`,
 * `task_instance_failed`, or `task_instance_transitioned` for any other move.
 * A no-op when the status did not change, so re-drives that re-assert the same
 * status record nothing.
 */
export async function recordTaskInstanceTransition(
  tx: DrizzleTransaction,
  input: { taskInstanceId: string; from: string | null; to: string; correlation: Correlation; producer: string }
): Promise<void> {
  if (input.from === input.to) return;
  const base = { subjectId: input.taskInstanceId, correlation: input.correlation, producer: input.producer };
  if (input.to === "completed") {
    await emitLifecycleEvent(tx, { ...base, eventType: "task_instance_completed", payload: { from: input.from } });
  } else if (input.to === "failed") {
    await emitLifecycleEvent(tx, { ...base, eventType: "task_instance_failed", payload: { from: input.from } });
  } else {
    await emitLifecycleEvent(tx, {
      ...base,
      eventType: "task_instance_transitioned",
      idempotencyKey: `task_instance_transitioned:${input.taskInstanceId}:${randomUUID()}`,
      payload: { from: input.from, to: input.to },
    });
  }
}

/** `artifact_created`, correlated through the producing Invocation's Run. */
export async function emitArtifactCreated(
  tx: DrizzleTransaction,
  artifact: { id: string; type: string; hash: string; size: number; producingInvocationId: string | null }
): Promise<void> {
  let correlation: Correlation = NO_CORRELATION;
  if (artifact.producingInvocationId) {
    const invocation = await tx.query.invocations.findFirst({
      where: (i, { eq: equals }) => equals(i.id, artifact.producingInvocationId!),
    });
    correlation = invocation
      ? await correlationForRun(tx, invocation.runId, invocation.id)
      : { ...NO_CORRELATION, invocationId: artifact.producingInvocationId };
  }
  await emitLifecycleEvent(tx, {
    eventType: "artifact_created",
    subjectId: artifact.id,
    correlation,
    producer: "executor",
    payload: { artifactId: artifact.id, type: artifact.type, hash: artifact.hash, size: artifact.size },
  });
}

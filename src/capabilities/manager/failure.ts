/**
 * Why a Run failed, decided by CODE from the runtime's own records — never by a model.
 *
 * A mission's recovery starts here: the category comes from the Run's outcome, its last
 * `invocation_failed`, the Policy decision behind a denial, the budget counter that refused it, the
 * approval that was rejected or expired, and the stop that halted it. The model is told the category
 * and may propose what to do about it; it can neither choose the category nor widen what that category
 * allows (`RECOVERY_BY_REASON`).
 *
 * Shared by the Manager's recovery step and the mission read model, so both give the operator the same
 * words. It reads rows; it writes nothing.
 */
import { and, desc, eq } from "drizzle-orm";
import { agentDefinitions, events, runs, taskDefinitions, taskInstances, workflowRuns } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { MISSION_REASONS, RECOVERY_BY_REASON, type MissionReason, type RecoveryAction } from "./capability.js";
import { isLinearGraphDefinition } from "../../workflow/graphTypes.js";
import { workflowDefinitions } from "../../db/schema.js";

type Json = Record<string, unknown>;
const isReason = (c: unknown): c is MissionReason => typeof c === "string" && (MISSION_REASONS as readonly string[]).includes(c);

export type RunFailure = {
  runId: string;
  agentName: string | null;
  taskKind: string | null;
  /** The step of the delegated Workflow Definition this run belongs to, when it has one. */
  stepId: string | null;
  code: MissionReason;
  detail: string;
  /** What a recovery may do about a failure of this kind. Empty: nothing but escalation. */
  allowedActions: readonly RecoveryAction[];
};

/**
 * One failed Run's category, from its own records only. The step's kind names a failure nothing more
 * specific explains — a worker's `worker_failed`, the Manager's own `manager_planning_failed`.
 */
export async function classifyRunFailure(
  tx: DrizzleTransaction,
  run: { id: string; outcome: unknown },
  kind: string | null,
  agentName: string | null
): Promise<{ code: MissionReason; detail: string }> {
  const who = agentName ?? "A step";
  const outcome = (run.outcome ?? {}) as Json;
  const [last] = await tx.select({ payload: events.payload }).from(events).where(and(eq(events.runId, run.id), eq(events.eventType, "invocation_failed"))).orderBy(desc(events.sequenceNo)).limit(1);
  const failure = (last?.payload ?? {}) as Json;
  const reason = typeof failure.reason === "string" ? failure.reason : "";
  const errorCode = typeof failure.errorCode === "string" ? failure.errorCode : "";
  const detail = (text: string) => `${who} failed: ${text}`;
  if (outcome.reason === "execution_stopped" || reason === "execution_stopped") return { code: "emergency_stopped", detail: detail("an emergency stop halted it") };
  if (reason.startsWith("insufficient_budget")) return { code: "budget_denied", detail: detail(reason) };
  if (reason === "policy_denied" || reason === "reauthorization_policy_denied") {
    const [denied] = await tx.select({ payload: events.payload }).from(events).where(and(eq(events.runId, run.id), eq(events.eventType, "policy_evaluated"))).orderBy(desc(events.sequenceNo)).limit(1);
    return { code: "capability_unavailable", detail: detail(`Policy denied it (${String(((denied?.payload ?? {}) as Json).basis ?? "denied")})`) };
  }
  if (reason === "approval_rejected" || reason === "approval_expired") return { code: "approval_rejected", detail: detail(reason.replace("_", " ")) };
  // A Manager step refuses with a code-written "<scope>: <code>: …" message.
  const coded = reason.match(/^manager[\w.]*: ([a-z_]+):/)?.[1];
  if (isReason(coded)) return { code: coded, detail: detail(reason) };
  if (errorCode === "timeout" && !kind?.startsWith("manager_")) return { code: "worker_timed_out", detail: detail("the model call timed out") };
  // A provider that failed having consumed nothing is worth another attempt; one that consumed is not.
  if (errorCode && failure.providerConsumption === "none") return { code: "provider_unavailable", detail: detail(reason || errorCode) };
  const text = reason || (typeof outcome.reason === "string" ? outcome.reason : "the run failed");
  if (kind === "manager_plan") return { code: "manager_planning_failed", detail: detail(text) };
  if (kind === "manager_review") return { code: "manager_review_failed", detail: detail(text) };
  if (kind === "manager_recover") return { code: "manager_recovery_failed", detail: detail(text) };
  return { code: "worker_failed", detail: detail(text) };
}

export type WorkflowDiagnosis = {
  workflowRunId: string;
  /** The failures that stopped this work, newest attempt per step, in step order. */
  failures: RunFailure[];
  /** Steps of the delegated work that never ran, because an earlier step stopped it. */
  notReached: { stepId: string; agentName: string | null }[];
  /** Steps that finished before the failure, so their work need not be done again. */
  completed: { stepId: string; agentName: string | null }[];
};

/**
 * What happened to one delegated Workflow Run: which step failed and why, which steps had already
 * finished, and which never started. Everything here is read from the Workflow Definition's steps and
 * the runtime's own rows — the shape a recovery is allowed to reason about.
 */
export async function diagnoseWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<WorkflowDiagnosis> {
  const wr = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  const definition = wr ? await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.id, wr.workflowDefinitionId) }) : undefined;
  const graph = definition && isLinearGraphDefinition(definition.graphDefinition) ? definition.graphDefinition : null;
  const slots = ((wr?.variables ?? {}) as { stepTaskInstanceIds?: (string | null)[] }).stepTaskInstanceIds ?? [];
  const names = new Map<string, string>();
  for (const step of graph?.steps ?? []) {
    if (!step.agentDefinitionId) continue;
    const agent = await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, step.agentDefinitionId) });
    if (agent) names.set(step.stepId ?? "", agent.name);
  }

  const failures: RunFailure[] = [];
  const completed: { stepId: string; agentName: string | null }[] = [];
  const notReached: { stepId: string; agentName: string | null }[] = [];
  for (const [index, step] of (graph?.steps ?? []).entries()) {
    const stepId = step.stepId ?? `step_${index + 1}`;
    const agentName = names.get(step.stepId ?? "") ?? null;
    const taskInstanceId = slots[index] ?? null;
    if (!taskInstanceId) {
      notReached.push({ stepId, agentName });
      continue;
    }
    const attempts = await tx
      .select({ run: runs, kind: taskDefinitions.kind, name: agentDefinitions.name })
      .from(runs)
      .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
      .leftJoin(taskDefinitions, and(eq(taskDefinitions.id, taskInstances.taskDefinitionId), eq(taskDefinitions.version, taskInstances.taskDefinitionVersion)))
      .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
      .where(eq(runs.taskInstanceId, taskInstanceId))
      .orderBy(desc(runs.attempt));
    const latest = attempts[0];
    if (!latest) {
      notReached.push({ stepId, agentName });
      continue;
    }
    if (latest.run.status === "completed") {
      completed.push({ stepId, agentName: latest.name ?? agentName });
      continue;
    }
    if (latest.run.status !== "failed") continue;
    const { code, detail } = await classifyRunFailure(tx, latest.run, latest.kind ?? null, latest.name ?? agentName);
    failures.push({ runId: latest.run.id, agentName: latest.name ?? agentName, taskKind: latest.kind ?? null, stepId, code, detail, allowedActions: RECOVERY_BY_REASON[code] ?? [] });
  }
  return { workflowRunId, failures, notReached, completed };
}

/** What a recovery may propose for these failures: the intersection of what each failure allows. */
export function allowedRecoveryActions(failures: RunFailure[]): RecoveryAction[] {
  if (failures.length === 0) return [];
  return failures
    .map((f) => f.allowedActions)
    .reduce<readonly RecoveryAction[]>((all, one) => all.filter((a) => one.includes(a)), failures[0]!.allowedActions)
    .slice();
}

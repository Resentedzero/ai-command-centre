/**
 * Retry policy — spec §3d ("a new Run is created against the same Task Instance, up to
 * a policy-defined retry limit") and §10.4 ("escalate one tier, bounded retry count ->
 * exhausted at STRONG? surface as task failure").
 *
 * DECIDED BY THE OPERATOR 2026-09-15 (ROADMAP_STATUS §6 D1, option c): up to
 * `RETRY_LIMIT` = 2 retries, so at most 3 Runs per Task Instance. Only these failures
 * of a Run are retried:
 *   - a provider failure of UNKNOWN consumption on an LLM Invocation (a timeout, a
 *     crash mid-stream, missing usage, a usage report that could not be reconciled, an
 *     Invocation interrupted by a dead process): retried at the same tier floor;
 *   - an OUTPUT-VALIDATION failure on an LLM Invocation (the provider's structured-output
 *     validator rejected the result, `errorCode: "schema_validation"`): retried one tier
 *     above the tier that failed. At STRONG there is nothing above, so the Task fails.
 * Everything else ends the Task Instance as before: Policy denials, rejected or expired
 * Approvals, stops, budget and quota refusals, provider failures that consumed nothing
 * (an expired login or an exhausted quota fails again; §10.6.7 forbids turning one into a
 * billed call), step execution errors, and every Tool Invocation failure (a tool may
 * have had its effect; asking it is DURABLE_EXECUTION §7 #19).
 *
 * Fail-closed guard (review, 2026-09-15): a retry re-runs the whole step plan, so a Run
 * that already completed a tool effect beyond a READ, or involved an Approval, is not
 * retried: the retry would repeat the effect, or ask a human to approve a repeat that
 * looks new. Such a Task fails as it did before retries existed.
 *
 * Consequences that follow from the spec rather than from this module: a retry is a new
 * Run, so its Invocations are proposed afresh, an approval-gated action needs a new
 * Approval (§3c: an Approval gates one Invocation), and each Run is provisioned its own
 * Run budget ceilings (`./runBudgetPolicy.ts`). The Model Router never routes a retry
 * to a `usd` candidate (`../router/modelRouter.ts`).
 *
 * ponytail: validation failures come only from adapters that validate (the Claude CLI's
 * structured output). The API adapters do not check the shape, so their malformed
 * output is not a validation failure here; Task output schemas are unvalidated (§6).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { approvals, events, invocations, runs, taskDefinitions, taskInstances } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { MODEL_TIERS, type ModelTier } from "../router/types.js";

/** Retries after the first Run of a Task Instance. The operator's value (2026-09-15). */
export const RETRY_LIMIT = 2;

/** The Runs a Task Instance may have in total. */
export const MAX_RUN_ATTEMPTS = 1 + RETRY_LIMIT;

const AUTOMATIC_RETRY_EXCLUDED_KINDS = new Set<string>();

/**
 * V1.1 (operator decision 2026-09-15): a Task Definition kind whose failed Runs are never
 * retried automatically. An autonomous loop's retry would repeat every iteration it
 * already paid for; a retry is an explicit new Run started by the operator. Registered
 * by the kind's plan (`../capabilities/taskPlans.ts`), so this module names no kind.
 */
export function excludeTaskKindFromAutomaticRetry(kind: string): void {
  AUTOMATIC_RETRY_EXCLUDED_KINDS.add(kind);
}

/** The `invocation_failed` reason for an Invocation whose dispatcher died mid-call (`executor.ts`). */
const INTERRUPTED_REASON = "interrupted_outcome_unknown";
const VALIDATION_ERROR_CODE = "schema_validation";

/** What the failed Run's own records say about why it ended. */
export type RunFailureFacts = {
  /** Whether an operator stop halted the Run (`run_halted`). */
  halted: boolean;
  /** Whether the Run completed a tool Invocation other than a READ, or has any Approval. */
  priorEffect: boolean;
  /** Kind of the Invocation whose `invocation_failed` is the Run's last, or null if none. */
  invocationKind: string | null;
  reason: string | null;
  errorCode: string | null;
  /** `providerConsumption` recorded when the dispatch's reservation was settled. */
  providerConsumption: string | null;
  /** `resultingTier` of the Run's last model `invocation_started`. */
  lastResultingTier: ModelTier | null;
  /** The tier floor the failed Run itself was created with. */
  minimumModelTier: ModelTier | null;
  /** V1.1: the Run's Task Definition kind; a kind excluded from automatic retry is never retried. */
  taskKind?: string | null;
};

export type RetryCause = "provider_outcome_unknown" | "output_validation_failed";

export type RetryDecision =
  | { retry: false; reason: "not_retryable" | "attempts_exhausted" | "escalation_exhausted" }
  | { retry: true; cause: RetryCause; attempt: number; minimumModelTier: ModelTier | null };

function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

function retryCause(facts: RunFailureFacts): RetryCause | null {
  if (facts.taskKind != null && AUTOMATIC_RETRY_EXCLUDED_KINDS.has(facts.taskKind)) return null;
  if (facts.halted || facts.priorEffect || facts.invocationKind !== "llm") return null;
  if (facts.errorCode === VALIDATION_ERROR_CODE) return "output_validation_failed";
  if (facts.providerConsumption === "unknown" || facts.reason === INTERRUPTED_REASON) return "provider_outcome_unknown";
  return null;
}

/** Pure: whether a Run that failed this way, as attempt `attemptsSoFar` of its Task Instance, is retried. */
export function retryDecision(facts: RunFailureFacts, attemptsSoFar: number): RetryDecision {
  const cause = retryCause(facts);
  if (cause === null) return { retry: false, reason: "not_retryable" };
  if (attemptsSoFar >= MAX_RUN_ATTEMPTS) return { retry: false, reason: "attempts_exhausted" };
  const attempt = attemptsSoFar + 1;
  if (cause === "provider_outcome_unknown") return { retry: true, cause, attempt, minimumModelTier: facts.minimumModelTier };

  // Validation: one tier above the tier that produced the rejected output.
  if (facts.lastResultingTier === null) return { retry: false, reason: "not_retryable" };
  const above = MODEL_TIERS[MODEL_TIERS.indexOf(facts.lastResultingTier) + 1];
  if (above === undefined) return { retry: false, reason: "escalation_exhausted" };
  return { retry: true, cause, attempt, minimumModelTier: above };
}

/** Reads the failed Run's facts from its row and its own records. */
export async function readRunFailure(tx: DrizzleTransaction, runId: string): Promise<RunFailureFacts> {
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  const taskInstance = run ? await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) }) : undefined;
  const taskDefinition = taskInstance
    ? await tx.query.taskDefinitions.findFirst({
        where: and(eq(taskDefinitions.id, taskInstance.taskDefinitionId), eq(taskDefinitions.version, taskInstance.taskDefinitionVersion)),
      })
    : undefined;
  const halted = await tx.query.events.findFirst({ where: and(eq(events.runId, runId), eq(events.eventType, "run_halted")) });
  const failure = await tx.query.events.findFirst({
    where: and(eq(events.runId, runId), eq(events.eventType, "invocation_failed")),
    orderBy: desc(events.sequenceNo),
  });
  const started = await tx.query.events.findFirst({
    where: and(eq(events.runId, runId), eq(events.eventType, "invocation_started"), sql`${events.payload} ? 'resultingTier'`),
    orderBy: desc(events.sequenceNo),
  });
  const invocation = failure?.invocationId
    ? await tx.query.invocations.findFirst({ where: eq(invocations.id, failure.invocationId) })
    : undefined;
  // A completed tool Invocation that was not a READ (a null permission is not a READ: fail closed).
  const [effect] = await tx
    .select({ id: invocations.id })
    .from(invocations)
    .where(
      and(
        eq(invocations.runId, runId),
        eq(invocations.kind, "tool"),
        eq(invocations.status, "completed"),
        sql`${invocations.permission} is distinct from 'READ'`
      )
    )
    .limit(1);
  const [approval] = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .innerJoin(invocations, eq(invocations.id, approvals.invocationId))
    .where(eq(invocations.runId, runId))
    .limit(1);

  const payload = (failure?.payload ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const resultingTier = (started?.payload as Record<string, unknown> | undefined)?.resultingTier;
  return {
    halted: halted !== undefined,
    priorEffect: effect !== undefined || approval !== undefined,
    invocationKind: invocation?.kind ?? null,
    reason: text(payload.reason),
    errorCode: text(payload.errorCode),
    providerConsumption: text(payload.providerConsumption),
    lastResultingTier: isModelTier(resultingTier) ? resultingTier : null,
    minimumModelTier: isModelTier(run?.minimumModelTier) ? run.minimumModelTier : null,
    taskKind: taskDefinition?.kind ?? null,
  };
}

/** The retry decision for a failed Run of `taskInstanceId`. */
export async function decideRetry(tx: DrizzleTransaction, taskInstanceId: string, failedRunId: string): Promise<RetryDecision> {
  const [{ attempts }] = (await tx
    .select({ attempts: sql<number>`count(*)::int` })
    .from(runs)
    .where(eq(runs.taskInstanceId, taskInstanceId))) as [{ attempts: number }];
  return retryDecision(await readRunFailure(tx, failedRunId), attempts);
}

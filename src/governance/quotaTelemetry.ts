/**
 * Recording provider quota telemetry against an Invocation (Phase 8 — closes
 * the B-3 gap, where the adapter produced observations and nothing recorded
 * them, leaving `subscription_quota_state` permanently empty in production).
 *
 * Mechanism B only. Quota telemetry is ADVISORY: it is recorded as an
 * immutable fact and projected into quota state, and that is all. This module
 * writes no `budget_counters` row, touches no `subscription_tokens` amount,
 * makes no authorization decision, and cannot enable the quota guardrail —
 * whether the guardrail acts is a source constant, not recorded state.
 *
 * A SEPARATE MODULE, deliberately. The Model Router is structurally forbidden
 * from naming quota state or reading raw utilization (asserted by
 * `tests/router/candidateRouting.test.ts`); it hands an opaque observation to
 * this function and knows nothing about what is inside it.
 *
 * TELEMETRY NEVER DECIDES AN INVOCATION'S OUTCOME. The write runs inside a
 * SAVEPOINT in the caller's transaction:
 *   - success: the observation lands atomically with the invocation — a
 *     rollback of the invocation removes both the event and the projection;
 *   - failure of the telemetry write itself (a malformed reading, or any
 *     database error): only the savepoint rolls back, the error is logged, and
 *     the invocation proceeds exactly as it would have without telemetry.
 * Without the savepoint, a database error here would abort the whole
 * transaction and turn a completed, already-consumed inference into a failed
 * one — trading a real outcome for an advisory gauge reading.
 */
import { eq } from "drizzle-orm";
import { events } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { recordQuotaObservation, type QuotaObservation } from "./subscriptionQuotaState.js";

export async function recordInvocationQuotaObservation(
  tx: DrizzleTransaction,
  invocation: { invocationId: string; runId: string; taskInstanceId: string },
  observation: QuotaObservation | undefined
): Promise<void> {
  // Most invocations carry none — every non-subscription provider, and any
  // subscription stream that emitted no usable rate_limit_event. Normal, not
  // an error, and never an invented reading.
  if (!observation) return;

  try {
    await tx.transaction(async (savepoint) => {
      // Design Part 4: the observation is caused by this invocation starting.
      const started = await savepoint.query.events.findFirst({
        where: eq(events.idempotencyKey, `invocation_started:${invocation.invocationId}`),
      });

      await recordQuotaObservation(savepoint, observation, {
        // One coalesced observation per invocation (design Part 4), so the
        // observation index is always 0. Idempotent on replay.
        idempotencyKey: `provider_quota_observed:${invocation.invocationId}:0`,
        causationId: started?.id ?? null,
        correlation: {
          goalId: null,
          workflowRunId: null,
          taskInstanceId: invocation.taskInstanceId,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
        },
        producer: "model-router",
      });
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "recordInvocationQuotaObservation: failed to record provider quota telemetry for invocation " +
        `"${invocation.invocationId}". This is advisory telemetry only — the invocation's own outcome, ` +
        "budget accounting and authorization are unaffected, and only this write was rolled back.",
      error
    );
  }
}

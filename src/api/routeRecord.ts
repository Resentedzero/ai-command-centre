/**
 * Routing and retry facts as read models expose them (spec §10.4, §10.7), so a UI shows
 * the tier, why that tier, and a retry's lineage without re-deriving any routing decision.
 *
 * `routeRecordOf`: the Model Router's recorded route for an LLM Invocation — the named
 * facts of `invocation_started`, or of the refused route written into
 * `invocation_failed.routingDecision` (then `resultingTier` is null and `attemptedTier`
 * says what was tried; `modelId` on a budget refusal is the candidate that was priced,
 * never called). `tierSource` is the Router's own record of which rule set the
 * tier (`default`, `escalation_floor`, `performance_preference`); null on routes recorded
 * before 2026-09-15. Null for other kinds and for an LLM Invocation not yet routed.
 *
 * `budgetFallback`: the Budget Governor's one fallback when the routed tier's reservation was
 * denied — the tier it was denied at (`fromTier`), the tier it then tried (`attemptedTier`,
 * one lower or the same), the Context Budget factor and the tightened input ceiling, and
 * whether that attempt was authorized. Null when no fallback happened.
 *
 * `retryRecordOf`: a Run's `run_started` lineage. A retry Run records the Run it retries
 * and the retry policy's cause (`governance/retryPolicy.ts`); a first attempt has neither.
 */
export type RouteRecord = {
  defaultTier: string | null;
  escalationFloor: string | null;
  resultingTier: string | null;
  attemptedTier: string | null;
  tierSource: string | null;
  attempt: number | null;
  modelId: string | null;
  budgetFallback: {
    outcome: string | null;
    fromTier: string | null;
    attemptedTier: string | null;
    authorized: boolean | null;
    contextBudgetFactor: number | null;
    maxInputTokens: number | null;
  } | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function routeRecordOf(kind: string, startedPayload: unknown, failedPayload: unknown): RouteRecord | null {
  if (kind !== "llm") return null;
  const started = record(startedPayload);
  const refused = record(record(failedPayload).routingDecision);
  const source = "resultingTier" in started ? started : "attemptedTier" in refused ? refused : null;
  if (!source) return null;
  const fallback = "budgetFallback" in source ? record(source.budgetFallback) : null;
  return {
    budgetFallback: fallback
      ? {
          outcome: text(fallback.outcome),
          fromTier: text(fallback.fromTier),
          attemptedTier: text(fallback.attemptedTier),
          authorized: typeof fallback.authorized === "boolean" ? fallback.authorized : null,
          contextBudgetFactor: typeof fallback.contextBudgetFactor === "number" ? fallback.contextBudgetFactor : null,
          maxInputTokens: typeof record(fallback.contextBudget).maxInputTokens === "number" ? (record(fallback.contextBudget).maxInputTokens as number) : null,
        }
      : null,
    defaultTier: text(source.defaultTier),
    escalationFloor: text(source.escalationFloor),
    resultingTier: text(started.resultingTier),
    attemptedTier: source === refused ? text(refused.attemptedTier) : null,
    tierSource: text(source.tierSource),
    attempt: typeof source.attempt === "number" ? source.attempt : null,
    modelId: source === started ? text(started.resultingModelId) : text(record(refused.budgetAuthorization).modelId),
  };
}

export function retryRecordOf(runStartedPayload: unknown): { retryOfRunId: string | null; retryCause: string | null } {
  const p = record(runStartedPayload);
  return { retryOfRunId: text(p.retryOfRunId), retryCause: text(p.cause) };
}

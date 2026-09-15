/**
 * The retry policy's decision (operator decision D1, 2026-09-15): which failed Runs are
 * retried, the limit of 2 retries (3 Runs), and one-tier escalation after a validation
 * failure, exhausted at STRONG. Pure; the end-to-end behaviour is in
 * `tests/workflow/retries.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { MAX_RUN_ATTEMPTS, RETRY_LIMIT, retryDecision, type RunFailureFacts } from "../../src/governance/retryPolicy.js";

const unknownConsumption: RunFailureFacts = {
  halted: false,
  invocationKind: "llm",
  reason: "provider boom",
  errorCode: null,
  providerConsumption: "unknown",
  lastResultingTier: "CHEAP",
  minimumModelTier: null,
};
const validation: RunFailureFacts = { ...unknownConsumption, errorCode: "schema_validation", reason: "structured-output validation failed" };

describe("retryDecision", () => {
  it("is the operator's limit: 2 retries, 3 Runs in total", () => {
    expect(RETRY_LIMIT).toBe(2);
    expect(MAX_RUN_ATTEMPTS).toBe(3);
    expect(retryDecision(unknownConsumption, 1)).toMatchObject({ retry: true, attempt: 2 });
    expect(retryDecision(unknownConsumption, 2)).toMatchObject({ retry: true, attempt: 3 });
    expect(retryDecision(unknownConsumption, 3)).toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("retries an LLM provider failure of unknown consumption at the same tier floor", () => {
    expect(retryDecision(unknownConsumption, 1)).toEqual({ retry: true, cause: "provider_outcome_unknown", attempt: 2, minimumModelTier: null });
    // An escalated Run that then fails this way keeps its floor.
    expect(retryDecision({ ...unknownConsumption, minimumModelTier: "MID", lastResultingTier: "MID" }, 2)).toEqual({
      retry: true,
      cause: "provider_outcome_unknown",
      attempt: 3,
      minimumModelTier: "MID",
    });
  });

  it("retries an LLM Invocation interrupted by a dead process (its details carry no providerConsumption)", () => {
    const interrupted = { ...unknownConsumption, providerConsumption: null, reason: "interrupted_outcome_unknown" };
    expect(retryDecision(interrupted, 1)).toMatchObject({ retry: true, cause: "provider_outcome_unknown" });
  });

  it.each([
    ["CHEAP", "MID"],
    ["MID", "STRONG"],
  ] as const)("escalates a validation failure at %s to %s", (from, to) => {
    expect(retryDecision({ ...validation, lastResultingTier: from }, 1)).toEqual({
      retry: true,
      cause: "output_validation_failed",
      attempt: 2,
      minimumModelTier: to,
    });
  });

  it("a validation failure at STRONG is exhausted: the Task fails", () => {
    expect(retryDecision({ ...validation, lastResultingTier: "STRONG" }, 1)).toEqual({ retry: false, reason: "escalation_exhausted" });
  });

  it("a validation failure with no recorded tier cannot be escalated", () => {
    expect(retryDecision({ ...validation, lastResultingTier: null }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });

  it.each<[string, Partial<RunFailureFacts>]>([
    ["a Tool Invocation failure", { invocationKind: "tool" }],
    ["a Run with no failed Invocation", { invocationKind: null, providerConsumption: null }],
    ["a provider failure that consumed nothing (expired login, exhausted quota)", { providerConsumption: "none", errorCode: "quota_exhausted" }],
    ["a failure whose reservation was already reconciled", { providerConsumption: null, reason: "persist failed" }],
    ["a Run halted by an operator stop", { halted: true }],
    ["a Policy denial", { providerConsumption: null, reason: "policy_denied" }],
    ["an insufficient budget", { providerConsumption: null, reason: "insufficient_budget" }],
    ["a rejected Approval", { providerConsumption: null, reason: "approval_rejected" }],
    ["a step execution error", { providerConsumption: null, reason: "execution_error: boom" }],
  ])("never retries %s", (_label, change) => {
    expect(retryDecision({ ...unknownConsumption, ...change }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });

  it("a validation error code on a Tool Invocation, or on a halted Run, is not retried either", () => {
    expect(retryDecision({ ...validation, invocationKind: "tool" }, 1)).toEqual({ retry: false, reason: "not_retryable" });
    expect(retryDecision({ ...validation, halted: true }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });
});

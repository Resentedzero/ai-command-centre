/**
 * `routeRecordOf` / `retryRecordOf`: routing and retry facts from recorded payload shapes
 * (`authorizeRoute`'s `invocation_started` and refusal `decision`, which the Executor writes
 * as `invocation_failed.routingDecision`; the Interpreter's `run_started`). No database.
 */
import { describe, expect, it } from "vitest";
import { retryRecordOf, routeRecordOf } from "../../src/api/routeRecord.js";

const inputs = { defaultTier: "CHEAP", escalationFloor: "MID", attempt: 2, tierSource: "escalation_floor" };

describe("routeRecordOf", () => {
  it("reads a routed call from invocation_started", () => {
    expect(routeRecordOf("llm", { ...inputs, resultingTier: "MID", resultingModelId: "claude-sonnet-5" }, undefined)).toEqual({
      defaultTier: "CHEAP",
      escalationFloor: "MID",
      resultingTier: "MID",
      attemptedTier: null,
      tierSource: "escalation_floor",
      attempt: 2,
      modelId: "claude-sonnet-5",
    });
  });

  it("reads a route refused for lack of a candidate: what was tried, no model", () => {
    const failed = { reason: "no_eligible_candidate", routingDecision: { ...inputs, attemptedTier: "MID", excludedCandidates: [] } };
    expect(routeRecordOf("llm", undefined, failed)).toMatchObject({ resultingTier: null, attemptedTier: "MID", tierSource: "escalation_floor", modelId: null });
  });

  it("reads a route refused by the budget: the candidate priced, never called", () => {
    const failed = {
      reason: "insufficient_budget",
      routingDecision: { ...inputs, attemptedTier: "MID", budgetAuthorization: { authorized: false, modelId: "claude-sonnet-5" } },
    };
    expect(routeRecordOf("llm", undefined, failed)).toMatchObject({ resultingTier: null, attemptedTier: "MID", modelId: "claude-sonnet-5" });
  });

  it("is null for other kinds, an LLM call not yet routed, and a failure before routing; tierSource null on older routes", () => {
    expect(routeRecordOf("tool", { resultingTier: "MID" }, undefined)).toBeNull();
    expect(routeRecordOf("llm", undefined, undefined)).toBeNull();
    expect(routeRecordOf("llm", undefined, { reason: "execution_stopped" })).toBeNull();
    expect(routeRecordOf("llm", { defaultTier: "MID", resultingTier: "MID" }, undefined)!.tierSource).toBeNull();
  });
});

describe("retryRecordOf", () => {
  it("reads a retry's lineage and a first attempt's absence of one", () => {
    expect(retryRecordOf({ attempt: 2, retryOfRunId: "run-1", cause: "output_validation_failed", minimumModelTier: "MID" })).toEqual({
      retryOfRunId: "run-1",
      retryCause: "output_validation_failed",
    });
    expect(retryRecordOf({})).toEqual({ retryOfRunId: null, retryCause: null });
    expect(retryRecordOf(undefined)).toEqual({ retryOfRunId: null, retryCause: null });
  });
});

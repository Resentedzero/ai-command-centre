/**
 * `budgetOutcomeOf`: the Budget Governor's outcome per Invocation, from recorded facts
 * only. Each case pins one row of the rule in `src/api/budgetOutcome.ts`; no database.
 */
import { describe, expect, it } from "vitest";
import { budgetOutcomeOf } from "../../src/api/budgetOutcome.js";

const none = { preDispatchChecked: false, approvalRequired: false };

describe("budgetOutcomeOf", () => {
  it("llm: the Router's recorded authorization, either way; nothing when the Governor was never asked", () => {
    const llm = { kind: "llm", costClass: "llm", status: "completed" };
    expect(budgetOutcomeOf(llm, { ...none, startedPayload: { budgetAuthorization: { authorized: true } } })).toBe("authorized");
    // Authorized, then failed at the provider: the Governor's outcome is still authorized.
    expect(budgetOutcomeOf({ ...llm, status: "failed" }, { ...none, startedPayload: { budgetAuthorization: { authorized: true } }, failedPayload: { reason: "provider_failure" } })).toBe("authorized");
    expect(
      budgetOutcomeOf({ ...llm, status: "failed" }, { ...none, failedPayload: { reason: "insufficient_budget", routingDecision: { budgetAuthorization: { authorized: false } } } })
    ).toBe("denied");
    // Refused before reserving (no candidate, quota): no budget outcome, not "denied".
    expect(budgetOutcomeOf({ ...llm, status: "failed" }, { ...none, failedPayload: { reason: "no_eligible_candidate", routingDecision: { attemptedTier: "MID" } } })).toBeNull();
  });

  it("tool: denied only for the Executor's budget reasons, checked before any sign of an earlier reservation", () => {
    const failedTool = { kind: "tool", costClass: "metered_api", status: "failed" };
    expect(budgetOutcomeOf(failedTool, { ...none, failedPayload: { reason: "insufficient_budget" } })).toBe("denied");
    // Refused a fresh reservation on resume, although the proposal's reservation had succeeded.
    expect(budgetOutcomeOf(failedTool, { ...none, approvalRequired: true, failedPayload: { reason: "insufficient_budget_on_resume" } })).toBe("denied");
    // The recorded fact the Executor writes now.
    expect(budgetOutcomeOf(failedTool, { ...none, failedPayload: { reason: "insufficient_budget", budgetAuthorization: { authorized: false, outcome: "denied" } } })).toBe("denied");
  });

  it("tool: a tool's own error message that reads like a budget reason is not a denial when a reservation was settled", () => {
    const failedTool = { kind: "tool", costClass: "metered_api", status: "failed" };
    expect(
      budgetOutcomeOf(failedTool, { ...none, preDispatchChecked: true, failedPayload: { reason: "insufficient_budget", reservationSettlement: "charged_at_estimate" } })
    ).toBe("authorized");
  });

  it("tool: authorized by any recorded fact of a successful reservation, and it stays authorized after the action fails", () => {
    const tool = { kind: "tool", costClass: "metered_api" };
    for (const status of ["awaiting_approval", "executing", "completed"]) {
      expect(budgetOutcomeOf({ ...tool, status }, none)).toBe("authorized");
    }
    const failedTool = { ...tool, status: "failed" };
    // Held for approval, then rejected or expired: the hold was released, the Governor had authorized it.
    expect(budgetOutcomeOf(failedTool, { ...none, approvalRequired: true, failedPayload: { reason: "approval_rejected" } })).toBe("authorized");
    // Dispatched on a reservation (its pre-dispatch check ran), then failed.
    expect(budgetOutcomeOf(failedTool, { ...none, preDispatchChecked: true, failedPayload: { reason: "tool failed" } })).toBe("authorized");
    // Interrupted after the `executing` commit and charged at its estimate, or refused at dispatch and released.
    for (const reservationSettlement of ["charged_at_estimate", "released", "reconciled"]) {
      expect(budgetOutcomeOf(failedTool, { ...none, failedPayload: { reason: "interrupted_outcome_unknown", reservationSettlement } })).toBe("authorized");
    }
  });

  it("tool: nothing when it was refused before reserving or no reservation is recorded", () => {
    const failedTool = { kind: "tool", costClass: "metered_api", status: "failed" };
    for (const reason of ["policy_denied", "execution_stopped"]) {
      expect(budgetOutcomeOf(failedTool, { ...none, failedPayload: { reason } })).toBeNull();
    }
    expect(budgetOutcomeOf(failedTool, { ...none, failedPayload: { reason: "interrupted_outcome_unknown", reservationSettlement: "none_recorded" } })).toBeNull();
    expect(budgetOutcomeOf({ ...failedTool, status: "proposed" }, none)).toBeNull();
  });

  it("never reserves for the deterministic cost class or other kinds, and never names a downgrade or degrade", () => {
    expect(budgetOutcomeOf({ kind: "tool", costClass: "deterministic", status: "completed" }, none)).toBeNull();
    expect(budgetOutcomeOf({ kind: "deterministic", costClass: "deterministic", status: "completed" }, none)).toBeNull();
    expect(budgetOutcomeOf({ kind: "retrieval", costClass: "local_retrieval", status: "completed" }, none)).toBeNull();
    const produced = new Set([
      budgetOutcomeOf({ kind: "llm", costClass: "llm", status: "completed" }, { ...none, startedPayload: { budgetAuthorization: { authorized: true } } }),
      budgetOutcomeOf({ kind: "tool", costClass: "metered_api", status: "failed" }, { ...none, failedPayload: { reason: "insufficient_budget" } }),
    ]);
    expect([...produced].sort()).toEqual(["authorized", "denied"]);
  });
});

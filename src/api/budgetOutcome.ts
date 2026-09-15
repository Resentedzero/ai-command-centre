/**
 * The Budget Governor's outcome for one Invocation, as read models expose it (spec
 * Phase 4: the Governor is "consulted for every Invocation"). Assembled from facts the
 * runtime recorded when it reserved, so a UI never infers it from a failure reason. It
 * is the Governor's outcome, not the call's: an authorized reservation stays
 * `authorized` whatever happened to the action afterwards (rejected, expired, refused
 * at dispatch, interrupted, failed).
 *
 * - `llm`: the Model Router's own record, `budgetAuthorization.authorized`, on
 *   `invocation_started` (authorized) or on the refused route it wrote into
 *   `invocation_failed.routingDecision` (denied). A route refused before the Governor
 *   was asked (no eligible candidate, quota) has no outcome.
 * - `tool`: denied when the Executor failed it for an exhausted budget at proposal or
 *   on resume. Authorized when any fact shows a reservation succeeded: a state the
 *   Executor writes only after one (`awaiting_approval`, `executing`, `completed`), an
 *   `approval_required` event (emitted only after the reservation), a pre-dispatch
 *   check (a pending dispatch exists only with a reservation), or a failure that
 *   records settling one (`reservationSettlement` reconciled, released or charged at
 *   estimate). Refused before reserving (a stop, a Policy DENY): none.
 * - `deterministic` cost class, and kinds that never reserve: none.
 *
 * Only `authorized` and `denied` exist. The spec's `authorized-at-downgraded-tier` and
 * `degrade` are undecided (ROADMAP_STATUS §6) and are never produced.
 */
export type BudgetOutcome = "authorized" | "denied";

/** `invocation_failed.reason` values the Executor writes for an exhausted budget on the tool path. */
const TOOL_BUDGET_DENIALS = new Set(["insufficient_budget", "insufficient_budget_on_resume"]);
/** Tool Invocation states written only after a successful reservation (`execution/executor.ts`). */
const TOOL_STATES_AFTER_RESERVATION = new Set(["awaiting_approval", "executing", "completed"]);
/** `invocation_failed.reservationSettlement` values that settle a reservation that existed. */
const SETTLED_RESERVATIONS = new Set(["reconciled", "released", "charged_at_estimate"]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function budgetOutcomeOf(
  invocation: { kind: string; costClass: string; status: string },
  facts: { startedPayload?: unknown; failedPayload?: unknown; preDispatchChecked: boolean; approvalRequired: boolean }
): BudgetOutcome | null {
  if (invocation.costClass === "deterministic") return null;
  const failed = record(facts.failedPayload);

  if (invocation.kind === "llm") {
    if (record(record(facts.startedPayload).budgetAuthorization).authorized === true) return "authorized";
    if (record(record(failed.routingDecision).budgetAuthorization).authorized === false) return "denied";
    return null;
  }

  if (invocation.kind === "tool") {
    // The Executor's recorded denial (`budgetAuthorization`, since 2026-09-15). Older denials carry
    // only the reason; a failure that settled a reservation was never denied, whatever its reason
    // text says (a tool's own error message can read "insufficient_budget").
    if (record(failed.budgetAuthorization).authorized === false) return "denied";
    if (typeof failed.reason === "string" && TOOL_BUDGET_DENIALS.has(failed.reason) && !("budgetAuthorization" in failed) && !("reservationSettlement" in failed)) {
      return "denied";
    }
    const settled = typeof failed.reservationSettlement === "string" && SETTLED_RESERVATIONS.has(failed.reservationSettlement);
    if (TOOL_STATES_AFTER_RESERVATION.has(invocation.status) || facts.approvalRequired || facts.preDispatchChecked || settled) {
      return "authorized";
    }
    return null;
  }

  return null;
}

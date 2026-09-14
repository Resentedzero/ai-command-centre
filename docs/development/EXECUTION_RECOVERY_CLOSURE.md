# Execution recovery and idempotency: Closure

**Started:** 2026-09-14, after Phase 9's closure ([`POST_PHASE9_CLOSURE.md`](POST_PHASE9_CLOSURE.md)).
**Status:** complete (milestones A–D). Local commits on `main`, none pushed. Open items are user decisions, listed under C and D and in DURABLE_EXECUTION §7 (#13, #14, #16, #19).
**Authoritative write-up:** [`docs/architecture/DURABLE_EXECUTION.md`](../architecture/DURABLE_EXECUTION.md).

No live Claude invocations. Every dispatch-capable test mocks all three provider adapters.

## Milestones

### A. Step failure settlement (DURABLE_EXECUTION §4.2)

**Problem.** A step whose spec builder or execution threw rolled back the whole advance. An approval-held step kept its budget hold, and every later advance (approve, TTL sweep, startup re-drive) repeated the throw, so the Workflow Run stayed `in_progress` forever.

**Change.** The builder and `executeRun` run in a savepoint. A non-transient failure is settled in the same transaction by `settleRunAfterStepFailure`: a pending Approval is closed as expired by the system, a held reservation is released (nothing ran), an orphaned `executing` Invocation is settled as interrupted, and the Run, Task Instance and Workflow Run fail with reason `execution_error`. Transient database errors, a failed stop lookup, and a Run still being dispatched propagate unchanged.

**Decisions.**
- A non-transient builder or Executor error fails the step rather than waiting. It comes from the step's own data or definitions, so it would repeat on every advance. A retry is a new Run, which the retry policy owns.
- A still-pending Approval is closed as `expired` with actor `system:execution_error`, matching how a stop closes one. An already-decided Approval keeps its decision.
- Transient SQLSTATE classes 08, 40, 53, 57 and 55P03 are never turned into a permanent failure.

**Tests.** `tests/workflow/stepFailureSettlement.test.ts` (confirmed to fail with settlement disabled); the approve route end to end, plus the transient-error report path, in `tests/api/routes.integration.test.ts`.

### B. Crash-safe tool side effects and idempotency (DURABLE_EXECUTION §2.1, spec §12 note)

**Problem.** Tools ran inside the transaction that recorded them. A crash after `publishReport` wrote its file but before commit rolled the Invocation back to `awaiting_approval` with its Approval still approved. The next advance, whether the TTL sweep, the startup re-drive or any request, published again. Nothing recorded that the effect might already have happened.

**Change.**
- Every Tool Invocation yields like an LLM Invocation: `executing` is committed with its reservation, then the driver runs the tool with no transaction open, then records the outcome.
- Immediately before the effect, a short transaction re-checks stops at every scope, the Grant and Tool Binding through Policy, and the Approval.
- The Invocation's persisted idempotency key is passed to the adapter.
- `publishReport` no longer takes a transaction. It receives the approved content, writes atomically, and treats a destination already holding the approved bytes as published.

**Lifecycle traced.** request → `advanceWorkflowRun` → builder → `executeRun` → `proposeInvocation` (key created and persisted) → Grant / Policy / reservation / Approval → `executing` committed (claim) → driver: `assertToolDispatchStillAuthorized` → `execute({ idempotencyKey })` → `completeToolDispatch` (reconcile or settle, artifact, event) → next advance. Recovery: the lazy `executeRun` path and the startup sweep settle an orphaned claim through `failInterruptedInvocation`.

**Decisions.**
- **All tool Invocations yield, not only side-effecting ones.** One path to get right, and a structural invariant (no tool `execute` in the Executor). The cost is one extra commit per tool Invocation.
- **A thrown tool of unknown effect is charged at estimate**, the same rule as a provider failure. Only an error proving nothing was performed (`consumption: "none"`) releases. This replaces "a thrown tool releases".
- **An interrupted tool is never re-performed, and not yet asked to verify its effect.** Verification is an adapter capability worth adding when a tool can answer reliably (DURABLE_EXECUTION §7 #19).
- **A refusal at the pre-effect re-check consumes nothing.** The effect was never attempted.

**Tests.** `tests/execution/toolDispatch.test.ts`, confirmed to fail with the `executing` claim removed and with the re-check removed; the `publishReport` idempotency and atomic-write tests; a structural invariant in `tests/execution/structuralInvariants.test.ts`. Existing tests were updated where the extra pre-dispatch `reauthorize`, the extra builder rebuild, or charge-at-estimate on a thrown tool changed an exact expectation.

### C. Crash and startup recovery audit

An independent audit walked every commit boundary of a request and of background work, asking what state persists after a crash and what recovers it. Nothing it traced stays stuck for good beyond the documented residuals.

**Fixed:**
- **Run status after approval.** An approved tool's Run no longer reads `awaiting_approval` while its tool executes.
- **Stranded expiries.** An expiry whose re-drive failed is re-driven again by the next sweep, instead of keeping its hold until a restart.
- **Sweep timing.** The TTL sweep no longer waits for the startup re-drive.
- **Lost stop events.** Stop audit events lost to a crash are backfilled at startup.
- **Masked database errors.** A database error while recording a model dispatch is no longer masked.

Each fix has a regression test, and the first two were confirmed to fail without the fix.

**Needs a decision (DURABLE_EXECUTION §7 #13, #14):**
- whether the startup sweep may fail a paused Workflow Run;
- a crash-loop guard for the startup re-drive, which needs an attempt limit.

### D. Adversarial concurrency review

An independent review targeted the new code:
- `completeToolDispatch` against interruption settlement;
- the pre-effect check against stops and revocations;
- step-failure settlement against concurrent approvals;
- budget and lock order, and savepoint semantics.

**It found no double dispatch, no double settlement and no deadlock.** Every settler locks `runs`, then the Invocation, and re-checks its status under the lock.

**Fixed:**
- **Settlement racing an approve.** The failure event recorded the Approval as `pending` when it had in fact been approved. The status is now re-read after the conditional expire. Tested across two real connections.
- **A stop caught by the pre-effect check.** It failed the Run without naming the stop. The halt is now recorded as at the Invocation boundary: a stop-attributed outcome and `run_halted`, shared through `haltRunForStop`.
- **Step savepoint name.** It now has a unique name, so a nested savepoint of the same name cannot shadow it. This is not reachable today.
- **`revokeCapabilityGrant`'s documented contract** told callers to re-drive inside its transaction, which would invert the lock order. It now says to commit first.

Both behavioural fixes were confirmed to fail without the fix.

**Documented, not changed (DURABLE_EXECUTION §7 #16, #17, and the corrected §6 lock-order invariant):**
- a transient failure of the pre-effect check uses up the Approval;
- a second TTL check just before the effect.

## Commits

| Commit | What |
|---|---|
| `016f58b` | A. Step failure settlement: a step whose builder or execution throws is settled (hold released, Approval state recorded, Workflow Run failed) instead of stuck |
| `6b2a651` | B. Crash-safe tool side effects: durable `executing` claim, pre-effect re-authorization, no transaction during the effect, idempotency key to the adapter; `publishReport` atomic and idempotent |
| `d43ea00` | C. Recovery audit fixes: Run status after approval, stranded-expiry retry, sweep timing, stop event backfill, unmasked recording errors |
| `ea1c918` | D. Concurrency review fixes: Approval status re-read after settlement, stop attribution at the pre-effect check, unique step savepoint, `revokeCapabilityGrant` contract |

## Verification (at `ea1c918`)

- Backend `tsc --noEmit`: clean.
- Backend suite: 44 files, 659 passed, 2 skipped.
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed.
- `git diff --check`: clean.

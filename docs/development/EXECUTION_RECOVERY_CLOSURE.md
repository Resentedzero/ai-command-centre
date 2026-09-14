# Execution recovery and idempotency: Closure

**Started:** 2026-09-14, after Phase 9's closure ([`POST_PHASE9_CLOSURE.md`](POST_PHASE9_CLOSURE.md)).
**Status:** in progress. Local commits on `main`, none pushed.
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
- **An interrupted tool is never re-performed, and not yet asked to verify its effect.** Verification is an adapter capability worth adding when a tool can answer reliably (DURABLE_EXECUTION §7 #13).
- **A refusal at the pre-effect re-check consumes nothing.** The effect was never attempted.

**Tests.** `tests/execution/toolDispatch.test.ts`, confirmed to fail with the `executing` claim removed and with the re-check removed; the `publishReport` idempotency and atomic-write tests; a structural invariant in `tests/execution/structuralInvariants.test.ts`. Existing tests were updated where the extra pre-dispatch `reauthorize`, the extra builder rebuild, or charge-at-estimate on a thrown tool changed an exact expectation.

## Commits

| Commit | What |
|---|---|

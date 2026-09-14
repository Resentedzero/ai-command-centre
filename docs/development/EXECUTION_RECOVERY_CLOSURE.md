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

## Commits

| Commit | What |
|---|---|

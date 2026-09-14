# Durable Execution

**Status:** implemented in Phase 9 (2026-09-14).
**Authoritative for:** transaction boundaries around external calls, the Invocation `executing` state, interruption recovery, and the single-executor-process invariant.
**Code:**
- `src/workflow/advanceWorkflowRunUntilBlocked.ts` (driver)
- `src/execution/executor.ts` (`executeRun`, `completeModelDispatch`, `failInterruptedInvocation`)
- `src/router/modelRouter.ts` (`dispatchModelCall`, `finalizeModelCall`)
- `src/workflow/recoverInterruptedInvocations.ts`
- `src/execution/executorInstanceLock.ts`
- `src/db/transactionRunner.ts`

**Tests:** `tests/execution/durableExecution.test.ts`.

## 1. The problem this solves

Before Phase 9 every workflow-advancing request ran as one Postgres transaction, and LLM provider calls happened inside it. A `claude -p` child can run for up to 180 s. For that whole time the transaction held:

- the Run's event-sequence advisory lock (`emitEvent`), which blocks any other writer of that Run's events;
- the Run's budget counter rows (`FOR UPDATE`). Once a daily ceiling is configured, that includes the one DAY counter every Run shares, which would serialize all execution behind one call;
- the single `subscription_quota_state` row, which is shared across Runs;
- the `workflow_runs` row, so a pause request waited for the call to finish;
- a pooled connection. The pool defaults to 10.

A crash mid-call also rolled back all evidence that the call was made, while the provider-side consumption it caused still stood. The system had no way to tell "never happened" from "happened, result lost."

## 2. The design

The provider call happens **between** transactions and never inside one.

```
tx A  executeRun ─ authorize route, reserve budget, compile context
                   invocation.status = 'executing'
                   runs.budget_envelope.pendingReservations[seqNo] = reservationId
                   COMMIT                                  → yields dispatch_required
(no tx) dispatchModelCall ─ exactly one provider call; holds no DB lock
tx B  completeModelDispatch ─ quota telemetry, unit guard, reconcile,
                   artifact, invocation completed  (or: release, fail invocation+Run)
                   COMMIT
tx C  executeRun ─ continues from the next Invocation
```

- `executeRun` keeps its `(tx, runId, specs)` signature and **never calls a provider**. At an LLM Invocation it commits `executing` and returns `{ status: "dispatch_required", dispatch }`. This is the same yield-and-re-enter shape `awaiting_approval` has always used. The only difference is that the re-entry is automatic, not a human action.
- `advanceWorkflowRunUntilBlocked` is the only production driver. It takes a `TransactionRunner` and opens one short transaction per `advanceWorkflowRun`. It runs `dispatchAndRecord` between them.
- Builders are created **per transaction** (`makeBuilder(tx)`). Builders and the specs they return close over their transaction, so a spec must never outlive it. The builder contract already requires determinism across calls, which is what makes rebuilding safe.
- The HTTP contract is unchanged. Routes still run synchronously and return the same bodies. Only the transaction boundaries moved.

### Scope: what still runs inside a transaction

Tool (`spec.execute`), deterministic, and retrieval Invocations still execute inside the caller's transaction. Today they are all fast and local: `retrieveResearch` is a pure function, and `publishReport` is a local file write. Moving a tool out of the transaction needs the spec §12 idempotency-key pattern for real external side effects, and it is deferred until such a tool exists (§7).

## 3. Invocation state machine

| From | To | Where | Transaction |
|---|---|---|---|
| — | `proposed` | `proposeInvocation` | A |
| `proposed` | `awaiting_approval` | tool, Policy `REQUIRE_APPROVAL` | A |
| `proposed` | `executing` | llm, after reservation + context compilation | A |
| `proposed` | `completed` / `failed` | tool (ALLOW), deterministic, retrieval, or any refusal | A |
| `executing` | `completed` / `failed` | `completeModelDispatch` | B |
| `executing` | `failed` (`interrupted_outcome_unknown`) | `failInterruptedInvocation` | recovery |
| `awaiting_approval` | `completed` / `failed` | `resumeToolSpec` / stop handling | later request |
| `proposed` / `awaiting_approval` / `executing` | `failed` (`execution_error`, or interrupted) | `settleRunAfterStepFailure` (§4.2) | the advance whose step threw |

`executing` is the spec §3a lifecycle state (`proposed → authorized → executing → completed/failed`). `authorized` is not persisted, because it never survives its own transaction.

Every transaction that writes `proposed` also moves the Invocation on before committing. So the only non-terminal Invocation states that can persist are `awaiting_approval` and `executing`.

## 4. Interruption recovery

An Invocation is **interrupted** when it is `executing` and no live dispatcher owns it. That happens after a crash or restart, or when the outcome could not be recorded.

**Decision:** the outcome is **unknown**. The provider may or may not have done the work, and `claude -p` has no idempotency key to ask. Every axis resolves conservatively:

| Axis | Resolution | Why |
|---|---|---|
| Re-dispatch | **Never** | Re-sending could do the work twice and spend twice. A retry is a new Run (spec §3b/§3d), which is an explicit decision and never a side effect of recovery. It is also consistent with "no retry machinery." |
| Budget | Reservation **charged at its full estimate** (`chargeReservationAtEstimate`) | Releasing would hand back capacity the provider may have consumed, so later work could spend it twice. That widens effective authorization based on an unknown. Charging over-counts at worst, and only against a Run that has already failed. |
| Invocation | `failed`, event payload `{ reason: "interrupted_outcome_unknown", outcome: "unknown", reservationCharged }` | States exactly what is known. |
| Event usage | **none** | No usage was observed. Inventing figures would put fiction into the immutable ledger. The counter carries the charge; the event does not. |
| Run | `failed`, outcome `{ reason: "invocation_interrupted", invocationId }` | Stated cause, visible in the Run record. |
| Workflow | Task Instance and Workflow Run `failed` (`settleWorkflowStepForFailedRun`) | Otherwise nothing is left to drive a recovered Workflow Run out of `in_progress`. |

**Two paths, same settlement:**
- **Startup sweep** (`recoverInterruptedInvocations`). Runs before the API listens. At that moment nothing can be in flight, so every `executing` row is interrupted. It uses one transaction per Invocation.
- **Lazy** (`executeRun`). When it meets an `executing` row this process is not dispatching, it settles that row and returns `failed`. Recovery therefore does not depend on the sweep having run.

**Late outcomes:** if recovery has already settled an Invocation, `completeModelDispatch` finds it no longer `executing`. It logs the late outcome and **discards** it, and returns `already_settled`. Applying it would reconcile the same reservation twice.

**Recording failures:** a settlement that cannot complete, for example a corrupt reservation handle or a vanished counter row, is reported and skipped. It never aborts startup, because the same row would fail on every restart. The row stays `executing` for an operator. The startup log names it.

### 4.1 The same rule for recorded failures

A dispatch that **returns** a failure gets the same treatment whenever its consumption is unknown (`completeModelDispatch` → `settleFailedDispatchReservation`):

| Failure | Reservation | Event `reservationSettlement` |
|---|---|---|
| Failed after usage was already reconciled (e.g. result could not be persisted) | real usage stands | `reconciled` |
| Provider failure that declares `consumption: "none"` | **released** | `released` |
| Any other provider failure (timeout, crash mid-stream, missing usage, …) | **charged at estimate** | `charged_at_estimate` (+ `chargedAmount`, `resourceUnit`) |
| Succeeded but usage reported in the wrong unit | **charged at estimate** | `charged_at_estimate` |

- **Who can claim `none`.** An adapter opts into `none` by attaching `consumption: "none"` to its error. That is reserved for failures that provably sent nothing, or that the service refused outright. The Claude adapter maps it to `cli_unavailable`, `misconfigured`, `input_too_large`, `auth_expired` and `quota_exhausted`. The API adapters use it for a missing key or a unit mismatch.
- **Everything else, including any new error code, reads as `unknown`.** This replaced Part 8's earlier "timeout → release" rule in SUBSCRIPTION_PROVIDER_DESIGN, which under-reported calls that almost certainly consumed tokens.

**Exactly one terminal event.** `invocation_completed` is emitted only after the result is persisted, in the same transaction (`emitModelInvocationCompleted`). A failure after reconciliation therefore records `invocation_failed` alone, never both.

### 4.2 Step failure settlement (post-Phase 9)

**The problem.** A step's spec builder and `executeRun` ran directly in the advance transaction. If either threw — for example the publish builder found two report Artifacts, or a Tool Binding row was gone — the whole advance rolled back. A step waiting on an Approval kept its budget hold, and every later advance (the approve route, the TTL sweep, the startup re-drive) repeated the same throw. The Workflow Run could never leave `in_progress`.

**The design.** `advanceWorkflowRun` runs the builder and `executeRun` for a step inside a **savepoint** (`executeStepSettlingFailures` in `interpreter.ts`). A throw rolls back exactly what that attempt did and leaves the transaction usable, so the failure can be recorded in it:

| Error | Handling |
|---|---|
| Transient database error (SQLSTATE class 08, 40, 53, 57, or 55P03 — `src/db/databaseErrors.ts`) | **Rethrown**, nothing recorded. The next advance may succeed. |
| A stop lookup that failed (`ExecutionStoppedError.lookupFailed`) | **Rethrown**. A stop fails closed; it is not a step failure. |
| The Run has an `executing` Invocation this process is dispatching | **Rethrown**, nothing changed. The dispatch records its own outcome. |
| Anything else | **Settled** by `settleRunAfterStepFailure` (`executor.ts`), and the step resolves as failed. |

**Settlement** never performs or re-dispatches anything:

| What | Resolution |
|---|---|
| A **pending** Approval for the Run | Closed as `expired`, actor `system:execution_error`, with its `approval_expired` event. Written before any other event (lock order, §6). |
| An **approved** (or rejected) Approval | Kept as decided. The Invocation's failure states why the approved action did not run. |
| An `awaiting_approval` (or stray `proposed`) Invocation | Its pre-approval hold is **released** (nothing ran); it fails with reason `execution_error: <redacted message>`, `errorCode` when the error has one, and `outcome: "not_performed"`, `reservationSettlement`, `approvalStatus`. |
| An `executing` Invocation with no live dispatcher | Settled as interrupted (§4): charged at estimate, never re-dispatched. This also fails the Run. |
| The Run | `failed`, outcome `{ reason: "execution_error" }`, with `run_failed`. |
| Task Instance and Workflow Run | `failed`, through the ordinary step resolution. |

An already-terminal Run is left as it is. The full error goes to the server log; events carry the redacted reason.

**Why fail rather than wait.** A builder or Executor throw that is not transient comes from the step's own data or definitions, so it repeats on every advance. Failing makes the state honest and releases what the step held. A retry is a new Run, a decision the retry policy owns.

**Tests:** `tests/workflow/stepFailureSettlement.test.ts` (approved and pending steps, a transient error, a live and a dead dispatch), and the approve route end to end in `tests/api/routes.integration.test.ts`.

## 5. Liveness: who owns an `executing` row

`executeRun` must tell a live dispatch (answer `in_flight` and change nothing) from an orphan (settle it). The authority is an **in-process set** of invocation ids being dispatched (`inFlightDispatches`):

- An entry is added in the same transaction that commits `executing`. A stale entry for a rolled-back transaction is inert: its random id is carried by no committed row.
- `dispatchAndRecord` removes the entry in `finally`, whatever the outcome. A dispatch whose outcome could not be recorded therefore becomes recoverable, instead of staying "in flight" forever.

Process memory is the right authority because it dies with the dispatcher. It is only sound if **one process executes against a database**. The spec already assumes that (§13.2); Phase 9 enforces it:

- **`acquireExecutorInstanceLock`.** A session-level advisory lock on a dedicated connection, taken at startup. A second process refuses to start. Postgres releases the lock when the process dies, so a crash never blocks the restart.
- **Separate key space.** It uses the two-integer key form, which is separate from the single-bigint `hashtext(runId)` locks `emitEvent` takes, so the two can never collide.

Tests and scripts that call the executor without taking this lock are single-process by construction.

## 6. Concurrency and lock order

Once a request commits in several transactions, concurrent requests can interleave between them. Two row locks now serialize the critical sections:

- `advanceWorkflowRun` locks the **`workflow_runs` row**. Without it, two advances could both read an empty step slot and create two Task Instances.
- `executeRun` locks the **`runs` row**. Without it, two callers could both propose the same `seqNo`.

**Global lock order:** `workflow_runs` → `runs` → `invocations` → `budget_counters` (day → run → task_instance, per `budget.ts`). The event advisory lock is taken last, at emit time. `completeModelDispatch`, `failInterruptedInvocation` and the startup sweep all take locks in this order.

**Pause and resume** are conditional updates (`… WHERE status = 'in_progress'` / `'paused'`). Otherwise a pause racing an advance that is finishing the Workflow Run waits for its row lock, then overwrites `completed` with `paused`.

**Stop on the approval-resume path:** the pending Approval is expired *before* any event is emitted. `resolveApproval` locks the approval row and then the Run's event advisory lock. Taking them in the opposite order here would let a concurrent approve deadlock with the stop.

**Approvals:** the approve/reject route now commits `resolveApproval` before advancing. Exactly-once resolution still rests on its conditional `UPDATE … WHERE status = 'pending'`: a losing concurrent resolution throws before reaching the driver. The seed lookup happens before resolution, so a missing seed cannot leave a decided Approval with nothing to act on.

**Stops:** a stop engaged during a dispatch does not un-send the call. `completeModelDispatch` still records its real consumption and result, and the stop takes effect at the next Invocation boundary (spec §9.7). The `executing` branch in `executeRun` is checked before the containment checks for the same reason.

## 7. Residuals and deferred work

1. **Tool side effects inside the transaction.** A crash after `publishReport` writes its file but before commit leaves the file with no record. The fix is the spec §12 idempotency key: the adapter checks "has an Invocation with this key already succeeded". Deferred until a tool with real external effects exists.
2. **An in-flight child cannot be stopped.** Stops and pauses act at Invocation boundaries, and the adapter timeout is the only bound on a running child (SUBSCRIPTION_PROVIDER_DESIGN Part 11).
3. **Stranded mid-request work.** A request commits in several transactions, so its process can die, or its advance can throw, between them. Examples: an Approval committed but not yet advanced, or a dispatch recorded but the Run not continued.
   - **After a restart**, `redriveInProgressWorkflowRuns` continues every `in_progress` Workflow Run in the background through the ordinary driver. All checks run again, and a paused run is untouched.
   - **Without a restart**, `POST /workflow-runs/:id/advance` re-drives an `in_progress` run through the same driver. Approve answers "already resolved", and resume only accepts `paused`, so this is the explicit repair.
   - **Goal retries duplicate.** A failed `POST /goals` whose Goal already committed creates a duplicate Goal when retried.
4. **Ambiguous COMMIT.** The in-flight entry is added inside the transaction that commits `executing`. If COMMIT succeeds on the server but the client sees an error (a connection reset), the driver never dispatches and the entry stays: the Run answers `in_flight` until a restart. The restart's sweep then charges the estimate for a call that was never sent. Rare, and conservative. A real fix needs an ownership token in the row, or a driver that reads the row back after a commit error.
5. **Lost recording.** If the transaction recording a *successful* dispatch fails, for example as a deadlock victim, the result is discarded. The Invocation is later settled as interrupted, at estimate. Conservative, but a known result becomes "unknown". Retrying only the recording transaction, never the dispatch, would preserve it.
6. **Live SSE delivery happens per commit (resolved).** `createWorkflowRelay`'s runner relays each transaction's events right after it commits. The events before a dispatch, including `context_compiled`, therefore reach subscribers while the provider call is still running. Emergency-stop events are relayed after their commit too. Two concurrent requests on the same Workflow Run can each relay the other's events; the SSE route deduplicates by event id.
7. **Tools still hold locks while they execute.** A tool runs inside its transaction, holding the Run's usd counters, including the DAY usd counter once configured. A slow future tool would serialize usd reservations behind it. That is harmless while every tool is local.
8. **The DAY ceiling is now unblocked.** Provider calls no longer hold budget locks, so Phase 8's deferred item #4 no longer depends on Phase 9. The ceiling values and timezone remain operator decisions.
9. **The instance lock guards only `start.ts`.** Any other process that advances Runs against the same database, such as a future CLI script, must take the lock too, or it will settle the server's live dispatches as interrupted. If the lock connection is lost, the server exits.
10. **A throw while resuming a step left its hold reserved (resolved).** See §4.2: the step now fails, its hold is released and its Approval state is recorded honestly. Only a transient database error still propagates, and the next advance retries it.
11. **A stop committed during context compilation does not stop that dispatch.** The stop check runs at the top of each Invocation, before routing and context compilation. A stop that commits after that check, but before `dispatchModelCall` starts, lets that one call go out; the next Invocation is refused. The window is the compile time plus one commit. Closing it needs a second stop check at dispatch, which would settle as consuming nothing.

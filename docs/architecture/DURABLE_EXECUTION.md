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

**Tests:** `tests/execution/durableExecution.test.ts`, `tests/execution/toolDispatch.test.ts`, `tests/workflow/stepFailureSettlement.test.ts`.

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

### 2.1 Tool side effects (post-Phase 9)

A Tool Invocation follows the same yield-and-record shape as an LLM Invocation. Before this, a tool ran inside the transaction that also recorded it. A crash after `publishReport` wrote its file but before commit rolled the Invocation back to `awaiting_approval` with its approved Approval, and the next advance published a second time.

```
tx A  executeRun ─ Grant, Policy, budget reservation (and on resume: Approval,
                   reauthorize, fresh reservation)
                   invocation.status = 'executing'; pendingReservations[seqNo]
                   COMMIT                                  → yields dispatch_required {kind:"tool"}
tx P  toolDispatchRefusal ─ stops (every scope), Grant + Tool Binding
                   trust through Policy, Approval reauthorize     (refusal → consumption "none")
(no tx) spec.execute({ invocationId, idempotencyKey }) ─ the side effect
tx B  completeToolDispatch ─ reconcile at estimate, artifact, completed
                   (or: release / charge at estimate, fail invocation + Run)
```

**Invariants.**
- A tool's `execute` is never called inside a transaction, and never by the Executor. Only the driver's `performToolDispatch` calls it (`tests/execution/structuralInvariants.test.ts`). Deterministic and retrieval Invocations are internal and still run in the Executor's transaction.
- `execute` must not close over a transaction. A builder reads what the effect needs when the spec is built; `publishReport` receives the approved content, never a transaction to look it up with.
- An Invocation's effect is attempted **at most once**. The `executing` commit is the claim. A concurrent path finds it in flight, and an interrupted one is settled (§4), never repeated.
- The Invocation's persisted `idempotency_key` is passed to the adapter (spec §12 implementation note). An adapter that can recognise its own earlier effect does: `publishReport` writes atomically, reports a destination already holding the approved bytes as published, and refuses one holding anything else.

**Settlement** follows §4.1. A tool reports no cost, so success reconciles at the estimate. An error carrying `consumption: "none"` releases the reservation: the pre-effect re-check's refusals, and `publishReport`'s refusals before writing. Any other error is charged at estimate, because the effect may have happened. This replaces the earlier rule, "a thrown tool releases".

**Tests:** `tests/execution/toolDispatch.test.ts`. They cover the claim committed before the effect, a dead dispatcher, the startup sweep, a late outcome, a stop and a trust downgrade after the claim, error settlement, and concurrency across real connections. Each was confirmed to fail with the claim or the re-check removed.

## 3. Invocation state machine

| From | To | Where | Transaction |
|---|---|---|---|
| — | `proposed` | `proposeInvocation` | A |
| `proposed` | `awaiting_approval` | tool, Policy `REQUIRE_APPROVAL` | A |
| `proposed` | `executing` | llm, after reservation + context compilation; tool (ALLOW), after reservation | A |
| `proposed` | `completed` / `failed` | deterministic, retrieval, or any refusal | A |
| `executing` | `completed` / `failed` | `completeModelDispatch` / `completeToolDispatch` | B |
| `executing` | `failed` (`interrupted_outcome_unknown`) | `failInterruptedInvocation` | recovery |
| `awaiting_approval` | `executing` | `resumeToolSpec`, after reauthorize + fresh reservation | later request |
| `awaiting_approval` | `failed` | `resumeToolSpec` refusals / stop handling | later request |
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

- An entry is added in the same transaction that commits `executing`. A stale entry for a rolled-back transaction is inert: every reader only asks about `executing` rows, and the rolled-back Invocation is not `executing` (a fresh one has no row; a resumed one is still `awaiting_approval`).
- `dispatchAndRecord` removes the entry in `finally`, whatever the outcome. A dispatch whose outcome could not be recorded therefore becomes recoverable, instead of staying "in flight" forever.

Process memory is the right authority because it dies with the dispatcher. It is only sound if **one process executes against a database**. The spec already assumes that (§13.2); Phase 9 enforces it:

- **`acquireExecutorInstanceLock`.** A session-level advisory lock on a dedicated connection, taken at startup. A second process refuses to start. Postgres releases the lock when the process dies, so a crash never blocks the restart.
- **Separate key space.** It uses the two-integer key form, which is separate from the single-bigint `hashtext(runId)` locks `emitEvent` takes, so the two can never collide.

Tests and scripts that call the executor without taking this lock are single-process by construction.

## 6. Concurrency and lock order

Once a request commits in several transactions, concurrent requests can interleave between them. Two row locks now serialize the critical sections:

- `advanceWorkflowRun` locks the **`workflow_runs` row**. Without it, two advances could both read an empty step slot and create two Task Instances.
- `executeRun` locks the **`runs` row**. Without it, two callers could both propose the same `seqNo`.

**Global lock order:** `workflow_runs` → `runs` → `invocations` → `budget_counters` (day → run → task_instance, per `budget.ts`). `completeModelDispatch`, `completeToolDispatch`, `failInterruptedInvocation`, `settleRunAfterStepFailure` and the startup sweep all take row locks in this order.

**The event advisory lock is not strictly last.** It is taken at emit time; `invocation_started`, for example, is emitted before `reserveBudget` locks the counters. The real invariant is narrower. All work on one Run is serialized by its `runs` row lock, so its own event lock never contends with itself. And no transaction that holds a DAY counter waits for ANOTHER Run's event lock. An Approval row is always locked before any event lock (`resolveApproval`, the stop path and step-failure settlement).

**Pause and resume** are conditional updates (`… WHERE status = 'in_progress'` / `'paused'`). Otherwise a pause racing an advance that is finishing the Workflow Run waits for its row lock, then overwrites `completed` with `paused`.

**Stop on the approval-resume path:** the pending Approval is expired *before* any event is emitted. `resolveApproval` locks the approval row and then the Run's event advisory lock. Taking them in the opposite order here would let a concurrent approve deadlock with the stop.

**Approvals:** the approve/reject route now commits `resolveApproval` before advancing. Exactly-once resolution still rests on its conditional `UPDATE … WHERE status = 'pending'`: a losing concurrent resolution throws before reaching the driver. The seed lookup happens before resolution, so a missing seed cannot leave a decided Approval with nothing to act on.

**Stops:** a stop engaged during a dispatch does not un-send the call. `completeModelDispatch` still records its real consumption and result, and the stop takes effect at the next Invocation boundary (spec §9.7). The `executing` branch in `executeRun` is checked before the containment checks for the same reason.

## 7. Residuals and deferred work

1. **Tool side effects inside the transaction (resolved).** Tools now dispatch outside the transaction, after a durable `executing` claim (§2.1).
2. **An in-flight child cannot be stopped.** Stops and pauses act at Invocation boundaries, and the adapter timeout is the only bound on a running child (SUBSCRIPTION_PROVIDER_DESIGN Part 11).
3. **Stranded mid-request work.** A request commits in several transactions, so its process can die, or its advance can throw, between them. Examples: an Approval committed but not yet advanced, or a dispatch recorded but the Run not continued.
   - **After a restart**, `redriveInProgressWorkflowRuns` continues every `in_progress` Workflow Run in the background through the ordinary driver. All checks run again, and a paused run is untouched.
   - **Without a restart**, `POST /workflow-runs/:id/advance` re-drives an `in_progress` run through the same driver. Approve answers "already resolved", and resume only accepts `paused`, so this is the explicit repair.
   - **Goal retries duplicate.** A failed `POST /goals` whose Goal already committed creates a duplicate Goal when retried.
4. **Ambiguous COMMIT (liveness resolved 2026-09-14).** The in-flight entry is added inside the transaction that commits `executing`. If COMMIT succeeds on the server but the client sees an error (a connection reset), the driver never dispatches. The driver now runs each advance through `releasingDispatchClaimsOnFailure`, which gives up the slots that call claimed (tracked per call with `AsyncLocalStorage`, so another request's slot is never touched). The ownerless row is settled as interrupted by the next advance instead of answering `in_flight` until a restart. Still conservative: it charges the estimate for a call that was never sent, as the sweep did. Recovering that charge would need an ownership token in the row.
5. **Lost recording.** If the transaction recording a *successful* dispatch fails, for example as a deadlock victim, the result is discarded. The Invocation is later settled as interrupted, at estimate. Conservative, but a known result becomes "unknown". Retrying only the recording transaction, never the dispatch, would preserve it. **Decision needed:** not built. The retry policy decided 2026-09-15 retries failed Runs, not recording transactions; with it, a lost recording is retried as a new Run (unknown consumption), which spends the call again. `ROADMAP_STATUS.md` §6 (D4).
6. **Live SSE delivery happens per commit (resolved).** `createWorkflowRelay`'s runner relays each transaction's events right after it commits. The events before a dispatch, including `context_compiled`, therefore reach subscribers while the provider call is still running. Emergency-stop events are relayed after their commit too. Two concurrent requests on the same Workflow Run can each relay the other's events; the SSE route deduplicates by event id.
7. **Tools held locks while they executed (resolved).** A tool's `execute` holds no transaction (§2.1).
8. **The DAY ceiling is now unblocked.** Provider calls no longer hold budget locks, so Phase 8's deferred item #4 no longer depends on Phase 9. **Active since 2026-09-15 (D3):** `usd` 5.00 and `subscription_tokens` 200,000 per local calendar day, alongside Task Instance counters (D20). The day row is held only by the short reserve and reconcile transactions (`BUDGET_CONTAINMENT_CLOSURE.md`).
9. **The instance lock guards only `start.ts`.** Any other process that advances Runs against the same database, such as a future CLI script, must take the lock too, or it will settle the server's live dispatches as interrupted. If the lock connection is lost, the server exits.
10. **A throw while resuming a step left its hold reserved (resolved).** See §4.2: the step now fails, its hold is released and its Approval state is recorded honestly. Only a transient database error still propagates, and the next advance retries it.
11. **A stop committed during context compilation does not stop that LLM dispatch (resolved 2026-09-14).** The driver now re-checks stops in a short transaction immediately before `dispatchModelCall` (`modelDispatchRefusal`), as tools already were (§2.1). A refusal settles as consuming nothing (the hold is released) and halts the Run naming the stop. What remains is the same window as #12: one commit and a function call (`tests/execution/durableExecution.test.ts`).
12. **The pre-effect re-check leaves a small window.** Between `toolDispatchRefusal` committing and `execute` starting, a stop or revocation can still land; it takes effect at the next Invocation. The window is one commit and a function call.
13. **The startup sweep can fail a paused Workflow Run** (decision needed). If a pause commits while an Invocation is `executing` and the process then dies, the sweep settles the Invocation and also fails the paused Workflow Run. That is accurate, since the Run did fail, but it overrides the pause. The alternative is to leave it paused with a failed Run and let the operator's resume fail it. Since the retry policy (2026-09-15), a *retryable* interrupted step is left unfinished and its Workflow Run keeps its status, paused included; the operator's resume starts the retry. The decision remains for a step that is not retried.
14. **A crash before any claim can crash-loop the startup re-drive** (decision needed). If building specs or compiling context kills the process itself (for example running out of memory on a huge artifact), everything rolls back, and every restart re-drives into the same crash. Nothing is spent, but the API goes down each cycle. A fix needs an attempt count on the Workflow Run and a rule for when to stop re-driving it. The 2026-09-15 retry policy does not cover it: it counts failed Runs, and a crash before any claim rolls back, leaving no failed Run to count.
15. **Recovery gaps closed after the recovery audit (resolved).**
   - An approved tool's Run now returns to `active` when its dispatch is claimed. It used to keep reading `awaiting_approval` while executing.
   - The TTL sweep also re-drives an `expired` Approval whose Invocation still waits, so a re-drive that failed after the expiry committed is retried rather than holding its budget until a restart.
   - The TTL sweep starts at startup alongside the re-drive, not after it.
   - Stop audit events a crash lost between flip and event are backfilled at startup (`backfillStopEvents`).
16. **A transient failure of the pre-effect check uses up the Approval.** `performToolDispatch` records any failure of its check transaction as consuming nothing: a dropped connection, or a failed stop lookup. Since 2026-09-14 the same holds for an LLM step's pre-dispatch stop check (#11): a transient failure fails the step with nothing consumed rather than dispatching. The Invocation then fails, so the approved action cannot run, and doing it needs a new Run. Nothing is over-charged. Rethrowing instead would not save the Approval either: the claimed Invocation would be settled as interrupted and charged at estimate. Preserving it would need a way to hand a claim back, which is not built.
17. **The Approval's TTL is checked again just before the effect (resolved 2026-09-14).** `reauthorize` applied the TTL to an Approval whatever its status, so an approved Approval failed once its TTL passed — milliseconds after approval, or hours later when its Workflow Run was paused, or re-driven after a failed advance. Spec §9.5 expires *unresolved* Approvals, so the TTL check now skips an `approved` one (`tests/governance/approvals.test.ts`).
18. **Concurrency review fixes (resolved).** Step-failure settlement racing an approve now records the Approval's real decision, not the stale `pending` it read. A stop caught by the pre-effect check is recorded like one caught at the Invocation boundary, with the stop named in the outcome and `run_halted`. The step savepoint has a unique name, so a nested savepoint cannot shadow it.
19. **An interrupted tool is not asked whether its effect happened.** An adapter such as `publishReport` could verify its own effect after a crash, and record success instead of `outcome: "unknown"`. Recovery does not yet ask it: the step fails, charged at estimate, and a retry is a new Run.
20. **A Goal's derived status can miss concurrent Workflow Run finishes** (2026-09-15, unreachable today). `recordGoalStatus` reads a Goal's other Workflow Runs without locking the Goal, so two of its Workflow Runs finishing in concurrent transactions each see the other unfinished and leave the Goal `active`. Every Goal has one Workflow Run today. The fix, once that changes, is to lock the `goals` row before reading its siblings (lock order `workflow_runs → goals`). `BUDGET_CONTAINMENT_CLOSURE.md`.

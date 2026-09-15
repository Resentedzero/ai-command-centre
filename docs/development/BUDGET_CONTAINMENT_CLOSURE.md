# Budget Containment and Lifecycle Decisions: Closure

**Started:** 2026-09-15, on the operator's decisions D3, D20, D34, R-EV1, R-GOAL1, R-ART1 and R-P9.
**Status:** built. Local commits on `main`, none pushed.
**Roadmap stage:** V1 conformance and V2 cost governance (spec §8.2, §8.5, §3e, §9.5, §12). One migration (`0019`, triggers only). No new infrastructure, no live model calls; every provider adapter is mocked.

## The decisions implemented

| ID | Decision | Built as |
|---|---|---|
| D3 | Daily ceilings: `usd` 5.00, `subscription_tokens` 200,000; day boundary = local calendar day | `DAILY_BUDGET_CEILINGS`, `dayScopeRef` (`governance/dailyBudgetPolicy.ts`) |
| D20 | Task Instance counters: `usd` 1.00, `subscription_tokens` 50,000 | `TASK_INSTANCE_BUDGET_CEILINGS` (`governance/runBudgetPolicy.ts`); the hold in `reserveBudget` (`governance/budget.ts`) |
| D34 | A stopped parked Run is permanently terminated | Confirmed: already the behaviour; no code change |
| R-EV1 | Emit `workflow_run_paused` and `workflow_run_resumed` | `pauseWorkflowRun`, `resumeWorkflowRun` (`workflow/interpreter.ts`) |
| R-GOAL1 | Goal status is derived from its Workflow Runs; transitions are events | `deriveGoalStatus`, `recordGoalStatus` (`workflow/interpreter.ts`) |
| R-ART1 | Artifacts are immutable, enforced by the database; `artifact_updated` retired | Migration `0019_artifacts_immutability` |
| R-P9 | Confirm the seven Phase-9 behaviours as implemented | Confirmed: recorded below and in `POST_PHASE9_CLOSURE.md`; no code change |

The 200,000 `subscription_tokens` daily value is an application governance ceiling. It is not a claim about Claude Max entitlement or any provider's quota.

## Counter semantics (D3, D20)

Every production reservation is made at `run` scope, by the Model Router for an LLM Invocation (in the routed candidate's unit) and by the Executor for a tool Invocation (in `usd`). Each reservation now holds, **for its one resource unit**:

| Counter | Key | Limit | Created |
|---|---|---|---|
| Run | the Run's id | `RUN_BUDGET_CEILINGS`: `usd` 1.00, `subscription_tokens` 200,000 (unchanged) | by `provisionRunBudgets`, as before |
| Day | the local calendar date, `YYYY-MM-DD` | `DAILY_BUDGET_CEILINGS`: `usd` 5.00, `subscription_tokens` 200,000 | on first reservation of the day, at the ceiling |
| Task Instance | the Run's `task_instance_id` | `TASK_INSTANCE_BUDGET_CEILINGS`: `usd` 1.00, `subscription_tokens` 50,000 | on first reservation of the Task Instance, at the ceiling |

- **All must have room.** A reservation of `estimate` is authorized only if `estimate ≤ limit − reserved − consumed` on every held counter. Otherwise nothing is written to any counter, and one `budget_denied` names the counter that refused (`day`, `run` or `task_instance`) with its exact amounts.
- **Every attempt of a Task shares one Task Instance counter.** The first Run and each retry Run the retry policy starts (D1: up to 3 Runs) reserve against the same row, so a Task's total spend is bounded by 50,000 tokens or $1.00 however many attempts it takes. Each Run's own counter still applies.
- **Settlement moves every held counter.** Reconcile (reported usage), charge at estimate (unknown consumption) and release (nothing consumed) apply to exactly the counters the reservation holds, recorded in the reservation id. One `budget_consumed` event names all of them, so each counter's `consumed_amount` is still the sum of its events.
- **Lock order** is fixed: day → run → task_instance, in reserve, reconcile and release (DURABLE_EXECUTION §6).
- **Fail closed.** A `run`-scope reservation whose Run has no row has no Task Instance to charge: it is refused (`deniedCounter.scope: "task_instance"`, `missing: true`), never allowed without the hold.
- **Never raised.** An existing day or Task Instance counter keeps its limit; `onConflictDoNothing` makes concurrent first reservations converge on one row. Changing a constant affects new days and new Task Instances only.
- **No caller can override.** The ceilings are frozen. `reserveBudget`'s injection options (`dailyCeilings`, `taskInstanceCeilings`, `now`) exist for tests; a structural test refuses any production call that passes an options object, and any `src/` file other than `budget.ts` that names either ceilings option.
- **`deterministic` cost class** holds no counter, as before.

**Units stay separate.** Every counter is keyed by `(scope, scope_ref_id, resource_unit)`, a reservation carries exactly one unit, and no code path sums, converts or substitutes between `usd` and `subscription_tokens`. Exhausting one unit's day or Task Instance allowance leaves the other's whole (tested).

**Consequences of the values, not choices made here.**
- The Task Instance token ceiling (50,000) is below the Run ceiling (200,000), so for tokens the Task Instance counter binds first; for `usd` the two are equal ($1.00).
- The daily token ceiling (200,000) equals one Run's token ceiling, and is four Task Instances' worth.
- A seeded research step reserves about 8,500 tokens per LLM call (8,000 input + 500 output), so three attempts fit within 50,000.

## Day boundary (D3)

`dayScopeRef(now)` returns the local calendar date from `getFullYear`, `getMonth` and `getDate`. "Local" is the API process's time zone: the `TZ` environment variable when set, otherwise the operating system's zone. A day runs from local midnight to local midnight, including daylight-saving days. The day is chosen when the reservation is made, and settlement moves the counter recorded in the reservation, so a call that spans midnight is charged to the day it reserved in. Tested with fixed zones on both sides of UTC.

## Lifecycle events (R-EV1, R-GOAL1)

- **Pause and resume.** `pauseWorkflowRun` and `resumeWorkflowRun` emit `workflow_run_paused` / `workflow_run_resumed` in the same transaction as the conditional status write, actor `human:operator`, correlated to the Goal and Workflow Run, payload `{ from, to }`. A Workflow Run can be paused many times, so each emission has its own idempotency key. A refused pause or resume writes nothing. Both left the structural test's no-event allowlist, which is now empty of Workflow Run transitions.
- **Goal status.** After a Workflow Run starts or finishes, its Goal's status is re-derived from all its Workflow Runs. **The rule below is CLI1's reading of R-GOAL1; the operator's decision named no rule, so it needs the operator's confirmation:**
  - `active` while the Goal has no Workflow Run or any is unfinished (`in_progress`, `paused`);
  - once every one has finished, `completed` if every one completed, otherwise `failed`.

  A change writes `goals.status` and emits `goal_completed`, `goal_failed` or `goal_transitioned`, keyed by the Goal and the Workflow Run that caused it, payload `{ from, to, workflowRunId }`. `goal_transitioned` (also CLI1's addition) covers a finished Goal made active again by a new Workflow Run, which no route does today: `POST /goals` starts exactly one Workflow Run per new Goal. An unchanged status writes nothing. Pause and resume never change it. All Workflow Run status writes are in the interpreter, so the sweep, approval expiry and ordinary advances all pass through this. `goals` joined the structural test's status tables. Since `goals.status` now reads `completed` or `failed`, the Goals screen shows those values; no UI code changed.
- **Residual: concurrent finishes of one Goal's Workflow Runs.** `recordGoalStatus` reads the sibling Workflow Runs' statuses without locking the Goal. If two Workflow Runs of the same Goal finish in concurrent transactions, each sees the other still `in_progress`, both derive `active`, and the Goal stays `active` with every Workflow Run finished. Unreachable today (one Workflow Run per Goal). When a second Workflow Run per Goal becomes possible, lock the Goal first (`SELECT … FROM goals WHERE id = ? FOR UPDATE`, lock order `workflow_runs → goals`) before reading its siblings. DURABLE_EXECUTION §7 #20.

## Artifacts (R-ART1)

Migration `0019_artifacts_immutability` adds triggers that refuse UPDATE, DELETE and TRUNCATE on `artifacts`, as `0016` does for `events`. Approvals pin an Artifact's content hash (§9.5) and compiled contexts record the exact artifact id, version and hash they included (§5.13), so an edit would silently change what those records describe. A new version is a new row with its own `artifact_created`. `artifact_updated` is retired; `artifact_referenced` is still not emitted. No production code updated or deleted an Artifact. Test tampering goes through `rewriteArtifactForTest`, which lifts the trigger inside one transaction.

## D34: a stopped parked Run is permanently terminated

Confirmed as built: a re-drive during any stop fails an `awaiting_approval` Run for good, expires its pending Approval and records `run_halted` (Phase 8). A halted Run is never retried (D1), and lifting a stop never revives it. Pinned by `tests/governance/executionStop.test.ts`.

## R-P9: the seven Phase-9 behaviours, confirmed as implemented

1. Interrupted Invocations are never re-dispatched; their reservation is charged at its full estimate and the Run fails.
2. Failed dispatches of unknown consumption are charged at estimate; only failures that provably sent nothing, or were refused outright, release.
3. One executor process per database, enforced by an advisory lock at startup; the process exits if the lock connection is lost.
4. Startup re-drives every `in_progress` Workflow Run through the ordinary driver, with all governance checks.
5. An expired Approval is handled as a rejection; the TTL stays one hour.
6. Goal title and description are trusted task state and are not fenced.
7. The approval hash pin is required; an Approval created before it fails closed on resume.

Behaviour 1 is as later refined by D1: an interrupted LLM Invocation's step may be retried as a **new Run**, never by re-dispatching the interrupted call.

## Unchanged

N = 10 (`MIN_PERFORMANCE_SAMPLES`), the D1 retry policy (2 retries, 3 Runs), the Run ceilings, and every emergency-stop semantic. Not built, by instruction: `CONDITIONAL` autonomy, Budget Governor downgrade/degrade, tier or model controls.

## Tests

- `tests/governance/taskInstanceBudget.test.ts`: shipped values; attempts share one counter; the Run counter still refuses; units separate; never raised; fail closed on a missing Run; lock-ordered holds; reconcile and release move all three; the shipped configuration holds day, run and task_instance.
- `tests/integration/taskInstanceBudgetContainment.test.ts`: with no policy mocked, a second fully funded attempt of one Task Instance is refused through `executeRun` → `authorizeRoute` → `reserveBudget`, with one provider call and no API fallback.
- `tests/governance/dailyBudget.test.ts`: the shipped D3 values; local day keys, including zones either side of UTC.
- `tests/workflow/interpreter.test.ts`: pause/resume events across repeated cycles; `deriveGoalStatus`; `goal_completed`, `goal_failed` and `goal_transitioned` through real advances.
- `tests/events/lifecycleEvents.test.ts`: a Workflow Run's event sequence now ends with the Goal's event.
- `tests/db/artifactImmutability.test.ts`: UPDATE (content, version, summary), DELETE and TRUNCATE refused; a new version is a new row.
- `tests/execution/structuralInvariants.test.ts`: pause/resume leave the allowlist; `goals` status writes must record events.
- Files that pin Run-counter or executor/router mechanics with fixture amounts above the new ceilings (`budget`, `resourceUnit`, `budgetDenied`, `lifecycleEvents`, `executor`, `toolDispatch`, `modelRouter`) switch the day and Task Instance ceilings off with a file-wide mock, as `dailyBudgetContainment.test.ts` already did. No assertion was removed.

## Operator step

Apply migration `0019` with `npm run db:migrate` before restarting the API on this code. It adds triggers only and changes no row. The API's startup re-drive rules are unchanged (check for unfinished Workflow Runs first).

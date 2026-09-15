# Retry Policy and Escalation: Closure

**Started:** 2026-09-15, on the operator's decision D1.
**Status:** built. Local commits on `main`, none pushed.
**Roadmap stage:** V4's escalation loop (spec §10.4) and the §3d retry limit. One migration (`0017`, one nullable column). No new infrastructure, no live model calls; every provider adapter is mocked.

## The decision implemented

> D1: c. Retry limit: 2 retries (3 total attempts).

Option (c) in the decision brief: a retry limit with eligible failures (provider failures of unknown consumption, output-validation failures; never Policy denials, rejected Approvals or stops), plus escalation one tier on a validation failure, bounded (§10.4).

## What the policy does

`src/governance/retryPolicy.ts`: `RETRY_LIMIT = 2`, `MAX_RUN_ATTEMPTS = 3`.

| A Run of a Task Instance failed because… | Retried? | Tier |
|---|---|---|
| its LLM Invocation's provider failed with unknown consumption (`providerConsumption: "unknown"`: a timeout, a crash mid-stream, missing usage, a usage report in the wrong unit) | yes | same floor |
| its LLM Invocation was interrupted by a dead process (`interrupted_outcome_unknown`) | yes | same floor |
| its LLM Invocation's output failed the provider's structured-output validation (`errorCode: "schema_validation"`) | yes | one tier above the tier that failed |
| the same, at STRONG | no: the Task fails | — |
| anything else: Policy denial, rejected or expired Approval, stop (`run_halted`), budget or quota refusal, a provider failure that consumed nothing (expired login, exhausted quota, missing CLI), a step execution error, a resume mismatch, **any Tool Invocation failure** | no | — |

Every entry is a reading of the brief's wording against the failure records this codebase actually writes. Strike or add an entry and it is a one-line change with a test.

## Where it acts

| # | Change | Where |
|---|---|---|
| 1 | The decision: `retryDecision` (pure) over facts read from the failed Run's row and events (`readRunFailure`), and the Run count of its Task Instance | `governance/retryPolicy.ts` |
| 2 | On a failed step, the Interpreter asks the policy. A retry inserts a new Run against the same Task Instance (which stays unfinished: `active`, with a transition recorded if it was still `pending`), records `run_started` with `{attempt, retryOfRunId, cause, minimumModelTier}`, and points the step's `stepRunIds` slot at it. The next advance runs it. Otherwise the Task Instance and Workflow Run fail as before | `workflow/interpreter.ts` (`resolveStepOutcome`, `startRetryRun`) |
| 3 | A step whose current Run already failed (a dispatch recorded the failure) is resolved without building a plan for a finished Run | `advanceWorkflowRun` |
| 4 | The startup sweep leaves a retryable interrupted step unfinished; the re-drive retries it through the ordinary advance, with every check | `settleWorkflowStepForFailedRun` |
| 5 | Escalation floor: `runs.minimum_model_tier`, set on the retry Run. The Router routes from `max(difficulty/risk default, floor)`, then applies tier preference upward from there, and records `escalationFloor` on `invocation_started` and on a refused route's decision | migration `0017`; `router/modelRouter.ts` |
| 6 | Plans find "the Run of this Task Instance" as its one unfinished Run, failing closed otherwise (was: the first row) | `capabilities/shared/runProvisioning.ts` |
| 7 | Publishing reads the source step's **completed** Run, never a failed attempt's partial output | `capabilities/publishReport/buildInvocationSpecs.ts` |
| 8 | The driver's bound is steps × 3 counted advances | `workflow/advanceWorkflowRunUntilBlocked.ts` |
| 9 | `GET /workflow-runs/:id` adds `attempts` per step (every Run, in start order); `run` stays the current one. Additive | `api/routes/workflowRuns.ts` |

## Consequences that follow from the spec, not from a choice

- **A retry needs fresh Approvals.** An Approval gates one Invocation (§3c), and a retry Run proposes new Invocations.
- **Each attempt has its own Run budget** (`RUN_BUDGET_CEILINGS`): a Task can spend up to three Run ceilings.
- **Retries are samples.** A failed attempt counts toward `agent_performance` like any other agent failure, and `avg_retries` is no longer always 0. Escalated attempts produce samples on a second tier, which is what tier preference compares.

## Open, recorded for the operator (not decided here)

- **Validation failure at STRONG.** §10.4 allows "task failure or REQUIRE_APPROVAL". No Approval path exists for an LLM Invocation, so it is task failure; an approval path would be new machinery.
- **Which adapters validate.** Only the Claude CLI's structured output reports `schema_validation`. The API adapters do not check the shape, and Task output schemas are never validated (D18), so a malformed API result completes. A validator is not built: the Anthropic adapter's content-block result would fail a naive shape check on every call and escalate everything.
- **Total spend per Task.** Three attempts × the Run ceiling, with no Task Instance counter (D20) and no day ceiling (D3).
- **Escalation meeting an unauthorizable tier.** The escalated tier is reserved and candidate-checked like any other, with no fallback (D6). If configuration ranked a `usd` candidate at the higher tier, escalation would spend money rather than subscription tokens; today every tier's primary candidate is the subscription.
- **A stop during retries.** A retry created while a stop is engaged is halted at its first Invocation, which ends the Task (a halted Run is never retried): consistent with stops permanently failing parked Runs (D34).
- **A paused Workflow Run.** The startup sweep no longer fails a paused Workflow Run whose interrupted step is retryable; it stays paused and the operator's resume retries it (narrows DURABLE_EXECUTION §7 #13 for that case).
- **Not covered:** retrying a recording transaction (DURABLE_EXECUTION §7 #5, D4) and the re-drive crash loop (§7 #14): neither leaves a failed Run to count.
- **UI:** the Workflow view shows the current Run only; listing `attempts` is UI work.

## Tests

- `tests/governance/retryPolicy.test.ts`: the limit (attempts 2 and 3 allowed, a 4th refused), each eligible cause, escalation CHEAP→MID→STRONG, exhaustion at STRONG, and every ineligible class.
- `tests/workflow/retries.test.ts`, through the HTTP API with the seeded workflow: a retried step completes on its second Run with the Task Instance never recording a failure; three failures fail the step and Workflow Run after exactly three provider calls; a validation failure routes the retry to MID with the floor recorded; a consumption-free failure is not retried; an interrupted dispatch left by a "crash" is swept, left unfinished, and retried by the re-drive.
- `tests/execution/durableExecution.test.ts`: the sweep leaves a retryable step unfinished, and fails it when the attempts are exhausted.
- `tests/capabilities/publishReportSourceAmbiguity.test.ts`: two completed source Runs refused; all-failed refused; failed attempt plus completed Run accepted.
- `tests/governance/retryPolicy.test.ts` also reads real rows: the Run's last failure (not its first) and its own tier floor.

## Mutation checks

Each mutant was applied, its tests run, and the file restored byte-for-byte.

| Mutant | Result |
|---|---|
| R1 a 4th Run allowed (`>=` to `>`) | caught |
| R2 a Tool Invocation failure retried | caught |
| R3 a halted Run retried | caught |
| R4 consumption-free provider failures retried | caught |
| R5 a validation failure not escalated | caught |
| R6 escalation past STRONG not exhausted | caught |
| R7 an unknown-consumption retry drops its floor | caught |
| R8 the reader ignores the failed Run's floor | survived at first; reader test added; caught |
| R9 the reader takes the first failure, not the last | survived at first; reader test added; caught |
| R10 the Router ignores the floor | caught |
| R11 the Interpreter never retries | caught |
| R12 the sweep fails a retryable step | caught |
| R13 the retry Run not made the step's current Run | caught |
| R14 plans pick any Run of the Task Instance | caught |
| R15 publishing counts failed attempts | caught |
| R16 the driver bound ignores retries | caught |
| R17 the floor not recorded on the route | caught |

- Changed deliberately, none removed: the redaction test now sees three failure events (one per attempt); the sweep test's expected step state; the Router's exact payload gains `escalationFloor`.

# Agent Performance Projection

**Implements:** spec §8.3 (asynchronous projections), §8.8 (agent performance), §8.10 (in-process loop), §10.5 (useful work per unit, measured), Phase 12 (`agent_performance`), Phase 19 V2. **Status:** built; milestone closed (`docs/development/AGENT_PERFORMANCE_CLOSURE.md`).

## 1. What it is

A read-side aggregate over Events, per **Agent Definition version × Task Definition × model tier**: sample count, success rate, average retries and average cost per resource unit. It is governance-facing data, displayed whatever the sample count, and it reaches a decision only through the **minimum sample criterion** (Phase 19 V2/V4, Phase 20 Risk #10), decided 2026-09-14:

- A group is eligible only when its `sample_count` is at least N. The count is samples as defined in §2 (finished Runs attributable to the agent), not successes only.
- N is a governance value and is **unset** (`MIN_PERFORMANCE_SAMPLES = null` in `src/governance/performanceEligibility.ts`, the `dailyBudgetPolicy.ts` pattern). Unset means nothing is eligible. A zero, negative or fractional N fails closed.
- The one consumer is the Model Router's tier preference (§5). Policy's `CONDITIONAL` rule (spec §9.4) needs thresholds that are not decided, so Policy reads no performance (`ROADMAP_STATUS.md` §6).

It is not XP. `agent_xp_projection` (§16) is not built, and only this projection may ever feed Policy or the Router (§16.2).

## 2. Rules

| Measure | Rule | Test |
|---|---|---|
| **Sample** | A Run bound to an Agent Definition version whose terminal event is `run_completed` or `run_failed`, except outcomes that are not the agent's: any Run with a `run_halted` (operator stop), and a failed Run whose last `invocation_failed` reason is a governance, budget, quota, reauthorization, Approval-expiry, changed-binding or crash reason (`NOT_AGENT_OUTCOMES` in the projector). Every other failure counts, including `approval_rejected` (a human judged the work) and any unlisted reason: an unrecognized reason lowers the rate, which can never widen autonomy. Unfinished and unbound Runs are excluded. | `tests/projections/agentPerformance.test.ts`; mutation-checked |
| **Group** | (Agent Definition id, version, Task Definition id, model tier). | same |
| **Model tier** | `resultingTier` of the Run's last model `invocation_started` (the Router's own record, present even when the call then failed); `none` for a Run with no model call. | same; mutation-checked |
| **success_rate** | Completed samples / samples. | same |
| **avg_retries** | (samples − distinct Task Instances) / distinct Task Instances: the extra Runs per Task Instance. 0 until retries exist. | same; mutation-checked |
| **avg_cost** | Per resource unit: the samples' `budget_consumed` amounts / samples, as decimal strings (trailing zeros trimmed) in a jsonb object. Units are never combined (spec §12 note). Includes failed attempts, so a cheap tier's retries raise its cost (§10.5). Includes estimate-basis charges (a tool's are always estimates). A Run's whole cost goes to its last tier. | same; mutation-checked |

Not built: average duration and approval-rejection rate (§8.8 names them; Phase 12's table has no columns for them).

## 3. How it is maintained (`src/projections/agentPerformance.ts`)

- **Full rebuild, not a watermark.** Each refresh deletes and re-inserts every row from Events in one transaction, under a transaction-scoped advisory lock (`(20260914, hashtext('projection:agent_performance'))`). `events.global_seq` is a Postgres sequence, so a transaction can commit a lower value after a higher one is visible; an incremental watermark over it would skip that event forever. A rebuild is idempotent by construction and a failed refresh rolls back to the previous rows, which readers keep seeing meanwhile.
- **In-process loop** (`src/api/start.ts`): once at startup, then every 60 seconds, one refresh at a time, never on the execution path (§8.10: no new service). A failed refresh is logged and retried on the next tick.
- **Read APIs:** `GET /agents/:id` returns the version's rows as `performance` (previously `null`), and `GET /costs` returns every row with Agent and Task Definition names as `costVsSuccess` (spec screen 7). Both lag recent Runs by up to a refresh interval and show rows whatever the sample count, as measurement, never as a recommendation.

## 4. Firewall

`tests/execution/structuralInvariants.test.ts` fails if any source file other than the schema, the projector, the startup loop, the two read routes (`api/routes/agents.ts`, `api/routes/costs.ts`) and the eligibility gate references the table, its identifier or the projector, and if any file other than `router/modelRouter.ts` imports the gate. Letting Policy consume it is a deliberate edit to both, which should come with the `CONDITIONAL` decision.

## 5. Tier preference (spec §10.2, §10.5)

`authorizeRoute` computes the default tier (difficulty, risk floor), reads the Run's own group rows through the gate (`readTierPerformance`, one statement: a concurrent rebuild is seen whole or not at all), then `preferTier`:

| Rule | Why |
|---|---|
| Nothing moves unless N is set, the Run is bound to an Agent, and the default tier's own row is eligible | Below-N or missing data never influences routing, including as the baseline |
| Only a stronger tier with an eligible row may be chosen | The default carries the risk floor; §10.5's case is a cheaper tier costing more per success. Moving below the default is a decision (§6) |
| It must cost strictly less per successful outcome (`avg_cost / success_rate`) in some resource unit and no more in any; an absent unit is 0; a 0 success rate is infinitely expensive | Units are never summed or converted (§12 note); ties keep the default |
| The nearest such tier wins | Least change from the default |

The chosen tier is reserved and candidate-checked like the default. A refusal fails the Invocation; it never falls back to the default. `invocation_started` records `defaultTier` and `historicalPerformance` (the rows consulted, each with its eligibility, or why nothing was consulted), per §10.7. Stale rows are used as they are: the projection lags by up to a refresh interval, and the spec sets no freshness bound. Tests: `tests/router/tierPreference.test.ts`.

With static difficulty tags a group usually has data for one tier only, so preference rarely has anything to compare until something else (the risk floor, a definition change, §10.4 escalation) produces samples on a second tier.

## 5. Residuals

- **Rebuild cost grows with the event log.** The terminal-event scan has no `event_type` index. Fine at operator scale; add a partial index or a commit-ordered incremental cursor when it is not.
- **Not fully event-sourced.** The Agent binding is read from `runs` and the Task Definition from `task_instances` (written in the same transaction as the Run's events); no event records the binding.
- **Retries split across tiers.** Once retries exist, a retry on a different tier puts one Task Instance in two groups, each showing no retry.
- **One malformed event stops every refresh.** A non-numeric `budget_consumed.amount` fails the rebuild each minute; the previous rows stay and `updated_at` stops advancing, which is the only signal.
- **The firewall is a tripwire.** A table name assembled at run time, iterating the schema object, calling the read API over HTTP, a re-export or dynamic import of the gate, or reading the `historicalPerformance` snapshot off `invocation_started` events would pass it.
- **A Run-level measurement drives an Invocation-level choice.** A Run's samples and whole cost (tool estimates included) go to its last model tier, and tier preference applies that group to every LLM Invocation of the Task. The approved criterion is at that granularity; per-call cost per tier would need a projection change.
- **A malformed N fails every LLM route** rather than reading as ineligible. N is a code constant, so a bad value is a code change that the eligibility tests catch.
- **The UI types `performance` as `null`** (`web/lib/api.ts`) and shows "not available". Rendering the rows is the UI workstream's change; the API change is compatible with the current page.

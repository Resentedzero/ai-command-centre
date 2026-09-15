# Minimum Sample Criterion and Measured Tier Preference: Closure

**Started:** 2026-09-14, on the operator's decision of the minimum sample criterion's form.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** the V2 criterion (spec Phase 19 V2) and the part of V4 the spec determines (§10.2, §10.5). No migration, no new infrastructure, no live model calls; every provider adapter is mocked.

## The decision implemented

> An Agent Definition version's success rate is eligible for performance-based decisions only when it has at least N completed Runs for the same Task Definition and tier. N is a governance/configuration value. Until N is configured, performance remains ineligible.

- **"Completed Runs" is read as `sample_count`:** finished Runs attributable to the agent, as the projector already defines samples (successes and agent failures; operator stops and governance, budget, Approval-expiry and crash outcomes excluded). Counting successes only would make a poorly performing version look less measured, the wrong direction for governance.
- **N is `MIN_PERFORMANCE_SAMPLES` in `src/governance/performanceEligibility.ts`, shipped `null`**, the same inert-config pattern as `DAILY_BUDGET_CEILINGS`. Only tests pass a value, through an explicit option. A zero, negative, fractional or non-finite N throws.
- Display is unchanged: `GET /agents/:id` and `GET /costs` still show every row.
- **Update 2026-09-15:** the operator set N = 10 and confirmed the `sample_count` reading, so tier preference is now live (`MIN_PERFORMANCE_SAMPLES = 10`).

## Reconciling the brief with the spec

The brief asked for "the fully specified V4 conditional-autonomy mechanism". Reading §9.4, §10.2, §10.5, Phase 19 and Phase 20 against the code, the claim in the previous stop report that both consumers were fully specified was wrong for one of them:

| Consumer | Spec | Determined? | Outcome |
|---|---|---|---|
| Model Router tier preference | §10.2 "historical tier performance adapts tier preference automatically … among models the risk tier already permits"; §10.5 total cost per successful outcome; §10.7 record the snapshot consulted | The metric, its safety boundary and the audit record are. The comparison's edge cases are not, and are resolved in the most conservative way (below) | **Built** |
| Policy `CONDITIONAL` | §9.4 "lean toward auto-`ALLOW` for below-threshold instances" | No. No threshold, no performance bar, and no rule for which tier's row a tool action (which has no tier) consults | **Not built**; decision recorded (`ROADMAP_STATUS.md` §6) |
| Escalation loop | §10.4 "escalate one tier, bounded retry count" | Retry machinery; retry policy is an open decision | **Not built** |

## What changed

| # | Change | Where |
|---|---|---|
| 1 | The criterion: `performanceEligibility(sampleCount, N)` and `readTierPerformance(tx, runId, N)`, which reads the Run's own (Agent Definition id and version, Task Definition) rows in one statement, each with its eligibility | `governance/performanceEligibility.ts` |
| 2 | `preferTier`: after the difficulty/risk default, move to the nearest stronger tier whose eligible row costs strictly less per success than the default's eligible row | `router/modelRouter.ts` |
| 3 | `invocation_started` records `defaultTier` and `historicalPerformance` (rows consulted with eligibility, or `{consulted: false, reason}`) | same |
| 4 | Firewall: the gate joins the allowlist; only the Router may import it | `tests/execution/structuralInvariants.test.ts` |
| 5 | Header comments, `CLAUDE.md`, spec notes (§9.4, §10.5, Phase 12), `AGENT_PERFORMANCE.md` §1, §4, §5, roadmap | docs |

## Interpretations made (conservative readings, not new policy)

- **The default tier's own row must be eligible.** A comparison against below-N data would let that data influence the choice.
- **Upward only.** The default already carries the risk floor and `selectTier` promises "no path lowers a tier"; §10.5's example is a cheaper tier costing more per success. Moving below the difficulty default is recorded as a decision.
- **No unit trading.** `avg_cost` is per resource unit because units are never summed (§12 note). A tier is cheaper only if it costs less per success in some unit and no more in any; an absent unit is 0. A mixed trade (fewer tokens, more dollars) keeps the default.
- **Strictly cheaper; the nearest such tier wins.** Ties keep the default; the smallest change is preferred.
- **Stale and missing data.** Rows are used as they are (the projection lags by a refresh interval, and the spec sets no freshness bound); a missing row is ineligible.
- **No fallback.** The preferred tier is reserved and candidate-checked like the default. A refusal fails the Invocation; it is never retried at the default tier.

## What performance cannot do (tested)

- Change anything with N unset, below N, for an unbound Run, or when the default tier's row is ineligible.
- Mix groups: another Task Definition, another Agent Definition id, or the same id under another version.
- Lower a tier, override the risk floor, avoid a budget refusal, or reach a model with no candidate at the preferred tier.
- Reach Policy, Approvals or the Executor (structural test). `evaluatePolicy` is unchanged, so `CONDITIONAL` still requires approval.
- Excluded failures stay excluded: sample rules are the projector's and are unchanged (`tests/projections/agentPerformance.test.ts`). End to end (real Events, projector, route): 9 agent samples plus governance, budget, Approval-expiry, crash, stop and halted Runs leave the group below N = 10, so the tier does not move; with N = 9 the same data does move it.
- A concurrent, uncommitted rebuild neither blocks routing nor changes what it reads; once committed, the missing rows route to the default (real transactions).

## Mutation checks

Each mutant was applied, `tests/router/tierPreference.test.ts` run, and the file restored byte-for-byte.

| Mutant | Result |
|---|---|
| M1 exactly N is not enough (`>` for `>=`) | 8 fail |
| M2 the gate bypassed: every row compared | 3 fail |
| M3 a tie moves the tier (`<=` for `<`) | 1 fails |
| M4 an unset N counts as 1 | 1 fails |
| M5 preference may move below the default | 2 fail |
| M6 the Router ignores the preference | 5 fail |
| M7 the default tier's own row need not be eligible | 1 fails |
| M8 the read ignores the Task Definition | 1 fails |
| M9 the read ignores the Agent Definition version | 1 fails (after the isolation test gained a same-id, other-version row: the first version of the test used different ids and could not catch it) |
| M10 cross-unit costs may be traded | 1 fails |

## Independent review (Opus)

No Critical findings. Checked and fine: with N unset or below N nothing reaches the tier, the reservation or Policy; no path lowers a tier or falls back; NaN, zero rates, missing and mixed units; the conservative readings above; re-routing (a fresh Invocation row per proposal, so a changed snapshot cannot disagree with the recorded tier); lock interactions with the rebuild; payload size and consumers (the projector still reads `resultingTier`); docs.

| Finding | Disposition |
|---|---|
| Medium 1: once N is set, a preferred stronger tier refused by budget or candidates fails a Run the default would have run | **Recorded as a decision** (`ROADMAP_STATUS.md` §6): falling back or pre-filtering tiers is policy |
| Medium 2: the budget-refusal test could not distinguish "no fallback" (token tiers share one estimate); dispatch assertions in a route-only test proved nothing | **Fixed**: test renamed to what it proves, with a note that the no-candidate test proves no fallback; dead assertions removed |
| Medium 3: the recorded snapshot is a second read path the tripwire does not cover | **Documented** in the structural test and `AGENT_PERFORMANCE.md` §6; the snapshot is required by §10.7 |
| Medium 4: a Run-level measurement drives an Invocation-level choice | **Documented** as a residual; it is the approved criterion's granularity |
| Low 5: float rounding made exact ties look strictly cheaper (5/7 successes: 2999.9999999999995 < 3000) | **Fixed**: relative tolerance of 1e-9; test with projector-rounded values; mutant M11 |
| Low 6: comment claimed LLM routes are Policy-gated | **Fixed** |
| Low 7: a malformed N fails every route | **Kept** (N is a code constant; the tests catch a bad value); documented |
| Low 8: concurrency test's lock timeout was on the wrong connection | **Fixed**: set on the routing transaction |

| Post-review mutant | Result |
|---|---|
| M11 no rounding tolerance | passed at first (the rounded values sat on the default's row, which rounding made look cheaper, not the stronger one); test corrected; now 1 fails |
| F1 Policy imports the gate | 1 fails (structural test) |

## Verification

- Backend `tsc --noEmit`: exit 0. Backend suite: 63 files, 772 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: exit 0; the web app was not changed.
- No migration: the criterion is code configuration and the snapshot rides an existing event payload.
- `git diff --check`: clean.
- One existing test changed deliberately: the Router's exact `invocation_started` payload now includes `defaultTier` and `historicalPerformance`. No test was removed.

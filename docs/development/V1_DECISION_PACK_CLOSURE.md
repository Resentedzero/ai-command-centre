# V1 Decision Pack: Closure

**Started:** 2026-09-15, after `GOVERNANCE_RECORDS_CLOSURE.md`, on the operator's decision pack that supplied the values its §4 listed as open.
**Status:** in progress. Local commits on `main`, none pushed.
**Roadmap stage:** V4 Conditional Autonomy (spec §9.4); Budget Governor downgrade/degrade (Phase 4, §5.0); routing observability (§10.7). No migration.

> The frozen spec's §9.4 and §10.5 implementation notes still say `CONDITIONAL` requires approval. That file carries another workstream's uncommitted changes and is not edited here; this record supersedes those notes until the spec is amended.

## 1. Conditional Autonomy

**Decided values** (operator, 2026-09-15). N stays 10. For a CONDITIONAL Grant:

| Evidence | Decision |
|---|---|
| success rate ≥ 0.80 | `ALLOW` |
| 0.60 ≤ success rate < 0.80 | `REQUIRE_APPROVAL` |
| success rate < 0.60 | `DENY` |
| fewer than 10 samples, or not eligible | `REQUIRE_APPROVAL` |

Only low-risk, non-destructive capabilities may be allowed automatically. Spending, publishing, destructive mutations, external side effects, credential-sensitive actions and anything already requiring human approval stay human-gated regardless of performance. The row consulted is the Run's own Agent Definition version × Task Definition × the tier the Router selected; never another Agent, Task, tier or an aggregate.

**Built.**
- `governance/policy.ts`: `CONDITIONAL_AUTONOMY_RULE` (id `conditional_autonomy_v1`, thresholds, allowlists) and `conditionalDecision`, reached only for a CONDITIONAL Grant. New bases: `conditional_human_gated_action`, `conditional_insufficient_evidence`, `conditional_performance_meets_allow_threshold`, `conditional_performance_below_allow_threshold`, `conditional_performance_below_deny_threshold`. `autonomy_conditional_rule_undecided` is no longer returned but stays readable on older events.
- `governance/performanceEligibility.ts#readConditionalEvidence`: the evidence, through the sample criterion's gate.
- `execution/invocationLifecycle.ts#authorizeInvocation`: resolves the evidence for a CONDITIONAL Grant, hands it to Policy, and records `conditionalRule` and `performanceEvidence` on `policy_evaluated` at every checkpoint. The risk tier is now omitted only on a configuration DENY (a performance DENY computed one).
- `api/policyDecisionRecord.ts`: exposes both as named facts on the Workflow view, trace and Approvals context.
- UI (`web/lib/keep.ts`): `allowed · conditional` is neutral; the policy cell and the Approval's policy line are red for `DENY` and amber for `REQUIRE_APPROVAL` only while the Invocation or Approval waits on a human (`policyTone`); the recorded rule and evidence are the cell's tooltip (`policyEvidenceTitle`). No bars, controls, lighting or sprites.
- `tests/execution/structuralInvariants.test.ts`: the gate's importers are now the Router, the Invocation lifecycle and the display helper. Policy, Approvals and the Executor still do not import it.

**Interpretations made to implement the decision** (each fail-closed; each a one-constant or one-query change if the operator reads the decision differently):
1. **"Low-risk, non-destructive"** = permission `READ` and computed risk tier `low`. WRITE, CREATE, SEND and EXECUTE are treated as possible external side effects or mutations. An unverified binding raises risk above `low`, so it is always gated.
2. **"The tier the Router selected for that invocation."** A tool Invocation is not routed, so the tier is the `resultingTier` of the Router's latest route in the same Run. A Run that has routed no model call has no selected tier, so the rule has no applicable row and requires approval (`no_routed_tier`). **Consequence:** both current task plans run their tool before any LLM call (`research_report` retrieves first; `publish_report` has no LLM call), so a CONDITIONAL Grant on today's tools always requires approval. The seeded Grants are AUTONOMOUS (research) and ALWAYS_APPROVE (publish), so nothing seeded changes behaviour.
3. **A gated action is never denied by performance.** "Human-approval gated regardless of performance" is read literally: poor evidence does not turn a gated action's approval requirement into a denial.
4. **Every checkpoint re-evaluates.** `resume` and `pre_dispatch` re-read the evidence. A projection refresh that drops the rate below 0.60 after a human approved blocks the action (only a DENY blocks at resume, as before), and a propose-time `ALLOW` whose rate falls below 0.80 before dispatch is refused as `approval_required_before_dispatch`. Both fail closed.
5. **Residuals of reading "low-risk" as the computed risk tier** (adversarial review). The tier is `computeRiskTier(staticRiskTag, amountOrScope, isNovelAction, trust)`; the amount and novelty come from `proposedActionSnapshot`, the one model-reachable input, and absent they read as "no amount" and "not novel". So a low-tagged READ is allowed on its evidence unless the snapshot marks it novel or large. And "credential or security-sensitive" is expressed only through the Capability's `staticRiskTag`, which the Registry sets: a secrets-reading Capability must be registered above `low` to stay gated. Both are the same exposure AUTONOMOUS already had; a per-Capability sensitivity flag would need a schema decision.
6. **An autonomy state outside the three** (the column is text) still requires approval, now recorded as `autonomy_state_unrecognized` rather than `autonomy_always_approve` (independent review finding).

**Tests.** `tests/governance/policy.test.ts` (every threshold edge, insufficient evidence including unreadable rates, every gated permission with perfect and zero evidence, medium risk, novelty, unverified binding, other autonomy states unaffected, unrecognized state); `tests/governance/conditionalAutonomy.test.ts` (through the real Executor: allowed with no Approval and the recorded rule and evidence; approval between thresholds; denial below; another tier's, Task's or Agent version's row ignored; below N; no routed tier; gated WRITE; latest route wins and only the Router's route counts; unbound Run and no criterion; a propose-time ALLOW refused at `pre_dispatch` after the rate falls, and an approved action denied at `resume`, each with its hold released); `web/tests/keep.test.ts`, `web/tests/workflows.test.tsx`, `web/tests/approvals.test.tsx`.

## Independent review of c747fa2 (Stage 1)

No confirmed defects in fb00b76, 6e64cd5, 3bc6889 or c747fa2. Plausible findings acted on:
- A tool whose own error message reads `insufficient_budget` was reported as a budget denial although its reservation was settled. The Executor now records `budgetAuthorization: {authorized: false, outcome: "denied"}` on both tool denial paths, and `budgetOutcomeOf` reads that fact first; an older failure counts as denied only when it settled no reservation (`tests/api/budgetOutcome.test.ts`).
- An unrecognized autonomy state recorded as `autonomy_always_approve` (§1 item 5).
- A vacuous "never names a downgrade" test: replaced when downgrade and degrade are built (§2).

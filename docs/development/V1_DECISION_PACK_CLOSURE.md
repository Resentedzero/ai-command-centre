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

## 2. Budget Governor downgrade and degrade

**Decided values** (operator, 2026-09-15). Attempt the routed tier. Denied: attempt exactly one next-lower tier with the Invocation's Context Budget tightened to 75% (`max_input_tokens`, `max_artifact_tokens`, `max_retrieved_items`, `max_tool_schema_tokens`, `max_memory_items`, `expected_output_tokens`); authorized there is `downgraded`, denied again is `denied`; context degraded without a tier downgrade is `degraded`. No cascade, no ceiling override, no borrowing or combining resource units, reservations atomic and fail-closed, the configured budget never changed, no zero or negative budget. Not a retry (D1 unchanged). Performance may not pick a tier below the default.

**Built** (`router/modelRouter.ts#authorizeRoute`, no migration).
- After the routed tier's reservation is denied, one fallback: the tier one below it when that is not below the request's minimum tier (the risk floor — `high`/`highest` risk forces STRONG, §10.2 "independent of budget" — and a retry's escalation floor), else the same tier. Either way under `degradedContextBudget` (`BUDGET_FALLBACK_CONTEXT_FACTOR = 0.75`): each named quantity rounded down, a positive value never below 1, zero kept; `compressionThreshold` and `freshnessRequirementSeconds` unchanged. `max_memory_items` has no field (memory is V3, not built).
- The fallback considers only candidates in the denied candidate's resource unit, so a `subscription_tokens` denial can never become a billed `usd` call.
- Authorized: `invocation_started` records `resultingTier`, `tierSource: budget_downgrade` (downgraded only; a degrade keeps its source), `budgetAuthorization.outcome` (`authorized` / `downgraded` / `degraded`), the reserved estimate, and `budgetFallback` (the denied authorization, the tier tried, factor, degraded budget). `RouteResult.contextBudget` carries the degraded budget; the Executor compiles to it and `context_compiled` records `maxInputTokens` with `taskMaxInputTokens`.
- Refused again: the refusal's `routingDecision` records the denied authorization (`outcome: denied`) and `budgetFallback` with why the attempt failed (a second `insufficient_budget`, or no candidate in that unit). Each refused reservation emits its own `budget_denied`.
- Read models: `budgetOutcome` is the Router's recorded `outcome` for LLM Invocations (older routes read `authorized`), and stays `downgraded`/`degraded` whatever the call did next. `route.budgetFallback` summarises the fallback. Tools remain `authorized`/`denied`: they have no tier or Context Budget.
- UI: the budget cell shows the word; `denied` is red, the rest neutral; the fallback is its tooltip (`budgetFallbackTitle`); the kind cell reads `llm · CHEAP · budget downgrade`.

**Interpretations made to implement the decision.**
1. **`degraded` needs a trigger the rule does not name.** It is produced when the one fallback cannot go lower (already CHEAP, or held by the risk or escalation floor): the attempt is then made at the same tier with the 75% budget. Reading it otherwise (deny without an attempt) is a one-line change.
2. **The tier ladder** ("preferred → default → next lower → minimum → deny") is realised through the one-step rule, not a cascade: a performance-preferred tier steps to the default (the escalation-floored base), never to a tier between them; a default tier steps one lower; neither goes below the minimum tier. Performance preference still only moves up.
3. **Only a budget denial falls back.** A quota refusal or no eligible candidate at the routed tier fails as before (Phase 7G, §10.6.7): switching tier there is not a budget decision.
4. **A lower tier allowed by the floors but with no candidate in the unit** is `denied`, not a second same-tier attempt.
5. **Residuals from the adversarial review.** (a) A quota refusal at the fallback tier is recorded as `insufficient_budget` (budget caused the fallback); the quota cause is in `budgetFallback.refusal`. (b) A downgraded or degraded call's Run is attributed to its resulting tier, so `agent_performance`, Conditional Autonomy evidence and retry escalation count a 75%-context call as that tier's sample. Separating them would need a projection change. (c) A refused fallback records `outcome: denied` with `attemptedOutcome`.
6. **Known interaction:** a 75% `expectedOutputTokens` prices less output but caps nothing (no adapter caps output, ROADMAP §6); a downgraded call whose output then fails validation is retried one tier up by the retry policy, which may be budget-denied in turn.

**Tests.** `tests/router/budgetFallback.test.ts` (budget arithmetic; downgraded with its full record and one `budget_denied`; degraded at CHEAP; the risk floor and the escalation floor hold; denied after exactly two attempts with nothing reserved and no provider call; never a usd fallback from a subscription denial; the Executor compiles to the degraded budget and records it); `tests/router/tierPreference.test.ts` (a preferred tier's denial falls back once, never twice); `tests/router/modelRouter.test.ts`; `tests/api/budgetOutcome.test.ts` (each recorded outcome, kept after the call fails; unknown values read as authorized); `tests/api/routeRecord.test.ts`; `web/tests/keep.test.ts`, `web/tests/workflows.test.tsx`.

## 3. Routing observability reconciled and V1 readiness fixes

Three independent read-only reviews ran against `daa8d6e`: end-to-end V1 readiness, observability reconciliation (runtime record → read API → web type → UI), and cross-feature governance safety. No contradiction between records and UI was found, and no guarantee was broken (no silent provider switch, no retry route to a `usd` model, no unsettled reservation after a fallback). Acted on:

**Performance projection pollution (confirmed).** The projector excluded non-agent failures only by exact `invocation_failed.reason`, but several are free text. Pre-dispatch tool refusals, provider refusals that consumed nothing (`quota_exhausted`, `auth_expired`, `cli_unavailable`, `misconfigured`, `input_too_large`), a context that did not fit its budget (including the Governor's 75% degrade), database errors and step build failures (`execution_error: …`) all counted against the agent, lowering the rate Conditional Autonomy and tier preference decide on. Now:
- `toolDispatchRefusal` gives its three refusals a stable `code` (`policy_denied_before_dispatch`, `reauthorization_failed_before_dispatch`, `approval_required_before_dispatch`), recorded as `errorCode`; a pre-dispatch check that itself throws is `pre_dispatch_check_failed`.
- The projector also excludes by `errorCode` (`NOT_AGENT_ERROR_CODES`), by the `execution_error:` prefix, and a Run failed with reason `execution_error`. A validation failure still counts; a timeout counted too until the final V1 decisions (§4) classed it as infrastructure.
- Residuals (review of this change): codes are matched as strings, so a future adapter that passes a remote service's snake_case code through (`misconfigured`, `input_too_large`) could exclude a failure that was the agent's; today's sources are the Claude adapter's fixed enum, Node's uppercase errno codes (rejected by `failureCode`) and OpenAI codes not in the list. And every step build or execution throw is excluded; a future deferred builder that parses a model's output would have that agent failure excluded too. A pre-dispatch check that throws a database error is recorded as `pre_dispatch_check_failed`, not `database_error` (both excluded).
- Residual: events recorded before this change are classified by the same rules, so an old pre-dispatch refusal without `errorCode` still counts. A pre-dispatch check that fails on a transient database error still fails its Run permanently (fail closed, nothing spent), now excluded from samples.

**Research output shape (plausible live blocker).** The research plan sent `{ report: "string" }` to the Claude CLI's `--json-schema`, which is not a JSON Schema (it names no type, so it constrains nothing, or the CLI rejects it). It now sends `REPORT_OUTPUT_SCHEMA` (`type: object`, `report: string`, required, no other properties). Every recorded live run used a real schema, but none used this one: **a live `claude -p` check of the seeded research step is still needed before dogfooding**, and was not run (no live calls in this work). The dev database's one failed Workflow Run failed on 2026-09-12 for a missing Anthropic API key, before subscription routing was the default; it is unrelated.

**Observability gaps (confirmed).**
- A budget downgrade overwrote why the denied tier was chosen: `budgetFallback.fromTierSource` now records it.
- The performance snapshot behind a tier choice (`historicalPerformance`, recorded on the route) was never exposed: `route.performance` (consulted, reason, each row's tier, sample count, success rate, eligibility as recorded then) on the Workflow Run detail and trace, in the kind cell's tooltip (`routeTitle`).
- A refused fallback that was never priced (no candidate in the unit) read as "denied": `route.budgetFallback` exposes `refusal` and `attemptedOutcome`, and the tooltip says "not tried at CHEAP: resource mismatch".
- A refused route's tooltip showed a model that was never called: now "(priced, not called)".
- Agent Detail showed a Governor-tightened ceiling as the Task's: `contextLineage` exposes `effectiveMaxInputTokens`, `budgetOutcome` and `taskMaxInputTokens`; the screen names the tightening and the Task ceiling.
- The web `RunTrace` type lagged the API (`route`, `budgetOutcome`, binding and timestamps): synced. The trace screen still renders events only.

**Recorded, not changed.**
- **A retry re-incurs tool `usd` spend** (confirmed). "An automatic retry never spends money" is enforced for model routing only; a retry Run re-runs its tool step and reserves its `usd` estimate again (seeded: the synthetic `research.retrieve` at $0.01, three attempts at most, inside the $1.00 Task Instance ceiling). Blocking it would make retries of the seeded workflow fail at the tool step. An operator decision (ROADMAP §6).
- **Conditional Autonomy is inert for the shipped plans** (§1 item 2): no real flow reaches its ALLOW or DENY branches until a plan runs a READ tool after a model call.
- **A performance DENY does not recover by itself**: denied Runs are not samples, so the rate changes only with new samples or a new Agent Definition version. Fail closed.
- **Downgraded and degraded calls share their resulting tier's row** (§2 interpretation 5b).
- **V1 readiness gaps outside this work's scope**: Workflow 1 alone (Research → Report without publish) has no seeded Workflow Definition, so it runs only after creating one through the Registry API; the UI has no advance, pause, resume or non-agent stop controls (curl works; UI proposals are not authorized); no API-level test drives a budget denial, a downgrade, a stop, TTL expiry or Conditional Autonomy through the seeded workflow (each is proven at the Executor or Router level); an earlier attempt's route is not reachable from the UI.

**Tests.** `tests/projections/agentPerformance.test.ts` (each excluded code, the prefix, a run-level `execution_error`, and a validation failure still counted); `tests/execution/toolDispatch.test.ts` (`errorCode` on a pre-dispatch refusal); `tests/api/routeRecord.test.ts` (performance snapshot, refused fallback); `tests/router/budgetFallback.test.ts` (`fromTierSource`); `web/tests/keep.test.ts` (`routeTitle`, unpriced fallback), `web/tests/agentDetail.test.tsx` (tightened budget).

## Independent review of c747fa2 (Stage 1)

No confirmed defects in fb00b76, 6e64cd5, 3bc6889 or c747fa2. Plausible findings acted on:
- A tool whose own error message reads `insufficient_budget` was reported as a budget denial although its reservation was settled. The Executor now records `budgetAuthorization: {authorized: false, outcome: "denied"}` on both tool denial paths, and `budgetOutcomeOf` reads that fact first; an older failure counts as denied only when it settled no reservation (`tests/api/budgetOutcome.test.ts`).
- An unrecognized autonomy state recorded as `autonomy_always_approve` (§1 item 5).
- A vacuous "never names a downgrade" test: replaced when downgrade and degrade are built (§2).

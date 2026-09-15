# Governance Decision Records: Closure

**Started:** 2026-09-15, after the budget-containment closure (`BUDGET_CONTAINMENT_CLOSURE.md`).
**Status:** closed 2026-09-15. Local commits on `main`, none pushed. The operator's decision pack later decided §4's open values; `V1_DECISION_PACK_CLOSURE.md` supersedes the `CONDITIONAL` rows of §1 (a CONDITIONAL Grant is no longer always approval-gated, and `performanceEvidence` is no longer always null).
**Roadmap stage:** V1 conformance (spec §8.2, §9.3) and V2/V4 observability. No migration, no new infrastructure, no live model calls.

## Stage assessment

The runtime milestones named next were checked against the frozen spec and `ROADMAP_STATUS.md` §6 before any change.

| Stage | Settled by the spec? | Built here |
|---|---|---|
| Conditional Autonomy (§9.4) | **No.** The rule needs values the spec does not give: (a) which instances are "below threshold", (b) what performance leans toward `ALLOW` and its value, (c) which `agent_performance` row a tool action consults (spec §9.4 note; ROADMAP §6 "`CONDITIONAL` autonomy rule"). | Not the rule. The settled half: an authoritative Policy decision record (§1 below). `CONDITIONAL` still requires approval. |
| Budget Governor downgrade / degrade (Phase 4) | **No.** When to downgrade, to which tier, and how far to tighten a Context Budget have no values and meet the no-fallback rule (ROADMAP §6). | Not the outcomes. The settled half: a per-Invocation budget outcome for the two the Governor produces (§2 below). |
| Routing / tier observability | Yes: additive exposure of facts already recorded, plus the Router recording which rule set the tier. | §3 below. |

## 1. Policy decision record

**What Policy records.** `evaluatePolicy` now also returns `basis`, exactly one value per return path (`PolicyBasis`, `governance/policy.ts`):

| basis | decision | when |
|---|---|---|
| `no_grant` | DENY | no Grant for the Agent version and Capability |
| `permission_not_granted` | DENY | the Grant does not list the permission |
| `binding_below_grant_trust_bar` | DENY | the binding's trust level is below the Grant's `maxTrustLevelRequired` |
| `autonomy_autonomous` | ALLOW | an `AUTONOMOUS` Grant |
| `autonomy_always_approve` | REQUIRE_APPROVAL | an `ALWAYS_APPROVE` Grant |
| `autonomy_conditional_rule_undecided` | REQUIRE_APPROVAL | a `CONDITIONAL` Grant: the §9.4 rule is undecided |
| `unverified_binding_requires_approval` | REQUIRE_APPROVAL | an `AUTONOMOUS` Grant on an `unverified_third_party` binding |

No decision changed; only the reason is now recorded. `policy_evaluated` carries `basis` and `performanceEvidence: null` (Policy consults no performance; the structural test keeping Policy off the eligibility gate is unchanged).

**What the API exposes** (`api/policyDecisionRecord.ts`). A `PolicyDecisionRecord` is the named facts of one `policy_evaluated` event, never re-derived: `checkpoint`, `decision`, `basis` (null on evaluations recorded before 2026-09-15), `autonomyState`, `riskTier` (null on a DENY), `grantId`, `capabilityId`, `permission`, `toolBindingId`, `trustLevel`, `maxTrustLevelRequired`, `bindingTrustLevel`, `performanceEvidence` (null).

- `GET /workflow-runs/:id`: `steps[].run.invocations[].policyDecision`, the latest evaluation, or null for Invocations Policy does not govern (LLM, deterministic, retrieval never go through Policy). "Latest" is the most recent check, not an outstanding requirement: an approved `ALWAYS_APPROVE` action is re-evaluated at `resume` and `pre_dispatch` and records `REQUIRE_APPROVAL` again (only a DENY blocks there), so the Workflow view names the checkpoint.
- `GET /runs/:id/trace`: `invocations[].policyEvaluations`, every evaluation (`propose`, `resume`, `pre_dispatch`) in sequence order.
- `GET /approvals`: `context.policyDecision`, the `propose` evaluation that created the Approval.

**Against the decision-record contract.**
- Decision, autonomy state, basis: recorded and exposed.
- Rule identity: the Grant, Capability, permission and binding ids plus `basis`. Policy is code, not rows (no `policies` table, ROADMAP §6), so there is no rule id or policy version to cite.
- Threshold basis: the trust bar and the binding level Policy compared. No performance threshold exists to record.
- Performance or sample evidence: `null`, truthfully. It becomes a real field only when the `CONDITIONAL` rule is decided and Policy is allowed to consult performance.

**UI.** Words only, no new colour: a `policy` column on the Workflow view's Invocations table (`allowed · autonomous · at pre dispatch`) and a `policy` line on the Approval request (`approval required · always approve`), formatted by `policyToken` in `web/lib/keep.ts` from the API's fields. Colour stays where it was: amber on the awaiting-approval status and the Approvals queue, red on a denial's failure line. "allowed · conditional" cannot occur today, because `CONDITIONAL` never allows.

**Tests.** `tests/governance/policy.test.ts` (each basis on its path, including `CONDITIONAL`); `tests/execution/executor.test.ts` (`basis` and `performanceEvidence` on the event); `tests/api/routes.integration.test.ts` (the Workflow detail and Approvals context through a real seeded run); `tests/api/traceRoute.test.ts` (every checkpoint, none for LLM or deterministic); `web/tests/workflows.test.tsx`, `web/tests/approvals.test.tsx` (the rendered token).

**Not built, by decision boundary.** The `CONDITIONAL` rule and anything that lets performance reach Policy; a `policies` table or rule versions.

## 2. Budget outcome per Invocation

The Governor authorizes or denies; it never downgrades or degrades (undecided). `budgetOutcome` (`api/budgetOutcome.ts`) is `authorized`, `denied` or null, assembled only from what the runtime recorded when it reserved:

| Kind | authorized | denied | null |
|---|---|---|---|
| `llm` | the Router's `budgetAuthorization.authorized: true` on `invocation_started` | its refused route's `budgetAuthorization.authorized: false` on `invocation_failed.routingDecision` | the route was refused before the Governor was asked (no eligible candidate, quota) |
| `tool` | any recorded fact of a successful reservation: the Invocation reached `awaiting_approval`, `executing` or `completed` (written only after one); an `approval_required` event (emitted only after one); a pre-dispatch check (a pending dispatch exists only with one); or a failure recording its settlement (`reservationSettlement` reconciled, released or charged at estimate) | the Executor failed it with `insufficient_budget` (proposal) or `insufficient_budget_on_resume`, checked first | refused before reserving (a stop, a Policy DENY), or no reservation recorded (`none_recorded`) |
| deterministic cost class, `deterministic`, `retrieval` | — | — | never reserved |

The outcome is the Governor's, not the action's: an authorized reservation stays `authorized` after an LLM call fails at its provider, an approval is rejected or expires, a dispatch is refused, or an interrupted tool is charged at its estimate. A pending approval shows `authorized`, because its reservation is held (`BUDGET_CONTAINMENT_CLOSURE.md`). Exposed on `GET /workflow-runs/:id` (`invocations[].budgetOutcome`) and `GET /runs/:id/trace`.

**UI.** A `budget` column on the Workflow view's Invocations table, the API's word as given. A denial's red stays on the failure line; `authorized` is neutral.

**Tests.** `tests/api/budgetOutcome.test.ts` (every row of the table from recorded payload shapes, including a rejected approval and an interrupted, charged tool staying authorized, and that only the two outcomes are produced); `tests/api/routes.integration.test.ts` and `tests/api/traceRoute.test.ts` (a real seeded run: tool and LLM authorized, deterministic null, a publish awaiting approval authorized); `web/tests/workflows.test.tsx`. A denial is covered by the unit test only; no route test drives one end to end.

**Not built, by decision boundary.** `authorized-at-downgraded-tier` and `degrade`: when to downgrade, to which tier, and how far to tighten a budget. Linking `budget_denied` to its Invocation would need `reserveBudget` to take the Invocation id, which its fixed six-argument production signature does not; the outcome above does not need it.

## 3. Routing, retry and performance eligibility

**What the Router records.** `authorizeRoute` adds `tierSource` to its recorded inputs (on `invocation_started` and on a refused route): `performance_preference` when measured performance moved the tier, `escalation_floor` when a retry's floor raised it above the default, `default` otherwise. Preference wins: a floor that raised the tier and a preference that then moved it higher records `performance_preference`, with `escalationFloor` still recorded. It is computed from the same values the Router routed on, at the moment it routed; no routing behaviour changed.

**What the API exposes.**
- `GET /workflow-runs/:id` and `GET /runs/:id/trace`: `invocations[].route` (`api/routeRecord.ts`) for LLM Invocations: `defaultTier`, `escalationFloor`, `resultingTier` (null when refused), `attemptedTier` (refused only), `tierSource` (null on routes recorded before 2026-09-15; the UI says "source not recorded"), `attempt`, `modelId` (on a budget refusal, the candidate that was priced, never called). Null for other kinds.
- `GET /workflow-runs/:id`: `steps[].attempts[]` gains `retryOfRunId` and `retryCause` from the Run's `run_started` (the Interpreter's record; null on a first attempt) and `minimumModelTier` (the Run's column).
- `GET /agents/:id` `performance[]` and `GET /costs` `costVsSuccess[]`: `eligible`, `eligibilityReason`, `minSamples` from the runtime's gate (`performanceEligibility`, N = 10), through one display helper (`api/performanceEligibilityFields.ts`). The structural test now allows exactly two importers of the gate, the Router and that helper, and only the two read routes may import the helper; Policy, Approvals and the Executor still may not.

**UI.** Words only, no colour, no controls: the Invocation kind cell reads `llm · MID · floor` or `llm · STRONG · preference` (model id as its title); an attempt reads `attempt 2 · retry · output validation failed · floor MID`; the performance tables gain a `routing` column (`eligible · meets sample criterion`, `not enough samples · 3 of 10`). Meeting the criterion is not use: the Router reads only the Run's own Agent version and Task Definition, and only tiers above the default. The copy "It ranks and recommends nothing" was false once N was set and is replaced by "An eligible row can steer the Model Router's tier choice; it never approves or runs anything."

**Tests.** `tests/router/modelRouter.test.ts` and `tests/router/tierPreference.test.ts` (`tierSource` for default, floor and preference); `tests/api/routeRecord.test.ts` (routed, refused for no candidate, refused by budget, other kinds, retry lineage); `tests/api/routes.integration.test.ts` (the LLM route through a real run; three attempts with their causes and lineage); `tests/api/traceRoute.test.ts`; `tests/api/costsRoutes.test.ts` (a row below N and one at exactly N); `tests/projections/agentPerformance.test.ts`; `tests/execution/structuralInvariants.test.ts`; `web/tests/workflows.test.tsx`, `web/tests/agentDetail.test.tsx`, `web/tests/costs.test.tsx` (the UI shows the API's eligibility even where a client-side count would disagree).

**Not built.** Tier or model controls, a model-management view, and tier preference below the default (a decision, ROADMAP §6).

## 4. Where this leaves the roadmap

Re-read after §3 (ROADMAP_STATUS §6, NEXT_PHASE_PLAN, the design proposals in `.claude/skills/designing-command-centre-ui/design-decisions.md`). No architecture-settled runtime work remains; each next step needs an operator decision:

- **`CONDITIONAL` autonomy rule** (§9.4): which instances are below threshold, the performance value that leans toward `ALLOW`, and which tier's row a tool action consults. The decision record (§1) is ready to carry the evidence.
- **Budget Governor downgrade / degrade** (Phase 4): when to downgrade, to which tier, how far to tighten a Context Budget. The outcome field (§2) is ready to carry the new values.
- **A preferred tier that cannot be authorized** and **tier preference below the default** (§10.2): the Router's `tierSource` (§3) records whichever is chosen.
- The rest of §6 as listed there (D4 recording retry, `expected_output_tokens` capping, artifact storage threshold, approved-to-execution deadline, agent pause, grant scope, CI, and others).
- **UI API proposals P1–P9** are recorded as not authorized. P2's model id is now covered by `route.modelId`; P5's pause and resume routes already exist in the API.

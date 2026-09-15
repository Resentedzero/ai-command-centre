# Governance Decision Records: Closure

**Started:** 2026-09-15, after the budget-containment closure (`BUDGET_CONTAINMENT_CLOSURE.md`).
**Status:** in progress. Local commits on `main`, none pushed.
**Roadmap stage:** V1 conformance (spec §8.2, §9.3) and V2/V4 observability. No migration, no new infrastructure, no live model calls.

## Stage assessment

The runtime milestones named next were checked against the frozen spec and `ROADMAP_STATUS.md` §6 before any change.

| Stage | Settled by the spec? | Built here |
|---|---|---|
| Conditional Autonomy (§9.4) | **No.** The rule needs values the spec does not give: (a) which instances are "below threshold", (b) what performance leans toward `ALLOW` and its value, (c) which `agent_performance` row a tool action consults (spec §9.4 note; ROADMAP §6 "`CONDITIONAL` autonomy rule"). | Not the rule. The settled half: an authoritative Policy decision record (§1 below). `CONDITIONAL` still requires approval. |
| Budget Governor downgrade / degrade (Phase 4) | **No.** When to downgrade, to which tier, and how far to tighten a Context Budget have no values and meet the no-fallback rule (ROADMAP §6). | See the budget outcome section when built. |
| Routing / tier observability | Yes: additive exposure of facts already recorded. | See its section when built. |

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

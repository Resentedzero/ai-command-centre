# Observability Conformance and Runtime Fixes: Closure

**Started:** 2026-09-14, after migrations 0014/0015 were applied locally and three spec-to-code audits (events and lineage; artifacts and provenance; orchestration, approvals and recovery).
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V1 conformance: items the frozen spec already determines but the code had not built, plus two bugs. No new capability, stage or infrastructure.

No live model invocations, no paid services, no migrations. Every dispatch-capable test mocks all three provider adapters.

## Why this was the next work

The roadmap's remaining stage work is gated on evidence (V3) or decisions (§6). The audits separated what the spec already fixes from what it leaves open. Everything below is in the first group; the second group is recorded in `ROADMAP_STATUS.md` §6.

## What changed

| # | Change | Spec | Where |
|---|---|---|---|
| 1 | `publish_report` source lookup fails closed on two source steps or two Runs (reachable since Registry writes) | fail-closed convention | `capabilities/publishReport/buildInvocationSpecs.ts` (`42d9091`) |
| 2 | `policy_evaluated` at every tool Policy evaluation (propose, resume, pre-dispatch): decision, Grant, binding trust, and risk tier with its inputs only when computed; never snapshot content | §8.2, §9.3 | `execution/invocationLifecycle.ts#authorizeInvocation` |
| 3 | `budget_denied` at every reservation refusal, naming the refusing counter and its exact amounts | §8.2 | `governance/budget.ts#deny` |
| 4 | `GET /runs/:id/trace`: a Run's events in `sequence_no` order with each Invocation's context lineage | §8.4 | `api/routes/trace.ts` |
| 5 | `GET /artifacts/:id`: bounded preview, content-hash check, provenance chain, compiled contexts that included it | §15.1 screens 2 and 8, §5.13 | `api/routes/artifacts.ts` |
| 6 | **Bug:** an approved Approval failed re-authorization once its TTL passed (a paused Workflow Run resumed later failed) | §9.5 "Unresolved Approvals past a TTL" | `governance/approvals.ts#reauthorize` |
| 7 | **Bug:** a Grant revocation's `approval_expired` events never reached the live feed, and a reconnect could skip them | §15.3 | `api/routes/registry.ts` |
| 8 | Emergency stops re-checked immediately before a model dispatch; a refusal releases the hold and halts the Run | §9.7, DURABLE_EXECUTION §7 #11 | `execution/executor.ts#modelDispatchRefusal`, driver |
| 9 | Workflow Run detail returns each Invocation's produced `artifactIds`, so screen 3 can link outputs to item 5 | §15.1 screen 3 | `api/routes/workflowRuns.ts` |
| 10 | The failed-stop-lookup test runs on real transactions (see O13) | test fidelity | `tests/execution/durableExecution.test.ts` |

## Decisions made

- **`policy_evaluated` is emitted by the lifecycle wrapper, not Policy.** `policy.ts` stays free of events and budget.
- **No risk tier on DENY.** Policy returns a placeholder there; the log must not record it as a fact.
- **A pre-dispatch refusal is logged.** The check returns its refusal instead of throwing, so its `policy_evaluated` commits; the Invocation's failure (`policy_denied_before_dispatch` and siblings) follows (review M1).
- **`budget_denied` has no derived key.** Each refusal is its own fact.
- **The Artifact API is a single-Artifact read, no listing.** The audit found the spec's own unmet requirement (screen 2's outputs are "linked Artifacts"); a browse/listing surface still waits for a need.
- **An existing test that engaged a stop between the executing commit and the dispatch was moved inside the provider call.** That window is exactly what item 8 closes; the test still proves a stop during the call records the real outcome and blocks the next Invocation.
- **Not built** (decisions, §6): recording-transaction retry, pause/resume and agent-pause events, Goal status lifecycle, `POST /goals` idempotency, artifact versioning, step output binding, the §5.16 citation convention, `artifact_referenced` semantics. SSE commit-ordered cursor: engineering-open, low value for one operator, recorded as a residual.

## Adversarial review (independent, Opus)

Targets: lock order of the new event emissions, rolled-back or suppressed events, payload leakage, the TTL change's governance meaning, the stop re-check's failure modes, the changed test, the new read APIs, existing contracts. No Critical findings. Checked and fine: lock order (counter rows then the Run's own event lock, as `budget_consumed` already does; the pre-dispatch transaction holds no row locks), idempotency keys (no legitimate event suppressed), refusals always followed by committed failures, the stop re-check (fails closed, single dispatch call site outside any transaction, slot released, error identity preserved), the changed mid-dispatch test (not weakened), relay order, trace and artifact route correctness, no broken contracts.

| Finding | Disposition |
|---|---|
| H1: `tsc` error on `error.stop` in the model halt branch | **Not reproduced**: `tsc --noEmit` exits 0 on the committed tree; the reported run overlapped a mutation run |
| M1: every pre-dispatch refusal (not only DENY) rolled back its `policy_evaluated` | **Fixed**: the pre-dispatch checks return their refusal instead of throwing (`toolDispatchRefusal`, `modelDispatchRefusal`), so the check transaction commits the evaluation; a failed lookup still throws; test; mutation-checked |
| M2: approved actions now have no age limit | **Recorded as a decision** (ROADMAP_STATUS §6: a deadline for executing an approved action). §9.5's TTL expires unresolved Approvals only; the fix follows it and every other re-check still applies |
| M3: a failed stop lookup or a vanished Run counts as an agent failure in `agent_performance` | **Documented**: display-only, and an unlisted reason lowers the rate (the conservative direction the projection already chose) |
| M4: `referencedBy` scans context events without an index | **Documented** (`ponytail:` comment naming the partial or GIN index) |
| L1: orphaned doc comment | **Fixed** |
| L2: DURABLE_EXECUTION #16 not updated for LLM dispatch | **Fixed** |
| L3: no model-path test for a failed stop lookup | **Added** (the first disposition wrongly assumed the tool path covered it; mutant O13 showed nothing did): a failed lookup reaches no provider, releases the hold and fails the Run without `run_halted` |
| L4: a non-run-scope denial would take the shared no-run event lock while holding counter rows | **Documented** in `deny` (unreachable: every caller reserves at run scope) |
| L5: `budget_denied` has no `invocationId`; copies the shared day counter's totals | **Documented**: the Invocation's failure follows in the same Run sequence |
| L6: snapshot readers re-run in `authorizeInvocation` | **Kept**: they cannot throw after Policy parsed the snapshot; a smaller diff than changing Policy's return |
| L7: "never the proposed action's content" overstated | **Fixed**: docs name the two risk inputs recorded |
| L8: agent id dropped when its row is missing | **Fixed** |
| L9: trace issued a third query | **Fixed** (lineage filtered from the Run's events) |
| L10: spec diff reorders more than stated | Those moves are the UI workstream's uncommitted edits; this milestone stages only its own hunks |

## Mutation checks

Each mutant was applied, the named tests run, and the file restored byte-for-byte.

| Mutant | Result |
|---|---|
| M1 publish source lookup accepts several rows (`42d9091`) | 2 fail |
| O1 `policy_evaluated` never emitted | 2 fail |
| O2 a DENY records a risk tier | passed at first; a DENY-payload test was added; now 1 fails |
| O3 `budget_denied` never emitted | 3 fail |
| O4 approved Approvals expire at TTL again | 1 fails |
| O5 `approval_expired` not relayed on revocation | 1 fails |
| O6 no stop re-check before a model dispatch | 1 fails |
| O7 a pre-dispatch stop recorded as a plain failure (no `run_halted`) | 1 fails |
| O8 trace in descending sequence order | 1 fails |
| O9 artifact hash check always true | 1 fails |
| O10 `referencedBy` ignores the artifact id | 1 fails |
| O6 (re-run after the review fix) no stop re-check before a model dispatch | 1 fails |
| O11 a pre-dispatch DENY thrown again, so its evaluation rolls back (review M1) | 1 fails |
| O12 a stop ignored on the model path | 1 fails |
| O13 `stopRefusal` treats a failed lookup as "proceed" | passed at first, wrongly recorded as equivalent: the test ran in the savepoint harness, where `RELEASE SAVEPOINT` on the aborted check throws. In production `COMMIT` of an aborted transaction silently rolls back, the check returns "proceed" and the provider is called. The test now uses real transactions; 1 fails |
| A1 `artifactIds` ignore the producing Invocation | passed at first (the tool's Artifact also names the LLM Invocation, via `referencedBy`); a uniqueness assertion was added |

Lesson: a test asserting that a check "cannot commit" after a failed statement must run on real transactions; savepoint-based harnesses throw where production does not.

## Verification

- Backend `tsc --noEmit`: exit 0. Backend suite: 62 files, 743 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: exit 0. Web suite: 6 files, 33 passed. The UI was not modified.
- `git diff --check`: clean.
- Two existing tests changed deliberately: the executor's exact event sequences now include `policy_evaluated`, and the "stop engaged mid-dispatch" test engages its stop inside the provider call (the pre-dispatch window is now covered by its own test). No test was removed.

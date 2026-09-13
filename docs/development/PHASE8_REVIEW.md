# Phase 8 — Independent Review (read-only)

**Reviewer:** independent architecture consultant (Opus), read-only.
**Snapshot:** working tree as of 2026-09-13 ~23:01 local. HEAD is `7648cc2`; **none** of the reviewed work is committed. The primary agent was editing `executor.ts`, `policy.ts`, `invocationLifecycle.ts` and adding `tests/governance/executionStop.test.ts` during the review, so later edits may supersede individual findings.
**Method:** I read the diffs and source, and grepped call sites. **I did not run the test suite.** `vitest` resets the shared test database's `public` schema in every file's `beforeAll` (`vitest.config.ts`), which would clobber the primary agent's test runs. Findings marked *by inspection* follow from the code and Postgres semantics; each one lists the test that would demonstrate it. **One execution check was run:** `npm run build` (`tsc --noEmit`, no database contact) passes cleanly on this snapshot.

Classification: **CONFIRMED DEFECT** · **PLAUSIBLE RISK** · **ARCHITECTURAL PREFERENCE**

---

## 1. Emergency stop (spec Phase 9.7)

### 1.1 CONFIRMED DEFECT (by inspection) — a `run`-scoped stop cannot reach the run it targets while that run is in flight

- `engageStop` inserts the `execution_stops` row, then calls `emitEvent` with `correlation.runId = scopeRefId` (`src/governance/executionStop.ts:233`).
- `emitEvent` takes `pg_advisory_xact_lock(hashtext(runId))` before allocating a sequence number (`src/events/emit.ts:123`). Transaction-scoped advisory locks are held until commit or rollback.
- The in-flight Executor transaction took that same lock the first time it emitted an event for the run, via `invocation_started` from `proposeInvocation` or `authorizeRoute`. The whole workflow advance runs inside one `db.transaction` (`src/api/liveEventRelay.ts:133`, `routes/approvals.ts`).
- **Result:** `POST /execution-stops {scope:"run"}` blocks on the advisory lock *before its INSERT commits*. The Executor's per-iteration `assertRunNotStopped()` therefore never sees the row. The stop lands only after the run's transaction ends, and the HTTP request hangs until then, which can be several 180 s CLI calls.
- `lift` for `run` scope has the same problem.
- Other scopes are unaffected: their events use `runId: null`, a separate `__null_run__` lock key, and nothing on the Executor path emits with a null runId.
- **Why the new test misses it:** `executionStop.test.ts:593` ("in-flight transaction observes a stop committed by a different connection") uses an in-flight transaction that never emits an event for `runRef`, so it never holds the lock. The test passes and the bug remains.
- **Demonstrating test:** connection A opens a transaction, emits any event with `runId = R`, then waits. Connection B engages `{scope:"run", scopeRefId:R}` with a 2 s timeout. Today B times out.

### 1.2 CONFIRMED DEFECT — a stop on the approval-resume path strands the pre-approval reservation and leaves the invocation and approval non-terminal

- `executor.ts:829-833`: on `existing.status === "awaiting_approval"`, `assertRunNotStopped()` runs **before** `resumeToolSpec`. Only `resumeToolSpec` calls `peekPendingReservation` → `releaseReservation` → `clearPendingReservation`.
- The stop handler (`executor.ts:784-798`) only updates `runs`.
- **Result:** the reservation stays in `budget_counters.reserved_amount` permanently. The `invocations` row stays `awaiting_approval`, the `approvals` row stays `pending`, the run is `failed`, and no `invocation_failed` event is written.
- A later approval does not repair it: resolving it and advancing hits the `runRow.status === "failed"` short-circuit (`executor.ts:736`), so the hold is never released.
- This is also a budget-accounting defect: a leaked reservation stays counted against the limit, at run scope today and in any future rollup.
- **Untested:** no stop test exercises `awaiting_approval`.

### 1.3 CONFIRMED DEFECT — spec 9.7 is not fully implemented

- **"Revoking a Grant auto-cancels its still-pending Approvals"** is absent. `grep revoke src` finds only `revokedAt` filters; nothing cancels pending approvals when a Grant is revoked. `reauthorize` catches it at resume time, but the approvals stay `pending` in the queue.
- **Scope set drifts from the spec.** The spec lists "global, per-Agent-Definition, per-Capability-Grant, per-Goal/Workflow-Run". The implementation has `global | agent_definition | capability_grant | workflow_run | run`: there is **no goal scope**, and `run` was added. If "Goal/Workflow-Run" means either, a goal-level stop is missing. If it means one concept, the spec should be amended explicitly rather than silently narrowed. The review brief says "all four stop scopes", which matches the spec's four, not the five implemented.

### 1.4 PLAUSIBLE RISK — `CapabilityGrant.id` is optional, and the grant-scope check skips silently when it is absent

- `policy.ts` declares `id?: string` "only so hand-built Grant values in Policy's own unit tests stay valid".
- `executor.ts:257` gates on `if (grant?.id)`. A Grant without `id` skips the capability_grant stop with no error.
- `resolveCapabilityGrant` always sets `id` today, so this is not exploitable now. It does rely on a type that allows the key to be missing, and it fails open.
- **Fix:** make `id` required on the resolver's return type, or use `if (grant) { if (!grant.id) throw …; assertNotStopped(…) }`.

### 1.5 PLAUSIBLE RISK — the check is at the invocation boundary, not immediately before dispatch

- The check precedes `resolvePlannedSpec`, `compileContext`, `authorizeRoute` and the provider call.
- A stop committed during those steps, or during a 180 s `claude -p` child, is honoured only at the next invocation. An in-flight child is never terminated. The design doc's §11 records this as a known gap.
- This matches the spec's "next Invocation boundary" wording, so it conforms. It is still the dominant real-world latency for an *emergency* stop now that invocations can last minutes. A second check immediately before `PROVIDERS[...]()` in `callModel`, and before `spec.execute()`, would close most of the window cheaply.

### 1.6 PLAUSIBLE RISK — a stopped Run's terminal transition emits no Event

- `executor.ts:786` writes `runs.status/outcome` with `reason: "execution_stopped"` but emits nothing. The LLM and deterministic paths propose no invocation, so the Activity feed shows no trace of why the run died.
- `failRun` has the same pre-existing pattern, but CLAUDE.md states "every meaningful state transition emits one or more immutable Events".
- The `execution_stop_engaged` event exists, but it is not correlated to the halted run for non-run scopes.

### 1.7 VERIFIED (emergency stop)

- All five implemented scopes block through the real Executor for deterministic, retrieval, tool and LLM kinds. A stop engaged between invocation 1 and 2 blocks invocation 2. Deferred thunks are not resolved while stopped. (`executionStop.test.ts` §1–2.)
- The lookup fails closed: errors become `ExecutionStoppedError`, and the rethrow in `executor.ts:799-806` preserves that even when the transaction is aborted.
- Stops only subtract. No branch in `executionStop.ts` authorizes anything, and lifting does not bypass Policy or Budget (tests at lines 457, 475).
- Exact scope/ref matching, the partial unique index, idempotent engage and a server-side actor are all tested.
- READ COMMITTED visibility of a committed stop row is tested, with the caveat in 1.1.
- The capability_grant stop marks the proposed invocation `failed` before rethrowing, so re-entry does not throw on a dangling `proposed` row.

---

## 2. Every Invocation dispatch path

| Path | Stop check | Budget | Notes |
|---|---|---|---|
| fresh tool (`processToolSpec`) | loop top + grant scope | usd reserve → reconcile | OK |
| resumed tool (`resumeToolSpec`) | loop top | release + fresh reserve | **1.2 leak** |
| llm (`processLlmSpec` → `callModel`) | loop top | reserve in routed unit → reconcile / release on throw | quota observation dropped (§4) |
| deterministic / retrieval | loop top | **none: `processGenericSpec` never calls `reserveBudget`** | see 2.1 |

### 2.1 PLAUSIBLE RISK (pre-existing, Ruling 6) — retrieval invocations dispatch completely unbudgeted

`processGenericSpec` (`executor.ts:616-649`) calls `reserveBudget` for neither kind. `reserveBudget` short-circuits only `costClass === "deterministic"`, so a `retrieval` spec with `costClass: "local_retrieval"`, or any non-free class, bypasses a check that would otherwise apply. The emergency stop now covers this path, but Budget does not. This did not change in Phase 8, but it falls inside "every dispatch path" and "run-budget authority". Either reserve for non-deterministic generic specs, or restrict `processGenericSpec` to cost classes that are free by definition and reject others.

**VERIFIED:** `executeRun` is the only dispatcher. The interpreter is its only caller (`src/workflow/interpreter.ts:395,427`), and `PROVIDERS[route.provider]` in `callModel` is the only provider dispatch. No module outside `src/router/providers/` spawns a process or imports a provider SDK.

---

## 3. Budget

### 3.1 OPEN SCOPE QUESTION (not a defect) — aggregate DAY budget is unimplemented, and the frozen spec defers it

- `BudgetScope = "run" | "task_instance"` (`budget.ts:67`, comment: "agent_definition/goal/day rollups deferred"). `day` exists only as a `budget_counter_scope` enum member (`schema.ts:59`). Nothing reserves against, provisions or reports a day counter, in either unit.
- **The frozen spec defers this deliberately.** The §18.1 table row "Budget Governor" puts "Per-Agent/per-Goal/per-day rollups beyond basic tracking" in the **Deferred** column.
- The review brief asks about an aggregate DAY budget, so **the human must decide whether Phase 8 expands scope**. Do not build it on the strength of this review alone.
- Why the question matters now: with `claude_subscription` primary for every tier, the only ceiling is per run. N runs can consume N × 200 000 `subscription_tokens` with no aggregate stop. That was an acceptable deferral while every tier billed per call in usd; it is less clearly acceptable against a shared, finite Max entitlement that the operator's interactive session also draws on (design Part 10).

### 3.2 CONFIRMED DEFECT (new half only) — the governed capability sets its own subscription budget ceiling (run-budget authority)

**Scope of the defect, precisely:** the usd line `ensureRunBudgetCounter(tx, runId, config.runBudgetLimit ?? "1.00")` is an **unchanged, pre-existing** line; capability code choosing its usd ceiling predates this work and should not be refactored under a Phase 8 banner. The **new** addition is the `subscription_tokens` line, which has **no override at all**. That new line is the defect. The pre-existing usd half is an ARCHITECTURAL PREFERENCE to revisit separately.

- Both capability builders provision the run's counters themselves:
  - `ensureRunBudgetCounter(tx, runId, config.runBudgetLimit ?? "1.00")`
  - `ensureRunBudgetCounter(tx, runId, DEFAULT_RUN_SUBSCRIPTION_TOKEN_LIMIT, "subscription_tokens")`

  in `publishReport/buildInvocationSpecs.ts:134-139` and `researchRetrieve/buildInvocationSpecs.ts:206-211`.
- The subscription ceiling is a constant with **no override at all**, and the usd one is an optional config with a hard-coded default.
- `ensureRunBudgetCounter` is first-writer-wins: it never lowers or reconciles an existing limit. Whoever provisions first sets the ceiling, and today that is the governed capability module.
- This inverts the Budget Governor's own contract. `budget.ts` header: rows are "provisioned by whatever process owns budget setup … auto-creating one here with some default limit would be an unspecified design decision". It also puts budget policy inside capability code, against Phase 4's module separation.
- Budget authority should sit with the operator or Goal/Workflow configuration, not with a capability deciding how much it may spend.

### 3.3 PLAUSIBLE RISK — per-invocation overshoot past the ceiling

- `reconcileBudget` adds the actual amount with no cap (`budget.ts:283-290`). The reservation is a worst-case estimate, `maxInputTokens + expectedOutputTokens`, but:
  - The subscription adapter passes **no output-token cap** to the CLI.
  - Its actual amount sums every `modelUsage` entry, including the internal secondary Haiku call and the CLI's own system prompt and schema tokens.
  - The Anthropic adapter hard-codes `max_tokens: 4096` regardless of `expectedOutputTokens` (`anthropic.ts:127`).
- So `consumed_amount` can exceed `limit_amount` after a single invocation. Later reservations are refused, so the damage is bounded to one invocation, but the "hard ceiling" is a soft ceiling plus one call.
- There is no test for reconcile beyond the limit.

### 3.4 VERIFIED (budget)

- Three-column counter key. Reservation ids carry `resourceUnit` and **reject** a missing or unknown unit (never defaulted to usd).
- Lock, reconcile and release act on the reserving unit only.
- An exhausted usd counter does not block subscription_tokens, and the reverse. A unit with no counter is refused.
- Covered in `tests/governance/resourceUnit.test.ts` (15 cases) and `budget.test.ts:43`.

---

## 4. Quota observation wiring

### 4.1 CONFIRMED DEFECT — quota observations are never recorded, so the guardrail is inert by construction

- `callClaudeSubscriptionModel` returns `quotaObservation` (`claudeSubscription.ts:839`), and `ProviderCallResult` declares it (`types.ts:84`).
- **`recordQuotaObservation` has zero production call sites** (grep: only its own module and tests).
- `callModel` (`modelRouter.ts:400-450`) reconciles, emits `invocation_completed`, and returns. It never reads `providerResult.quotaObservation`.
- **Root cause:** `callModel`'s declared return type `{ result; usage: { tokensIn; tokensOut; costAmount } }` is narrower than `ProviderCallResult`, so no caller can see the observation.
- **Consequences:**
  - `subscription_quota_state` (migration 0007) is never written in production.
  - `getQuotaState` always returns `undefined`, so `evaluateQuotaGuardrail` returns `UNKNOWN_ALLOWED / no_observation` **forever**, even with `enabled: true`.
  - The Phase 7C/7G guardrail, and the `quota_refused` stop-the-scan logic, can never trigger in production.
  - The Phase 7E integration test drives refusals with a **spy on the guardrail's decision**, not a recorded observation, so it cannot catch this.

### 4.2 CONFIRMED DEFECT — observations from failed invocations are lost

- Design Part 4 says: "A failed invocation may still carry an observation … emission is tied to the invocation terminating, not to its success."
- Every failure path in the adapter throws `ClaudeSubscriptionError`, which carries no observation. The `quota_exhausted` case, where the reading matters most, therefore discards the reading that explains it.

### 4.3 Transaction consistency — not applicable yet

Nothing is emitted, so there is nothing to check.

**Requirements once wired** (design Part 4):
- Record in the **same `tx`** as `invocation_completed`/`invocation_failed`.
- On the failure path, record **after** `releaseReservation` in the Executor's catch, not inside `callModel`, since the tx must survive.
- `causationId` = the `invocation_started` event.
- Key `provider_quota_observed:<invocationId>:<n>`.
- A rollback must leave neither the event nor the projection row.

There is a subtle ordering hazard in `selectCandidates`: the guardrail may **emit a latch-transition event** inside `authorizeRoute`, before any budget check. It is in the same tx, so it rolls back with the run if the tx aborts, which is acceptable. It does mean a latch transition can be recorded for an invocation that was never dispatched. That is harmless but should be documented.

---

## 5. usd / subscription_tokens separation

- **VERIFIED:**
  - `TierAccounting` is a discriminated union, so a subscription candidate cannot carry a price.
  - Each adapter asserts its incoming `accounting.unit` and hard-codes the `costUnit` it reports.
  - `emitEvent` refuses usage without a recognized unit, and readers fail closed on a null `cost_unit`.
  - The migration 0006 backfill mirrors the `hasUsage` predicate.
  - `quotaGuardrail.ts` and `subscriptionQuotaState.ts` import nothing from `budget.ts`.
- **PLAUSIBLE RISK — one unguarded seam:** `callModel` passes `providerResult.usage.costAmount` to `reconcileBudget` **without checking `usage.costUnit === route.accounting.unit`**. The reservation id fixes the counter's unit, so an adapter, or any test mock, that returns tokens for a usd route would silently reconcile tokens as dollars. Every Router and Executor test mocks the adapters, so nothing would catch it. A one-line guard closes it.

---

## 6. No fallback

**VERIFIED:**
- `authorizeRoute` takes `routing.candidates[0]` and dispatches once.
- `selectCandidates` `break`s on `REFUSE_QUOTA` and `PROVIDER_REJECTED`, so a refusal cannot promote the billable API candidate.
- The adapter never calls another provider.
- `ANTHROPIC_API_KEY` and 22 other credential variables are excluded by an allow-list environment.
- `--bare` and `--fallback-model` are absent.
- A missing `subscription_tokens` counter produces `insufficient_budget`, not a switch to usd.

**PLAUSIBLE RISK (configuration hazard):** static exclusions `continue`. Setting a subscription candidate to `enabled: false` (or narrowing `allowedResourceUnits`) silently routes CHEAP/STRONG to the billable Anthropic API. That API is funded by the capability-chosen `"1.00"` usd default (§3.2), with no Policy decision and no event marking the switch. This is documented as intentional, but it is one boolean away from the fallback 10.6.7 forbids. Consider requiring an explicit, evented operator action to demote a provider.

---

## 7. No retry

**VERIFIED:** there is no retry loop, backoff or re-dispatch anywhere in `src`. The CLI's internal structured-output retries are invisible, but their tokens are counted because `extractModelUsage` sums every `modelUsage` entry. `error_max_structured_output_retries` maps to `schema_validation` and releases the reservation.

---

## 8. Test and mock safety

- **VERIFIED:** every test file that can reach `executeRun`, `callModel`, the interpreter or the API server mocks `providers/claudeSubscription.js`, `anthropic.js` and `openai.js`. That covers `executionStop.test.ts`, `executor.test.ts`, `deferredInvocationSpecs.test.ts`, `interpreter.test.ts`, `modelRouter.test.ts`, the capabilities integration tests, the api tests and `phase7eGovernanceChain.test.ts`.
  - `candidateRouting.test.ts` imports the real Router without mocks, but calls only `selectCandidates` and reads source text. It never dispatches.
  - `claudeSubscription.test.ts` mocks `node:child_process`.
- **PLAUSIBLE RISK:** `tests/router/providers/claudeCliSmoke.test.ts` spawns the **real** `claude.exe`, enabled automatically whenever a CLI is installed (`it.skipIf(!installed)`), not by opt-in. It runs `--version` only, which consumes no entitlement, and it is one edit away from a live inference test on every `npm test`. Gate it behind an explicit env var such as `CLAUDE_CLI_SMOKE=1`.
- **PLAUSIBLE RISK:** `executionStop.test.ts` commits real rows to the shared test DB (`testDb.insert`, `engageStop` via `testDb.transaction`) and relies on `finally` cleanup. It correctly avoids committing a *global* stop, which would halt every other file. If a test process dies mid-test, a stray committed `run` stop is harmless because it uses a random id. Acceptable.
- **ARCHITECTURAL PREFERENCE:** the structural test "keeps executeRun reachable only through the workflow interpreter" counts `executeRun(` occurrences *in the interpreter*. It does not prove there are no other callers. Grep `src/**` instead.

---

## 9. Frozen-architecture compliance

- **ARCHITECTURAL PREFERENCE / process risk:**
  - The frozen spec is modified in the working tree (`M docs/superpowers/specs/...`) alongside the code measured against it. The amendments are disciplined (they quote what they supersede), but uncommitted, so "code conforms to spec" is not an independent check.
  - Amendments to 10.3, 10.6, 12 and 13.4 are present. **No amendment covers the Phase 9.7 scope change** (§1.3).
- **CONFIRMED (doc drift):** `docs/architecture/SUBSCRIPTION_PROVIDER_DESIGN.md` contradicts itself and the code:
  - §1.1 says quota state and the guardrail are "not implemented", but they exist.
  - The Part 14 table says 7D "defaults still Anthropic API" and "No stage flips a default provider", while Part 9 and `tierConfig.ts` make `claude_subscription` primary for every tier (7F).
  - Part 14 calls enabling the subscription provider "a separate, explicitly approved decision after 7E". **This review found no record of that approval.** Confirm it was made by the human, not the agent.
- **VERIFIED:** the single-chokepoint rule holds. The Executor stays thin: the stop check is a delegated call, and topology stays in the interpreter. The Router imports no Policy or Approvals code.

---

## 10. Unrelated changes and scope

**PLAUSIBLE RISK — unreviewable batch.** About 50 uncommitted files mix:
- Phase 7A–7H: resource units, migration 0006 (drops and recreates the `budget_counters` unique index), quota state (0007), the guardrail, candidate routing, a new MID tier, and a **production default provider switch to Claude Max**;
- benchmark scripts and raw data;
- research docs;
- `.env.example`;
- Phase 8's emergency stop (0008).

Nothing has been committed since `7648cc2` at 17:52. Phase 8 cannot be reviewed or reverted independently of the provider switch.

**Behaviour change riding along:** `standard` difficulty now routes to MID (Sonnet), where it used to route to CHEAP (Haiku). This silently re-tiers every existing standard task. It is pinned by `modelRouter.test.ts:199`, so it is intentional, but it has nothing to do with Phase 8.

**Minor:** `processLlmSpec` now passes `route.reason`, an enum code, as `invocation_failed.reason`, where other paths pass free-text error messages. The field mixes two vocabularies.

---

## VERIFIED

*Caveat: behavioural items below are **asserted by tests I read, not tests I ran**. Type-level items (total-map `PROVIDERS` dispatch, `TierAccounting` making a priced subscription candidate unrepresentable, `costUnit` required on `usage`) are backed by `npm run build` passing on this snapshot.*

- Stop enforcement for global, agent_definition, capability_grant, workflow_run and run, across all four invocation kinds, through the real Executor.
- The stop lookup fails closed. Stops never widen authority, and lifting never bypasses Policy or Budget.
- READ COMMITTED visibility of a committed stop row across connections, with the §1.1 caveat.
- Resource-unit separation in counters, reservation ids and events: fail-closed on missing units, no usd defaulting, no utilization-to-token conversion.
- No automatic provider fallback: a runtime refusal stops the scan, dispatch is single, credential env vars are stripped, and there is no fallback model.
- No retry machinery.
- The provider single chokepoint holds. The total-map dispatch leaves nothing to fall through to.
- Every dispatch-capable test mocks all three adapters.

## DEFECTS (CONFIRMED)

1. **§1.1** A `run`-scoped stop or lift blocks on the target run's advisory lock and cannot reach an in-flight run. The API request hangs until that run's transaction ends.
2. **§1.2** A stop on the `awaiting_approval` resume path leaks the reservation and leaves the invocation and approval non-terminal, permanently.
3. **§1.3** Spec 9.7 gaps: no automatic cancellation of pending Approvals when a Grant is revoked; no goal scope; the scope set changed without a spec amendment.
4. **§3.2** The new `subscription_tokens` run ceiling is hard-coded inside capability builders with no override, and provisioning is first-writer-wins.
5. **§4.1** Quota observations are never recorded. `subscription_quota_state` stays empty and the guardrail can never refuse.
6. **§4.2** Failed invocations discard their quota observation.
7. **§9** The design doc contradicts the shipped default provider, and there is no recorded approval for the switch.

## OPEN SCOPE QUESTIONS (for the human)

- **§3.1** Aggregate DAY budget: the spec (§18.1) defers per-day rollups, but the review brief asks about one. Decide whether Phase 8 expands scope before anyone builds it.
- **§1.3** Does "per-Goal/Workflow-Run" in spec 9.7 require a separate goal scope, or is `workflow_run` enough? Either implement one or amend the spec.
- **§9** Was the Phase 7F switch of every tier to Claude Max explicitly approved by the human?

## RISKS (PLAUSIBLE)

- **§2.1** Retrieval and other non-deterministic generic invocations reserve no budget (pre-existing).
- **§1.4** Optional `grant.id` fails open.
- **§1.5** The stop is honoured only at the invocation boundary; a 180 s child is not interrupted.
- **§1.6** A stopped run emits no terminal event.
- **§3.3** A single invocation can overshoot the ceiling (no output cap to the CLI; `max_tokens: 4096` fixed for the Anthropic API).
- **§5** `callModel` does not check the reported `costUnit` against the routed unit.
- **§6** Disabling a subscription candidate silently routes to the billable API.
- **§8** The real-CLI smoke test is enabled by the CLI's presence, not by opt-in.
- **§10** Phase 7 and Phase 8 are bundled with a production default switch and no commit boundary.
- The whole workflow advance, including 180 s subprocess calls, runs inside one transaction holding `budget_counters FOR UPDATE` and per-run advisory locks. This pre-dates Phase 8, but the subscription provider makes it much worse, and it is the root cause of §1.1.

## ARCHITECTURAL PREFERENCES

- **§3.2 (pre-existing half)** usd run ceilings are chosen in capability builders (`config.runBudgetLimit ?? "1.00"`). Budget authority belongs with operator or workflow configuration. Revisit outside Phase 8.
- **§8** The structural test counts `executeRun(` calls inside `interpreter.ts` only; grep all of `src/` instead to actually prove there is no other caller.
- **§9** The frozen spec is being amended in the same uncommitted tree as the code measured against it; commit spec amendments separately and first.
- **§10** Split the tree into reviewable commits (Phase 7A–7H provider work and default switch; Phase 8 emergency stop) so each can be reviewed and reverted independently.
- **§10 (minor)** `invocation_failed.reason` mixes enum codes (`route.reason`) with free-text error messages; pick one vocabulary, or add a separate `code` field.

## MISSING TESTS

1. A two-connection test where the in-flight transaction **emits an event for run R**, then a `run`-scoped stop for R is engaged from another connection with a timeout. (Exposes §1.1.)
2. A cross-connection stop observed **through `executeRun`** mid-plan, not only through bare `findActiveStops`.
3. A stop engaged while a run is `awaiting_approval`, then the approval resolved: the reservation is released, and the invocation and approval end terminal. (§1.2)
4. Grant revocation cancels pending Approvals. A goal-scope stop, or an explicit spec amendment removing it. (§1.3)
5. A Grant without `id` refuses rather than skipping. (§1.4)
6. `callModel` records `provider_quota_observed` plus the projection in the same tx as `invocation_completed`. A rollback leaves neither. A failed invocation that carries an observation still records it. (§4)
7. An end-to-end guardrail refusal driven by a **real recorded observation**, with `enabled: true` and no spy. (§4.1)
8. `callModel` rejects a `usage.costUnit` that differs from `route.accounting.unit`. (§5)
9. Reconcile when actual usage exceeds both the estimate and the limit: documented behaviour, and the next reservation refused. (§3.3)
10. *Only if the human confirms it is in scope:* DAY aggregate budget, in both units, across multiple runs. (§3.1)
11. The `subscription_tokens` run ceiling is configurable, and a capability cannot raise or choose its own. (§3.2)
13. A `retrieval` spec with a non-free cost class either reserves budget or is rejected. (§2.1)
12. Structural: no `executeRun(` call site anywhere in `src` outside `interpreter.ts`.

## RECOMMENDED FIXES

1. **§1.1** Emit stop engage/lift events with `correlation.runId: null` (put the target run id in the payload) so they never contend on a run's advisory lock. Alternatively, commit the `execution_stops` row in its own transaction before emitting. Add missing test 1.
2. **§1.2** In the stop handler, or before the check on the resume path, release every `pendingReservations` entry in `runs.budget_envelope`, mark `awaiting_approval` invocations `failed` (emitting `invocation_failed`), and expire or cancel their pending approvals, all in the same tx.
3. **§1.3** Implement approval auto-cancel on Grant revocation. Either add a `goal` scope (resolved via `workflow_runs.goal_id`) or amend spec 9.7 explicitly.
4. **§1.4** Make `id` required on `resolveCapabilityGrant`'s return type, and throw if it is missing at the stop check.
5. **§4** Widen `callModel`'s return type to `ProviderCallResult`. Record `quotaObservation` via `recordQuotaObservation` in the same tx, right after `invocation_completed`. Have `ClaudeSubscriptionError` carry the parsed observation, and record it in `processLlmSpec`'s catch after `releaseReservation`.
6. **§5** Before `reconcileBudget` in `callModel`, throw if `providerResult.usage.costUnit !== route.accounting.unit`.
7. **§3.2** At minimum, make the `subscription_tokens` ceiling overridable from the same configuration as `runBudgetLimit`, so it is not hard-coded in capability code. Moving *all* ceiling provisioning out of capability builders is the better end state, but it touches pre-existing usd code; do it as separate work.
8. **§3.1** Do nothing until the human confirms scope. If confirmed: a `day` scope counter per unit, reserved alongside `run` in the same tx with a fixed lock order (day, then run) to avoid deadlocks.
9. **§3.3** Pass an output-token bound to both adapters where one exists, or document reconcile overshoot as bounded to one invocation.
10. **§1.5** Optionally add a second `assertNotStopped` immediately before provider dispatch and before `spec.execute()`.
11. **§8** Gate `claudeCliSmoke.test.ts` behind an explicit env var.
12. **§9/§10** Update `SUBSCRIPTION_PROVIDER_DESIGN.md` §1.1 and Part 14. Get the human to confirm the 7F default-provider switch in writing. Split the tree into reviewable commits (7A–7H provider work; Phase 8 stop) before Phase 8 is signed off.

## OVERALL VERDICT

**NOT READY.**

The emergency-stop core is well built and unusually well tested for global, agent_definition, capability_grant and workflow_run scopes. It fails closed, never widens authority, and covers every invocation kind.

It still cannot be signed off:
- The `run` scope cannot stop an in-flight run (§1.1).
- A stop leaks reservations on the approval path (§1.2).
- Spec 9.7's approval auto-cancel is missing (§1.3).

Beyond the stop:
- Quota observation is not wired at all, so the guardrail the provider design depends on can never trigger (§4).
- The new subscription ceiling is hard-coded inside the capabilities it governs (§3.2).

The DAY budget (§3.1) is an open scope question for the human, not a blocker.

Fix §1.1, §1.2, §4.1 and §3.2 first. They are small, local changes, and each has a concrete failing test listed above.

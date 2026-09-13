# Phase 8 — Runtime Containment: Closure

**Status:** complete in the working tree, and **nothing is committed** (HEAD `7648cc2`).
**Verification (2026-09-13):**
- `tsc --noEmit` is clean.
- `vitest run`: 34 files, 568 passed, 2 skipped. Both skips are the gated live-CLI smoke tests.
- `git diff --check` exits 0.
- No live Claude invocations were made. Every dispatch-capable test mocks all three provider adapters.

## Delivered

- **Emergency stop (spec 9.7).**
  - Scopes: `global`, `agent_definition`, `capability_grant`, `goal`, `workflow_run`, and `run`, which is additive.
  - The check runs before every Invocation and fails closed.
  - API: `GET` and `POST /execution-stops`, plus `POST /execution-stops/lift`.
  - Stops are terminal and forward-only.
- **Grant revocation.** `revokeCapabilityGrant` expires pending approvals that no surviving Grant covers. It has no production caller yet; see the deferred items.
- **DAY aggregate budget.**
  - Inert: `DAILY_BUDGET_CEILINGS` is empty.
  - The day key is the UTC date. Locks are taken day first, then run.
  - Legacy reservation encoding is preserved while the ceiling is inert.
- **Run budgets are governance-owned.** `RUN_BUDGET_CEILINGS` is frozen at usd 1.00 and subscription_tokens 200000, and capabilities cannot pass their own limit.
- **Quota telemetry in `callModel`.** Recorded on success and on failure, inside a savepoint. It never touches budget. The guardrail stays disabled.

## Consultant cycles (2 of 2 used)

**Cycle 1.** Fixed D1–D4:
- D1: revocation cancels only uncovered approvals.
- D2: the stop path releases the hold, fails the invocation, expires the approval and emits `run_halted`.
- D3: test cleanup.
- D4: real savepoint and structural tests.

**Cycle 2.**

| Finding | Disposition |
|---|---|
| CD-1: a capability_grant stop was bypassed on approval resume | **Fixed.** The loop-top resume check now covers the capability_grant scope, using the stored capability and permission. The existing cleanup releases the hold, fails the invocation, expires a pending approval and emits `run_halted`. Two tests cover it (approved-then-redrive, and still-pending). A mutation check confirmed both fail when the check is removed. |
| Risk 1: concurrent revocations leave an approval pending | **Fixed.** `revokeCapabilityGrant` first locks every unrevoked Grant on the triple `FOR UPDATE`, in id order, before its conditional UPDATE. Survivors are the locked set minus the target. Concurrent revocations therefore serialize with no deadlock. A two-connection test checks the end state: both revocations succeed and the approval ends `expired`. **The test cannot tell the fix from a broken version.** A weakened `FOR SHARE` mutant also passed, because nothing forces the two transactions to interleave at the lock. The lock ordering rests on reasoning about Postgres READ COMMITTED behaviour, not on a test. (An earlier draft locked *after* the UPDATE, which would deadlock. The adviser caught it.) |
| Risk 2: only the first covering Grant was stop-checked | **Fixed.** `assertCapabilityGrantsNotStopped` checks every unrevoked covering Grant on both tool paths. Tested. Zero covering Grants (for example, revoked after approval) yields no stop keys, and `reauthorize` refuses the invocation with `reauthorization_failed`. Tested. |
| Risk 3: revocation takes run advisory locks in arbitrary order | **Deferred.** It stays latent until revocation has a caller. Postgres detects any deadlock and aborts one side. |
| Risk 4: the `now` option could dodge the daily ceiling | **Fixed.** A structural test forbids any options object in a production `reserveBudget` call. |
| Risk 5: cosmetic test indentation | Not changed. |
| Structural test requiring a Grant check before `spec.execute` | Not added. The behavioural tests and the mutation check cover it. |

## Deferred / human decisions required

1. **Stops permanently fail parked Runs.** A re-drive during any stop, even a brief global one, fails an `awaiting_approval` Run for good. This matches the documented forward-only rule. Confirm it is intended.
2. **Auto-cancelled approvals are recorded as `expired`, not a new `cancelled` status.** Confirm.
3. **One stopped Grant blocks even when another covering Grant exists.** Fail-closed is implemented. Confirm.
4. **DAY ceiling values and timezone.** Nothing is configured. Enabling a ceiling first needs the Phase 9 (B-4) serialization work, because the day counter is a global lock held across long transactions.
5. **Grant revocation route.** V1.1. Any caller must re-drive `affectedRunIds` in the same transaction.
6. **Commit boundaries.** The Phase 6–8 work is all uncommitted WIP.

## Phase 9 (B-4) — HARD STOP

B-4 means shortening the single long transaction that spans a provider call, which can take up to 180 s. A read-only assessment found that a human decision is required before implementation:

- **Crash recovery for an Invocation interrupted mid-provider-call is unspecified.**
  - The Executor explicitly scopes it out ("crash-recovery for non-terminal, non-awaiting_approval invocations is out of scope").
  - `claude -p` has no idempotency key, so a crash after dispatch may consume entitlement with nothing recorded.
  - Splitting the transaction forces a choice the frozen spec does not make: mark the Invocation failed on restart, re-dispatch it, or hold it for an operator.
- **API contract.**
  - Approve and advance routes currently return a synchronous `workflowStatus`, and tests pin that.
  - Moving provider calls out of the request transaction changes that contract.
  - The UI does not depend on it, because it uses SSE.

**Decision needed:**
- Choose the crash-recovery policy for in-flight Invocations.
- Say whether the synchronous response contract may change.

No roadmap item after Phase 9 is pre-approved. `docs/roadmap/NEXT_PHASE_PLAN.md` states that it "authorizes nothing".

# Routing Record, Cache Hits and Event Immutability: Closure

**Started:** 2026-09-14, from two independent spec-to-code audits (Context Compiler, Model Router and budget; workflow engine, data model, governance, API and events) run after the tier preference milestone.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V1 conformance. No new capability or infrastructure; one migration (0016); no live model calls.

## 1. What the audits found, and what happened to each

| Finding | Spec | Outcome |
|---|---|---|
| The recorded routing decision lacked the whole Context Budget and the budget authorization, and a refused route recorded nothing | §10.7 "every routing decision's complete input set … captured as structured payload on the Invocation's event" | **Built** (§2) |
| `invocation_completed.cache_hit` was hard-coded false though providers report cache reads | §5.11 "Cache hit/miss is logged as part of the Invocation's Event data"; §8.1 | **Built** (§3) |
| Events are immutable by convention only | §3e "append-only, immutable"; §8.7 | **Built** (§6) |
| One call can reconcile past its reservation and the Run's limit | §10.7 Pass 1 pessimistic estimate; Phase 4 hard ceiling | **Built, reviewed, withdrawn to a decision** (§4). A test now pins the current behaviour |
| The Compiler never packs to the chosen model's window | §5.17, §10.7 Pass 2 | **Recorded**: needs verified per-model context windows (`ROADMAP_STATUS.md` §6) |
| `retrieval` Invocations reserve no budget | Phase 4 "consulted for every Invocation" | **Recorded**: no plan emits one; either fix changes a contract |
| The seed creates Definitions and Grants (including an `AUTONOMOUS` Grant) with no events | §8.2 note, §9.4 "logged human edit", §3e | **Next milestone** |
| An SSE reconnect can skip an event that commits late | §15.3 | **Queued**: a sound fix changes the client's resume token (web contract) |

## 2. The complete routing decision

- `invocation_started` now carries difficulty, risk tier, the whole `contextBudget`, `defaultTier`, `historicalPerformance`, `budgetAuthorization` (`authorized`, provider, resource unit, estimated amount) and the resulting tier and model. `contextBudgetMaxInputTokens` is kept for existing readers.
- A refused route returns `{authorized: false, reason, decision}`. The decision holds the same inputs, the `attemptedTier`, and either the refused `budgetAuthorization` (with the model) or the `excludedCandidates` that explain a quota or candidate refusal. The Executor records it as `routingDecision` on `invocation_failed`, after the details and before the redacted reason, which it cannot override.
- The reservation id is not recorded: it is a forgeable handle `reconcileBudget` accepts, and the Run's envelope already holds it.

## 3. Cache hits

Each adapter reports `usage.cacheHit`: Anthropic `cache_read_input_tokens > 0` (nullable in the SDK), OpenAI `prompt_tokens_details.cached_tokens > 0`, the Claude CLI any `modelUsage[*].cacheReadInputTokens > 0` (read only after `extractModelUsage` has validated the map, and never failing a successful call). `invocation_completed` records it; absent reads as false. Cache tokens stay out of `costAmount`, as `SUBSCRIPTION_PROVIDER_DESIGN.md` requires.

## 4. The output cap: built, then withdrawn

The first version capped provider output at `expectedOutputTokens` (Anthropic `max_tokens`, OpenAI `max_completion_tokens`, via a new adapter argument), so Pass 1's estimate would be a real ceiling. The independent review showed this is a product change the spec does not make: §5.0 names `expected_output_tokens` an expectation and §10.7 only prices the reservation with it; the seeded Tasks expect 500 output tokens against the previous 4096; and no code detects truncation, so a cut-off synthesis would have been stored as a completed Artifact once an API candidate is primary. The cap and its plumbing were removed. What remains is a budget test proving the current behaviour: a reconcile past the limit is recorded as it happened and every later reservation is refused. The decision, with what a "yes" would also require (truncation detection, a verified CLI flag), is in `ROADMAP_STATUS.md` §6.

## 5. Independent review (Opus) of the routing change

No correctness regressions or crash paths. Checked and fine: callers and types (only `benchmark/`, outside tsconfig, calls an adapter), durable execution (a `PendingModelDispatch` is never persisted or rebuilt), SDK field types, the CLI cache read's safety, refusal payload contents and size, consumers (the projector's `resultingTier`, the trace API, the web event summary), refusal flow.

| Finding | Disposition |
|---|---|
| Medium 1: the output cap is a product change and truncation is silent | **Withdrawn to a decision** (§4) |
| Medium 2: a zero or oversized cap fails or is charged | **Moot** with the cap removed |
| Low 3: the reservation id in streamed events is a forgeable handle; refusal and success `budgetAuthorization` differed | **Fixed**: removed from the payload; the refusal keeps `modelId` because it has no `resultingModelId` |
| Low 4: loosened refusal assertions without decision checks; missing null/miss cache cases | **Fixed**: quota refusal asserts its decision and excluded candidate; Anthropic `null` and OpenAI miss cases added |
| Low 5: README linked a closure record not yet written | **Fixed** (this file) |

## 6. Event log immutability (migration 0016)

`events_refuse_mutation()` raises on any row UPDATE or DELETE and on TRUNCATE (a statement trigger; a plain TRUNCATE is already refused because other tables reference `events`, so the test uses CASCADE to reach the guard). Inserts are unaffected. No source code updated or deleted events, so nothing in `src/` changed.

Tests that commit real events and must clean them up call `deleteEventsForTest` (`tests/testDb.ts`), which disables the row trigger, deletes and re-enables it inside one transaction. The migration 0006 backfill test replays its UPDATE with the trigger disabled inside its rolled-back transaction, as the 0011 replay already does for Tool Bindings. `tests/db/eventImmutability.test.ts` proves UPDATE, DELETE and TRUNCATE are refused, the row is unchanged, and the guard is back after a cleanup.

## 7. Mutation checks

Each mutant was applied, the named tests run, and the file restored byte-for-byte.

| Mutant | Result |
|---|---|
| R4 `cache_hit` hard-coded false again | 1 fails |
| R5 the Executor drops the refused routing decision | 1 fails |
| R6 the Context Budget left out of the record | 2 fail |
| R7 budget authorization left out of a refusal | 1 fails |
| R8 the CLI never reports a cache hit | 1 fails |
| R10 Anthropic never reports a cache hit | 1 fails |
| R11 a quota refusal records no excluded candidates | 2 fail |
| E1 events may be deleted | 2 fail |
| E2 events may be updated | 1 fails |
| E3 events may be truncated | 1 fails |
| R1–R3, R9 (the output cap) | caught before the cap was withdrawn; removed with it |

## 8. Verification

- Backend `tsc --noEmit`: exit 0. Backend suite: 64 files, 780 passed, 2 skipped (the gated live-CLI smoke tests).
- Web: not changed.
- Migration 0016 applied to the local database with `npm run db:migrate`.
- `git diff --check`: clean.
- Existing tests changed deliberately: the Router's exact `invocation_started` payload, four route-refusal assertions (`toEqual` to `toMatchObject` plus decision checks), and eleven committed-event cleanups routed through `deleteEventsForTest`. No test was removed.

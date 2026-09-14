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
| The Compiler never packs to the chosen model's window | §5.17, §10.7 Pass 2 | **Built** in a follow-up (§10), once the windows were verified |
| `retrieval` Invocations reserve no budget | Phase 4 "consulted for every Invocation" | **Recorded**: no plan emits one; either fix changes a contract |
| The seed creates Definitions and Grants (including an `AUTONOMOUS` Grant) with no events | §8.2 note, §9.4 "logged human edit", §3e | **Built** in a follow-up commit (§9) |
| An SSE reconnect can skip an event that commits late | §15.3 | **Recorded** (`ROADMAP_STATUS.md` §5a): a sound fix changes the delivery design or the client's resume contract; the relay's false "next replay" comment is corrected |

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

## 9. Follow-up: the seed goes through the Registry

`seedResearchWorkflow` and `seedPublishWorkflow` inserted Capabilities, Tool Bindings, Agent / Task / Workflow Definitions and Capability Grants directly, so a seeded database's event log never showed the authorization every default Goal runs under, including the Researcher's `AUTONOMOUS` Grant. They now call `registryWrites.ts`'s create functions in the caller's transaction, in the order they already used (Grants before the Workflow that puts their Agent in use), with the V1 operator actor the Registry routes record. The seeded Goal emits `goal_created`, as `POST /goals` does. The seeded rows are unchanged (ids aside): versions (all 1), Grants, bindings and the graph; the duplicated `validateCapabilityGrant` pre-check is gone because the Registry runs it.

Review (Opus): no correctness regression; every seeded column verified equal, callers unaffected (no test seeds twice in a database or asserts a no-Run event count). Fixed: the structural test now resolves import aliases and namespace imports and scans raw `INSERT INTO` SQL, with a probe test; stale "frozen" and "duplicate rows" comments in `runSeed.ts`/`lookupSeed.ts`. Residual: `npm run seed` holds the no-Run event lock while taking later per-name Registry locks, so a concurrent Registry write in the opposite order can deadlock; Postgres aborts one side (40P01) and nothing hangs.

- `tests/definitions/seedEvents.test.ts`: a `definition_version_created` for each of the nine Definitions, Capabilities and Tool Bindings; `capability_granted` for both Grants with their autonomy states; `goal_created`; each Grant logged before the Workflow Definition; the seeded rows unchanged.
- `tests/execution/structuralInvariants.test.ts`: in `src/`, only `definitions/registryWrites.ts` inserts into the Definition, Capability, Tool Binding and Grant tables.
- Full suite on the committed tree: 65 files, 784 passed, 2 skipped; `tsc` exit 0. No existing test needed a change: nothing asserted an empty log after seeding.

| Mutant | Result |
|---|---|
| S1 the seeded Goal emits no `goal_created` | 1 fails |
| S2 the seed inserts a Grant directly | 1 fails (structural test) |
| S3 seeded facts attributed to `system` | 1 fails |

## 10. Follow-up: packing to the routed model's window (§5.17, §10.7 Pass 2)

Recorded above as waiting for verified per-model windows. Anthropic's models overview (fetched 2026-09-14) states them: Claude Haiku 4.5 200K tokens, Claude Sonnet 5 and Claude Opus 5 1M. Each provider candidate now records `contextWindowTokens` (validated as a positive integer), and `authorizeRoute` resolves `effectiveMaxInputTokens = min(maxInputTokens, contextWindowTokens − expectedOutputTokens)` for the candidate it chose. The Executor compiles to that, which is where the Compiler's header already said the resolution belonged; the Compiler itself is unchanged. If the Task's required context no longer fits, the existing `ContextBudgetError` path fails the Invocation and releases its reservation before any call. The reservation stays priced at the Task's budget, the pessimistic estimate.

Recorded: `invocation_started` carries `contextWindowTokens` and `effectiveMaxInputTokens`; `context_compiled` adds both, keeping `maxInputTokens` as the Task's budget (the Agent Detail lineage reads it). At every seeded budget (8,000 input tokens) the effective limit equals the budget, so nothing packs differently today.

Not built: §5.17's cache-block granularity. Minimum cacheable prefixes differ per model, but the prompt has no stable prefix while the untrusted-data fence tag changes per call, which is the open stable-prefix question. Residual: a `claude_subscription` call also carries the Claude CLI's system prompt, so its effective window is smaller than the model's by an unmeasured amount; it matters only for a budget near the window.

| Mutant | Result |
|---|---|
| W1 the Router ignores the window | 1 fails |
| W1b the window is not reduced by the expected output | 1 fails |
| W2 the Executor compiles to the Task budget | 1 fails |
| W3 the window is left out of the routing record | 2 fail |
| W4 a non-integer or non-positive window passes validation | 4 fail |

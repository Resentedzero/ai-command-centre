# Phase 9 and follow-on hardening: Closure

**Date:** 2026-09-14.
**Status:** local commits on `main` after `7648cc2`, none pushed. The table below lists them; later work appends rows.

**Verification at the end of the final repository pass (the commit adding the redaction end-to-end test):**
- backend `tsc --noEmit` clean;
- backend vitest: 41 files, 638 passed, 2 skipped (both are the gated live-CLI smoke tests);
- web `tsc` clean, web vitest 6 files, 33 passed;
- `git diff --check` clean.

No live Claude invocations were made. Every dispatch-capable test mocks all three provider adapters.

## Commits

| Commit | What |
|---|---|
| `807a98d` | Subscription-provider research and benchmark evidence, committed as found |
| `ce7155c` | Phases 6–8, committed as found: Claude Max runtime and runtime containment |
| `b33a929` | **Phase 9: durable execution.** Provider calls happen outside DB transactions; `executing` is persisted; interrupted Invocations settle conservatively; single-executor lock; startup recovery |
| `bc8da98` | Tool Binding trust re-checked on approval resume (roadmap Appendix A #4) |
| `8402388` | API request guards (DNS rebinding, cross-site POST); generic 5xx; id validation; 404/409 |
| `2c7ee9e` | Lifecycle and accounting events (spec §8.2/§8.5); correlation completed from `runId` |
| `b196bf1` | Approval TTL expiry (spec §9.5): refusal, list filter, sweep + re-drive |
| `c9b5305` | Context Compiler: instructions layer, Goal in task state, untrusted-data fencing, `context_compiled` |
| `f7c9919` | Live events relayed per commit; `POST /workflow-runs/:id/advance` |
| `ecefb93` | Failure text redacted in events; SSE replay paged and bounded; UI reconnect backoff |
| `ca2d011` | Fixes from the adversarial review of the six commits above |
| `40c61d6` | Approved content pinned by hash; approvals queue shows goal, action, agent and a content preview |
| `9598cae` | This closure record |
| `d2377dc` | Workflow/Task view (spec §15.1 screen 3): read API plus `/workflows` list and detail pages |
| `d9ebb69` | Goals & Projects view (spec §15.1 screen 5), with start-a-goal |
| `cc168eb` | Agent Detail view (spec §15.1 screen 2), with the agent-scope stop control; performance shown as unavailable |
| `b76aa6b` | Fixes from the adversarial review of the three UI commits: goal-failure copy, unfinished runs always shown, stop is per version and lifted by id, live refresh, read-model hardening |
| `8810d3e` | This closure record: `b76aa6b` and its verification |
| `70b1346` | Final repository pass. **Approve/Reject never worked from a browser:** `apiFetch` sent a JSON Content-Type on body-less POSTs, which Fastify refuses with 400. Also: API errors surface their message; a decision whose advance fails is reported as recorded; missing seed is a 503 naming the fix; cross-site requests and HEAD routes refused (event-stream slot holding); SSE backlog bounds; no empty-state flash; feed de-duplicates |
| `0128db9` | Final repository pass. OpenAI adapter no longer invents zero usage; a model's output mentioning quotas is no longer classified `quota_exhausted` (which released the reservation); `publishReport` records a relative path, not the host's absolute path |
| `3b870d1` | Final repository pass. Structural invariant tests (no provider call in a transaction, single chokepoint, status changes recorded as events); stale pre-Phase-9 headers and docs corrected; two residuals recorded |

The authoritative write-ups are:
- `docs/architecture/DURABLE_EXECUTION.md`;
- the dated implementation notes in the spec (§3a, §5.15, §8.2, §9.5, §9.8, §13.2);
- the amended Part 8 table in `docs/architecture/SUBSCRIPTION_PROVIDER_DESIGN.md`.

## Decisions made without a human, and why

Each follows the safer or more conservative reading. Say so if any should change.

1. **Interrupted Invocations are never re-dispatched.** Their reservation is charged at its full estimate, not released, and the Run fails. A retry is a new Run (§3b). Releasing would hand back capacity the provider may already have consumed.
2. **Failed dispatches of unknown consumption are charged at estimate.** This covers a timeout, a crash mid-stream and missing usage. It supersedes Part 8's earlier "timeout → release" rule. Only failures that provably sent nothing, or were refused outright, release.
3. **One executor process per database**, enforced by an advisory lock at startup. The process exits if the lock connection is lost.
4. **Startup re-drives every `in_progress` Workflow Run** through the ordinary driver, with all governance checks. This continues work its original request authorized; interrupted dispatches are already settled, so this cannot become a spend loop.
5. **An expired Approval is handled as a rejection.** The hold is released, and the Invocation, Run and Workflow Run fail (spec §9.5). The TTL stays at the documented MVP default of one hour.
6. **Goal title and description are trusted task state.** They are not fenced, because they are the operator's own text.
7. **The approval hash pin is required.** Any Approval created before it existed fails closed when resumed.

## Reviews and dispositions

- **Phase 9: two adversarial reviews** (concurrency, and governance/budget).
  - Fixed: sweep row isolation; the pause/resume lost update; the approve/stop lock order; exactly one terminal event per model Invocation; the charged amount recorded in the failure event; consumption-aware settlement; instance-lock loss detection.
  - Documented as residuals: see below.
- **Security review.**
  - Fixed: DNS rebinding and cross-site request forgery (CONFIRMED High); SQL text leaking in 5xx responses; raw error text in events; unbounded SSE; untrusted content in prompts (fencing); approving content the operator could not see.
- **Spec-versus-code gap analysis.** Items #1–#5 and the fixable parts of #6 and #8 are done. #7 needs a decision (below).
- **Adversarial review of the six post-Phase-9 commits.**
  - Fixed: sweep and re-drive not relayed live; the tool budget basis; relay tracking that could throw; a double reconcile the log would hide; a guessable fence tag; framing tokens not counted against the budget; the sweep depending on the seed; four weak tests.
  - Noted: R3 (latent run_failed key sharing) and R7 (a boundary race near the TTL, which fails closed).
- **Final repository pass: four independent audits.**
  - Scope: execution and accounting; API/UI contract and security; context, capabilities and artifacts; docs, dead code and test gaps.
  - Fixed: see `70b1346` and `0128db9`. Every new test was confirmed to fail against the previous code.
  - Added: structural invariant tests (no provider call in a transaction, single chokepoint, status changes recorded as events), and stale headers and docs corrected. An end-to-end test that a provider error's host path is redacted in both `invocation_failed` and `GET /workflow-runs/:id`. The structural and redaction tests were each confirmed to fail against a deliberate mutation.
  - Untested: the SSE backlog bounds (`maxBufferedLiveEvents`, `maxPendingWriteBytes`), which only trigger for a stalled client.
  - Documented as residuals: DURABLE_EXECUTION §7 #10 (a throw on resume leaves an approved hold) and #11 (a stop during context compilation).
  - Not acted on, low value or needing a decision: context "reference" mode inlines content (unreachable with the seeded budget); routing provider and excluded candidates are not on events; the tool-schema layer carries binding config (never sent today); unused exports; list paging.

## Residuals

These are known and documented; none has a safe unilateral fix.

- **Tool side effects run inside the transaction.** A crash after `publishReport` writes its file, but before commit, leaves an unrecorded file. Fixing it needs the §12 idempotency-key pattern, which is warranted once a tool has real external effects. (DURABLE_EXECUTION §7.1)
- **An in-flight `claude -p` child cannot be stopped.** Stops act at Invocation boundaries; the adapter timeout is the only bound. (§7.2)
- **Ambiguous COMMIT.** If a commit succeeds but the client sees an error, the Run shows `in_flight` until restart, and is then charged at estimate. (§7.4)
- **A lost recording becomes "unknown".** If recording a successful dispatch fails, the Invocation is later settled at estimate. (§7.5)
- **The Claude CLI has no separate system channel.** The untrusted-data policy precedes the fenced data in the same stdin text. Changing this changes live-verified argv. (spec §5.15 note)
- **An Approval can be refused just after it is granted.** If the resume happens after the TTL passes, re-authorization refuses it. This fails closed.
- **A throw while resuming an approved step leaves its hold reserved.** It needs corrupted data and fails closed. (§7 #10)
- **A stop committed during context compilation does not stop that one dispatch.** The next Invocation is refused. (§7 #11)

## Decisions required from you

1. **Retry policy.** The spec says retries create new Runs "up to a policy-defined retry limit", but no limit or eligibility rule is defined anywhere. Needed: a limit, which failures qualify, and how retries interact with Approvals and budgets. `interrupted_outcome_unknown` must never auto-retry. The builders and interpreter currently assume one Run per Task Instance.
2. **Artifact storage threshold (spec §12/§13.3).** All artifacts are stored inline in Postgres today. Moving large ones to the filesystem needs a size threshold. It is not needed at current sizes.
3. **Separate system channel on the Claude CLI.** It needs a live CLI verification run, which consumes subscription entitlement.
4. **Carried over from Phase 8:**
   - DAY ceiling values and timezone. These are no longer blocked by Phase 9.
   - Whether stops should permanently fail parked Runs.
   - A grant revocation route.
5. **Confirm or reverse** the seven decisions made above, especially #2 (charge on timeout) and #4 (startup re-drive).

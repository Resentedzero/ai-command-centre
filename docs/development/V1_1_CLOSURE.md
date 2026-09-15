# V1.1: Closure

**Started:** 2026-09-15, on the operator's V1.1 implementation brief (Agent Builder, Workflow Builder, Deliverables, Keeper, bounded autonomous agents) and approved architecture changes R1–R4.
**Status:** see §9. Local commits on `main`; nothing pushed.
**Plan:** `docs/superpowers/plans/2026-09-15-v1.1-plan.md` (the proposal the brief approved, with the operator's corrections below).

## 1. Decisions applied

| Decision | Value | Where |
|---|---|---|
| R1 early stop | A deferred plan position may resolve to `skip`; the plan's maximum length is fixed when it is built; a skip is sticky once later positions ran; a position with an Invocation can never skip (it fails as `resume_spec_mismatch`) | `src/execution/types.ts`, `src/execution/executor.ts` |
| R2 async goal start | `POST /goals {async: true}` answers 202; the same in-process driver continues; startup re-drive recovers | `src/api/routes/goals.ts` |
| R3 step validation | Each task kind validates its step parameters when a Workflow Definition is saved; `?dryRun=1` runs every Registry check without writing | `src/capabilities/taskPlans.ts`, `src/definitions/registryWrites.ts`, `src/api/routes/registry.ts` |
| R4 loop event | `agent_loop_iteration_recorded`: one per iteration, one terminal; structured fields only, model-derived strings bounded | `src/capabilities/agentObjective/buildInvocationSpecs.ts` |
| Autonomy limits | 12 iterations, 15 active minutes (approval waits excluded), Task Instance `subscription_tokens` 50,000 (existing ceiling, no override) | `src/governance/autonomyLimits.ts` |
| No automatic retry for autonomous tasks | `agent_objective` pinned in the retry policy | `src/governance/retryPolicy.ts` |
| Markdown renderer | `react-markdown` + `remark-gfm`, raw HTML skipped, no images, unsafe links dropped (D21) | `web/components/deliverable/DocumentView.tsx` |
| Branching | Deferred: workflows stay linear; the autonomous loop is the only loop | — |
| Research | `research.retrieve` = data already held (fixture or local corpus); `research.search` / `research.open` not built; deliverables record their evidence basis by code | `src/capabilities/toolAdapters.ts` (`evidenceClass`), `src/capabilities/shared/deliverable.ts` |
| Local research fixture | `C:\Users\cress\ai-command-centre-data\research-corpus` (outside Git; README only). Not bound: the seeded `research.retrieve` binding stays the synthetic fixture | — |
| Claude Max default, no silent API fallback | Router unchanged in order; an Agent may restrict routing to one configured provider (`provider_mismatch`, never another) | `src/router/modelRouter.ts`, `src/definitions/executionProfile.ts` |

## 2. What was built

**Deliverables (M1).** `deliverable/v1` Artifacts (title, summary, Markdown body, findings, recommendations, sources, completion, code-recorded evidence basis) on the unchanged immutable Artifact model. Web: Document (default) / Evidence (provenance, sha256, Verify integrity, sources and basis) / Raw. V1 `report` artifacts render as documents too.

**Agent Builder (M2).** `POST /agent-definitions` creates a version with its Grants and execution profile in one transaction (migration 0020 adds `agent_definitions.execution_profile`). Profiles: preferred logical tier (as task difficulty), provider restriction, loop limits (only lower than the ceilings). `GET /registry` exposes builder options from runtime configuration. Web: recruit, new version (history untouched), versions, confirmed revoke, profile line.

**Workflow Builder (M3).** Linear composer over the existing interpreter: stable `stepId`/`label`, graph `description`, explicit `inputs` from earlier steps (resolved by reference from the source step's completed Run), `agent_task` (writes a deliverable), `operator_checkpoint` + `review.checkpoint` (an ordinary governed Approval pinned to the gated outputs' hashes, only for an agent holding it at ALWAYS_APPROVE), trusted step directives in the Compiler's invocation-instruction layer, async start, goal workflow picker.

**Autonomous agents (M4).** `agent_objective`: decide → act → record per iteration, then conclude → write → persist. Thinking actions are LLM intents (no Grant). Tools need a registered loop action, the step's allow-list and call limit, the agent's Grant, and still pass Policy, budget, Approvals and stops; a decision can fill only a loop action's declared fields, so Policy's risk inputs are unreachable. Refusals are recorded and the loop continues; a Policy DENY or failed call fails closed. Context per call: agent instructions, the Goal, a trusted directive, the latest compact ledger and at most four requested artifacts. A read-only budget headroom check (`src/governance/budgetHeadroom.ts`) ends the loop cleanly before the Governor must refuse. Web: Autonomous work panel; Give an objective (the agent version's objective workflow, created through the Registry and reused while unchanged).

**Independent R1 review (M5).** No Critical or High findings; all nine R1 points verified. Low findings fixed: resume of a position that no longer resolves to a tool fails as `resume_spec_mismatch` (hold released); a rebuilt plan's iteration ceiling must match the recorded ledger; retry exclusion pinned; event strings bounded. Info findings recorded in §8.

**Keeper (M6).** `GET /keeper/explain` and `GET /keeper/guide` answer from rows, events and `docs/keeper` cards with no model, no Run and no write (tested by counts and a structural check). `POST /keeper/questions` (Think) is an ordinary governed Goal in the Keeper project, run by the Keeper agent (CHEAP; READ-only Grants on `system.inspect` and `docs.retrieve`); its proposal only pre-fills a builder form. Web: the Keeper in the entrance hall (static Rogue frame, D22), a Keeper door on every screen, the panel.

## 3. Schema, migrations, events, APIs

- Migration **0020** `agent_definitions.execution_profile jsonb not null default '{}'` (additive). Applied to the local database 2026-09-15.
- New event type: `agent_loop_iteration_recorded`.
- New or changed routes: `POST /agent-definitions` (grants, executionProfile), `POST /*-definitions?dryRun=1`, `POST /goals` (`async`), `GET /registry` (`builder`, profiles, loop actions, thinking intents), `GET /agents/:id` (profile), `GET /workflow-runs/:id` (step task kind), `GET /keeper/explain`, `GET /keeper/guide`, `POST /keeper/questions`.
- New Capabilities (seeded through the Registry, idempotent): `review.checkpoint`, `system.inspect`, `docs.retrieve`. New task kinds: `agent_task`, `operator_checkpoint`, `agent_objective`, `keeper_answer`. New seeded Definitions: Agent Task, Autonomous Objective, Approval Gate, Keeper Answer; Reviewer and Keeper agents; Keeper project; Keeper Think workflow.

## 4. Tests (all model calls mocked)

- Backend: 82 files, **967 passed, 2 skipped**; `tsc --noEmit` clean.
- Web: 16 files, **112 passed**; `tsc --noEmit` clean; `next build` succeeds (routes include `/agents/new`, `/workflows/new`).
- New suites: `tests/api/agentBuilder.test.ts`, `tests/api/workflowBuilder.test.ts`, `tests/router/providerRestriction.test.ts`, `tests/execution/skipPositions.test.ts` (R1), `tests/api/autonomousLoop.test.ts`, `tests/api/keeper.test.ts`, `tests/api/noApiFallback.test.ts`, `tests/capabilities/deliverableOutput.test.ts`; web `deliverable`, `agentBuilder`, `workflowBuilder`, `autonomy`, `keeper`.
- Updated for intended behaviour changes: registry grant test (R3 needs a valid publish graph), seed counts (V1.1 building blocks), retry facts (`taskKind`), agent detail keys (Revoke), goals form (async, picker), artifacts views (tabs).
- Known flake (pre-existing, unchanged files): `web/tests/overview.test.tsx` "renders one entry per active Agent Definition…" occasionally times out under full-suite load; passes alone.

## 5. Live runtime check (one authorized run)

Direct calls to the subscription adapter (`callClaudeSubscriptionModel`, CHEAP `claude-haiku-4-5-20251001`, no API key, nothing can retry or fall back), one per new structured output format, 2026-09-15 22:30 UTC:

| Format | Result | Usage (subscription_tokens) |
|---|---|---|
| DecisionV1 (decide) | valid | 2,641 |
| DeliverableV1 (final write) | valid | 3,226 |
| WorkResult (thinking action) | valid | 1,585 |
| KeeperAnswer (Think) | valid | 1,946 |

Total 9,398 tokens; quota observed `allowed` (five-hour 21%, seven-day 17%). Direct adapter calls touch no budget counter, as in V1.

## 6. Live dogfood (one run, through the UI)

A headless browser drove the real screens at `localhost:3100` against the API on current code (migration 0020 applied, `npm run seed`). Before starting, the API's startup TTL sweep expired a stale V1 approval and failed its Workflow Run (no model call).

1. **Agent Builder:** recruited **Idea Architect v1** (key `research.retrieve` READ AUTONOMOUS; MID; `claude_subscription` only; 6 iterations) and **Strategist v1** (no keys).
2. **Workflow Builder:** composed **AI Opportunity Discovery v1**: Autonomous Objective (Idea Architect; brainstorm, analyse, compare, critique, write; `research.retrieve` ≤ 3 calls) → Approval Gate (Reviewer, pinned to step 1's output) → Agent Task (Strategist, input step 1). **Check** passed; saved; started the goal "Find promising opportunities for AI automation in small businesses" (async).
3. **Autonomous work** (Workflow Run `12d41461-0728-428a-b267-88f6df6b46f3`): iteration 1 **brainstorm** (10 candidates), iteration 2 **critique** (ranked, 4 eliminated), iteration 3 decided an unlisted thinking action "develop" → **refused** and recorded; the next decide was **skipped for budget headroom** (R1: positions 10–18 never ran), conclude recorded `incomplete / budget_headroom` after 3 of 6 iterations and 195 active seconds; the final write produced the deliverable. 42,076 subscription_tokens on the loop's Run, all routes `claude_subscription` at MID, budget outcomes `authorized`, no retries. The agent did not use `research.retrieve`, so the deliverable's basis correctly says no external research and model knowledge only.
4. **Approval gate:** approved in the Approvals screen; the Strategist wrote "What to Build First: AI Missed-Call Answering for Service Businesses" (10,530 tokens). Workflow Run `completed`.
5. **Deliverables:** both open as documents; Evidence showed provenance and **Verify integrity** reported the stored bytes match the hash for both; Raw showed the stored JSON.
6. **Keeper:** the panel explained the completed run and linked both deliverables (no model).

What the dogfood showed, and what changed because of it:
- The loop ended on its **budget headroom**, not on its own finish: at MID each decide/act/write call consumed about 6k tokens, so the 50,000 Task Instance ceiling allowed three iterations plus the final write. Agent-decided finish, and the skip of the remaining iterations, is proven by the mocked acceptance tests; it was not observed live. The ceiling is the operator's value and was not changed.
- The model invented a thinking action; the loop refused it. **Fixed** (`26f29db`): the decision schema now enumerates the step's allowed intents and tools.
- The final write JSON-encoded the whole deliverable inside `body`, so the Document view showed raw JSON after the summary. **Fixed** (`26f29db`): persisting unwraps such a body once, by code. The artifact produced in this dogfood is immutable and still shows it.

## 7. Browser QA

An independent reviewer drove a headless Chrome over the ten V1.1 routes at 1280×800, 1440×900 and 1920×1080, read-only (no Save, Start, Approve, Revoke, Stop or Think; only GETs and the read-only hash check). Findings, and what changed:

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | `.field { flex: 1 1 260px }` applied to fields in a **column**, so the basis became height: every top-level input was 260 px tall and Save sat ~2,300 px down, below the fold at every viewport | **Fixed:** the 260 px basis now applies only to `.row > .field` (`web/components/agents/builder.module.css`) |
| 2 | High | The autonomous-work status line put `--pixel-label-dim` on parchment — measured 1.9:1, against the rule that parchment carries ink only | **Fixed:** the stop-reason token and active minutes are ink (`web/components/workflows/LoopPanel.tsx`) |
| 3 | Medium | At 1280×800 the 440 px Keeper board covered part of "Stop agent" on the agent board | **Fixed:** the board is 360 px at ≤ 1280 (`web/components/keeper/keeper.module.css`) |
| 4 | Low | Dev-only noise: `favicon.ico` 404, and React's dev double-invoke repeating board fetches | Not changed; dev-mode only |
| 5 | Note | The performance table is wider than its column but sits in `overflow-x: auto`, so the page never scrolls sideways | By design |

Verified: no horizontal page scroll on any route or viewport; no console errors or exceptions beyond the favicon 404; a visible 2 px cream focus ring on every control of both builders with no trap; the loop ceilings, builder options, counts, iteration rows, stop reason and artifact metadata all trace to API fields, with no invented data; `?from=` prefills a new version and says the old one is untouched; the artifact's Document/Evidence/Raw views, integrity check and honest empty "Referenced by"; the Keeper door, deterministic explanation, guide cards and clean close on every screen; the Keeper in the entrance hall at all three viewports.

Not exercised (not passes): the versions line (no agent has a second version yet), long Markdown with fenced code or wide tables (no such artifact exists), Stop on an active workflow run, the Revoke confirm, and the artifact tabs above 1280.

After the fixes: web suite 16 files / 112 passed, `tsc --noEmit` clean, `next build` succeeds.

## 8. Residuals and open items

- **Info (R1 review):** the skip reason is re-derived at conclude (`active_time_limit` if over time, otherwise `budget_headroom`); headroom checks only `subscription_tokens`, so a `usd`-routed agent does not stop early for budget (the Governor still refuses); `done: true` without `finish` does not stop the loop.
- **Keeper art:** a single Rogue frame; an animated strip is owed by the design workstream.
- **External research:** `research.search` / `research.open` are future Capabilities (provider, credentials and spend are operator decisions).
- **Spec amendments to record** (the spec file carries another workstream's uncommitted hunks, so not edited here): §3d/§11 R1 note; §8.2 `agent_loop_iteration_recorded`; §12 `execution_profile`; §15.1 screens 2, 3, 6, 8 built further.

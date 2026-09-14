# Agent Performance Projection: Closure

**Started:** 2026-09-14, after Registry writes closed.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V2 (spec Phase 19): `agent_performance` and the async projection loop.
**Authoritative write-up:** [`docs/architecture/AGENT_PERFORMANCE.md`](../architecture/AGENT_PERFORMANCE.md).

No live model invocations, no paid services. One migration (0015, the table).

## Why this was the next milestone

It is the first V2 item and fully specified (§8.8, Phase 12). Phase 19 allows it to exist and be displayed before it is statistically meaningful, and requires it before anything V4 can consume. Memory, branching and variable passing stay gated on concrete evidence (V3), and autonomy on this projection plus a criterion nobody has set.

## What changed

| Change | Where |
|---|---|
| `agent_performance` table; `avg_cost` per resource unit (spec §12 note) | `src/db/schema.ts`, `drizzle/0015_agent_performance_projection.sql` |
| Full-rebuild projector over Events, under an advisory lock | `src/projections/agentPerformance.ts` |
| In-process refresh loop, once at startup then every minute | `src/api/start.ts` |
| `GET /agents/:id` returns the rows as `performance` | `src/api/routes/agents.ts` |
| Structural firewall: only schema, projector, loop and read route may reference it | `tests/execution/structuralInvariants.test.ts` |
| Rule tests, rebuild idempotency, read API | `tests/projections/agentPerformance.test.ts` |

## Decisions made

- **Full rebuild instead of a `global_seq` watermark.** Sequence values commit out of order, so a watermark can skip events permanently. A rebuild has no such failure and is idempotent; its cost is the documented ceiling.
- **Halted Runs are not samples.** An emergency stop is an operator decision, not the agent's outcome.
- **Tier from the Router's `invocation_started.resultingTier`**, last one in the Run, because it exists even when the model call fails; `none` without a model call.
- **Cost per unit in one jsonb column** rather than a unit key column, so success rate and sample count stay single-valued per group.
- **No sample-criterion gate built.** Its form (count vs. confidence bound) is as much the decision as its value; nothing reads the projection, and the firewall test keeps it that way until the criterion exists.
- **XP not built.** §16.1's amounts and quality signal are gamification design shared with the UI workstream.
- **Not built:** average duration and approval-rejection rate (no Phase 12 columns), cost dashboard (UI).

## Adversarial review (independent, Opus)

Targets: SQL correctness against every event producer, firewall bypasses, locking and rebuild cost, the start-up loop, API and web compatibility, governance misrepresentation. No Critical findings. Checked and fine: terminal selection, budget correlation (every reservation carries a run hold; no double counting), tier source, lock keyspaces and ordering, loop overlap and error handling, migration 0015.

| Finding | Disposition |
|---|---|
| H1: the Phase 19 sample criterion was deferred while the milestone read as conformant | **Fixed in the record**: ROADMAP_STATUS marks it closed as built with the criterion open; the spec note states it is not yet conformant and why (governance decision, §6) |
| H2: governance, budget, quota, Approval-expiry and crash failures counted against the agent | **Fixed**: excluded by the Run's last `invocation_failed` reason; `approval_rejected` and unlisted reasons still count (conservative direction); tests for each |
| M1: cited docs did not exist | **Resolved**: written after the review started (`AGENT_PERFORMANCE.md`, this record, index) |
| M2: `web/lib/api.ts` still types `performance: null` | **Handed to the UI workstream**: the API change is compatible with the current page, which ignores the value |
| M3: firewall bypasses | **Partly fixed**: the string check now matches `agentPerformance`; a test fails if any other migration names the table; the rest documented as tripwire limits |
| M4: estimate-basis charges and last-tier attribution in `avg_cost` | **Documented**: a tool's charges are always estimates, so excluding them would drop tool cost entirely |
| L1: padded or truncated decimal strings | **Fixed**: `trim_scale`; test asserts `"0.5"`, `"0.03"` |
| L2: binding read from `runs`, not an event | **Documented** |
| L3: a halted Run followed by `run_failed` would count | **Fixed**: any `run_halted` excludes; test |
| L4: retries split across tiers | **Documented** (no retries exist) |
| L5: rebuild scans events without an `event_type` index | **Documented** |
| L6: a malformed event blocks every refresh | **Partly fixed**: a `budget_consumed` without `resourceUnit` is skipped; a malformed amount documented |

## Mutation checks

Each mutant was applied, `tests/projections` and the structural tests run, and the file restored byte-for-byte.

| Mutant | Result |
|---|---|
| P1 halted Runs counted | 2 fail |
| P2 first tier instead of last | 2 fail |
| P3 retries always zero | 1 fails |
| P4 cost units merged | 1 fails |
| P5 drop `agent_definition_id IS NOT NULL` | passes: equivalent, an unbound Run also has a null version, which the remaining condition excludes |
| F1 Policy names `agent_performance` | 1 fails (structural firewall) |
| P6 governance failures counted (review H2) | 1 fails |
| P7 only a last `run_halted` excludes (review L3) | 1 fails |
| P8 `approval_rejected` excluded | 1 fails |
| P9 untrimmed decimals (review L1) | 1 fails |

The existing Agent Detail integration test pinned `performance: null`; it now expects `[]` (no refresh has run there), the contract this milestone changes.

## Verification

- Backend `tsc --noEmit`: clean. Backend suite: 57 files, 723 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed. The UI was not modified.
- `git diff --check`: clean.

## Decisions required (user)

- **The minimum sample-size/confidence criterion** (form and values) before Policy or the Router may read `agent_performance` (`ROADMAP_STATUS.md` §6).
- **XP rules** (§16.1), if XP is wanted.
- Carried: `ROADMAP_STATUS.md` §6; the external search provider for `research.retrieve`.

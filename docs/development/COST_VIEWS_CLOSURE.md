# Cost/Budget Read API: Closure

**Started:** 2026-09-14, after the agent performance projection closed.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V2, spec §15.1 screen 7, API half. The dashboard UI belongs to the UI workstream.

No migration, no new events, no web changes, no live model invocations.

## Why this was the next milestone

NEXT_PHASE_PLAN §7 lets the `budget_counters` view ship without blockers and the cost-vs-success comparison once `agent_performance` exists, which it now does. Phase 20 Risk #4 names the interim state this ends: budget watched only through direct SQL.

## What changed

| Change | Where |
|---|---|
| `GET /costs?scope=`: counters (latest 500), per-(scope, unit) totals, cost-vs-success rows with names | `src/api/routes/costs.ts`, `src/api/server.ts` |
| The route joins the `agent_performance` display allowlist, the deliberate edit the firewall test describes | `tests/execution/structuralInvariants.test.ts` |
| Tests: labels, per-unit totals, scope filter, rejected scope | `tests/api/costsRoutes.test.ts` |
| Root `CLAUDE.md`: async projections and the display-only invariant | carried from the projection milestone |

## Decisions made

- **Totals are per (scope, unit); limits are never summed.** A sum of per-Run limits is not a limit, and units are never combined.
- **A `day` key is echoed, not interpreted.** Its timezone is an open decision (ROADMAP_STATUS §6).
- **Cost-vs-success is shown as measurement only.** No ranking, no "cheapest per success", nothing that reads as a recommendation before a sample criterion exists (NEXT_PHASE_PLAN §7).

## Adversarial review (independent, Opus)

No Critical or High findings. Checked and fine: no cross-unit sums, exact decimal strings, no join fan-out, no ranking or recommendation, scope validation (including arrays and case variants), the allowlist edit, no new exposure, UI type compatibility, the day key.

| Finding | Disposition |
|---|---|
| M1: the text-to-uuid label join scanned every counter and Run per request | **Fixed**: counters fetched first; labels loaded by primary key for the shown Run counters only |
| M2: the counter list was capped silently while totals were not | **Fixed**: `countersTruncated`; test with 501 counters |
| M3: no tests for the cap, the run filter's labels or a repeated scope | **Fixed**: tests added; a repeated `scope` is refused explicitly |
| L1: `limitAmount` described as always enforced | **Fixed** in the route header (day counters only while a ceiling is configured) |
| L2: `reserved` totals can include holds an interruption never released | **Documented** in the route header |
| L3: adding totals across scopes double-counts | **Documented** in the route header |
| L4: stale docs | **Fixed**: `AGENT_PERFORMANCE.md` names both read routes |
| L5: `agentVersion` here vs. other routes' field names | **Handed to the UI workstream** to settle when it types the response; not renamed now |

## Mutation checks

Each mutant was applied to `src/api/routes/costs.ts`, `tests/api/costsRoutes.test.ts` run, and the file restored byte-for-byte.

Run after the review fixes (the label join C3 was replaced by a primary-key lookup, so it no longer applies):

| Mutant | Result |
|---|---|
| C1 totals merge units | 3 fail |
| C2 totals ignore the scope filter | 2 fail |
| C4 unknown scope accepted | 1 fails |
| C5 drop the `typeof scope !== "string"` guard | passes: equivalent, an array value also fails the enum check and gets 400; the guard keeps the cast honest |
| C6 truncation never reported | 1 fails |
| C7 Run labels dropped | 2 fail |

## Verification

- Backend `tsc --noEmit`: clean. Backend suite: 58 files, 726 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed. The UI was not modified.
- `git diff --check`: clean.

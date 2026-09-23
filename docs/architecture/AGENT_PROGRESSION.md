# Agent progression (R2)

Progression is an **interpretation of recorded work**. It never grants anything: Capability Grants remain the only authority, and no governance, routing, execution, workflow or context code imports a progression module (`tests/execution/structuralInvariants.test.ts`, "progression is never authority"). Progression never enters a compiled context, so an agent cannot optimise for it.

Plan and decisions: `docs/superpowers/plans/2026-09-16-r2.0-plan.md` §11 (operator decisions D2–D4).

## Identity

Everything is keyed on the persistent agent **name**, never on an Agent Definition version or the appearance record. Strategist v1, v2 and v3 share one history; a new version resets nothing and earns nothing. A new name is a new agent with no history.

## The six things, kept apart

| Concept | What it is | Source | Mutable by |
|---|---|---|---|
| **XP** | Sum of auditable awards, one row per rule per fact (`agent_xp_awards`, each with the run/workflow/goal/artifact and evidence it rests on). | Events + the operator's verdicts | nobody: rebuilt from the record |
| **Level** | A pure function of XP. `threshold(L) = 250 × (L(L+1)/2 − 1)`: 0, 500, 1,250, 2,250, 3,500, 5,000, 6,750, 8,750 … | XP | nobody |
| **Performance** | `agent_performance` (per version, used by routing and Conditional Autonomy), shown to the operator summed across all versions of the name. | Events | nobody |
| **Quality verdict** | The operator's judgement of an artifact: POOR / ACCEPTABLE / GOOD / EXCELLENT. Not approval. | `quality_verdict_recorded` (only `POST /quality-verdicts` writes it) | the operator |
| **Endorsement** | A governed, proven signal that another agent's deliverable was useful to this agent's work. Zero XP. | completed `peer.endorse` Invocations, re-proven | an agent, through a Grant |
| **Reputation** | **Not a score.** The operator's verdicts by grade (with their count, shown as reputation only from 3 verdicts) and the distinct agents who independently endorsed this agent's work (mutual pairs shown, not counted). | verdicts + endorsements | nobody |

**Specialisation** is the domain holding ≥ 3 of the agent's successful runs and at least half of its domain work. Domains are declared by capability code (`src/capabilities/progressionFacts.ts`): real `research.*` evidence → research (fixture data is not research), `publish.report` → publishing, finishing on a verified handoff from another agent → analysis. Never from a name, role or model text.

## XP rules (`src/projections/progressionRules.ts`)

Work XP is earned only by Runs that are **performance success samples** — the one shared rule in `src/projections/runSamples.ts`: a loop that concluded `complete`; a loop stopped at its iteration/time limit is a failure; budget-headroom stops, budget and Policy refusals, operator halts and infrastructure failures are not samples at all.

| Rule | XP | Condition |
|---|---|---|
| task | 100 | per Task Instance with a success sample |
| research | +100 | that run completed a `research.*` Invocation with real (non-fixture) evidence |
| capability | 50 | per distinct Capability the success run completed; not `review.checkpoint` (approval) or `peer.endorse` |
| workflow | 250 | `workflow_run_completed`, to each agent with a success sample in it |
| mission | 500 | `goal_completed` (the Goal is the mission), to each agent with a success sample in its workflow runs |
| validated artifact | 150 | the deliverable of a run whose loop concluded `evidence_sufficient` (code-verified evidence) |
| quality verdict | 0 / 50 / 150 / 300 | the **latest** operator verdict on an artifact, to the agent whose run produced it |

These stack by design: one finished single-step mission earns task + workflow + mission (850), plus validated artifact if verified. The **difficulty / high-value bonus is not built**: no governed criterion for difficulty or value exists, and inventing one would be the self-declared difficulty D2 forbids.

Nothing else earns XP: approvals, tokens, model calls, endorsements, appearance, new versions, names, idle or ambient activity.

## Achievements (5, deterministic, earliest qualifying fact)

`first_success`, `verified_research` (finished `evidence_sufficient` with verified real research), `handoff` (finished `evidence_sufficient` on another agent's verified handoff), `validated_artifact`, `seasoned:<domain>` (5 successful runs in one domain).

## Endorsements (`src/capabilities/peerEndorse/`)

`peer.endorse` (CREATE, risk low, internal binding, loop action `{artifactId, reason}`). Before the Tool Invocation is built, the loop calls the action's `prove` hook: code checks the artifact is a deliverable, the endorsing Run's own `context_compiled` included its id **with its stored hash**, another agent name produced it, and this agent has not already endorsed it. A failed proof is refused like a missing Grant. The proven snapshot (hash, endorsing run, endorsed agent) comes from the record; `prepare` proves it again and fails closed. The projection proves it a third time from the record and marks anything unproven (`not_in_context`, `hash_mismatch`, `same_lineage`, `duplicate`, …) as excluded. Endorsements are worth zero XP, so neither self-endorsement nor loops can create progression; mutual pairs are shown and not counted as independent standing. Seeded with no holder: an operator grants it.

## Rebuild

`refreshAgentProgression` rebuilds all four tables in one transaction on the projection loop (`src/api/start.ts`), after `agent_performance`, in its own transaction. No watermark; replaying or rebuilding is idempotent, and every award's key is its primary key. After a verdict the route also rebuilds once. Like the performance projector it is not fully event-sourced: agent binding comes from `runs`, capability use from `invocations`.

## Anti-gaming (tested in `tests/projections/agentProgression.test.ts`)

Duplicate and replayed events, rebuilds, limit-stopped / budget-refused / policy-refused / halted work, a model's own claims in a deliverable, verdict-shaped events not written by a human, approvals, endorsements (self, unproven, duplicate, mutual), appearance changes, new versions and new names — none creates XP; a refresh changes no Grant, budget counter, Capability or Definition.

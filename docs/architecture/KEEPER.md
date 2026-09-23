# The Keeper (V1.1, R2 Stage 6)

The Keeper explains the Command Keep from its own records. It is **not** a general worker, has no special authority, and never fills a gap with a guess.

Plan: `docs/superpowers/plans/2026-09-16-r2.0-plan.md` §12.

## Three ways to ask

| | Model? | Writes? | Code |
|---|---|---|---|
| **Explain** — an intent answer as FACT / DERIVED / UNKNOWN | no | no (READ ONLY transaction) | `GET /keeper/explanations`, `src/keeper/explainIntent.ts` |
| **This page / How to** — the subject's general explanation and guide cards (V1.1) | no | no | `GET /keeper/explain`, `GET /keeper/guide` |
| **Think** — the same records put into words | CHEAP, governed | one ordinary Goal/Run and a `keeper_answer` artifact | `POST /keeper/questions`, `src/capabilities/keeperAnswer` |

Think is an ordinary Goal run by the ordinary Keeper Agent Definition, which holds only READ Grants (`system.inspect`, `docs.retrieve`). Policy, budgets, approvals and emergency stops apply to it like any agent.

## Intents (`src/keeper/intents.ts`)

Sixteen explicit intents, each with the subjects it can explain and its authority:

| Intent | Subjects | Authority |
|---|---|---|
| progression, level, xp ledger | agent | `agent_xp_awards`, `levelFor` |
| performance | agent | `agent_performance` (+ the Router's `invocation_started.historicalPerformance`) |
| quality verdict | artifact, agent | `quality_verdict_recorded` events by a `human:` actor |
| achievements | agent | `agent_achievements` + the rule's condition |
| specialisation | agent | `agent_domain_work` + the rule |
| endorsements | agent, artifact | `agent_endorsements` |
| run outcome, stop reason | run, workflow run, goal | `runs.status`, loop terminal event, `run_halted`, `invocation_failed` |
| evidence | artifact, run, workflow run, goal | loop terminal `evidence.verified` / `rejected`; sha256 recomputed |
| handoff | run, workflow run, goal, artifact | verified `handoff` evidence, both runs, `context_compiled` |
| policy | run, workflow run, goal, approval | `policy_evaluated`, `approval_*` events |
| budget | run, workflow run, goal, agent | `budget_consumed`, `budget_denied` (per unit, never combined) |
| model / tier | run, workflow run, goal | the Model Router's `invocation_started` |
| ambient vs real | agent, system | `runs.status`, `execution_stops`, the presentation rules |

A question is classified by keywords, most specific first; an agent named in the question (whole words, no regex built from the name, longest name first; two unrelated names = ambiguous; the Keeper's own name is ignored beside another) becomes the subject for agent intents. A question no intent matches gets a bounded answer listing what the Keeper can explain for that subject.

## The answer contract

`{ intent, subject, headline, facts[], derived[], unknown[], sources[], canExplain[], size }`

- **FACT** — what a record says; each line names its `source` and links to the run, workflow run, artifact or agent.
- **DERIVED** — what code calculates from facts (level from XP, sums, a rule applied), naming the rule.
- **UNKNOWN** — what the records do not show. Never filled in.

Bounds: 24 facts, 12 derived, 6 unknown, 400 characters per line, the newest 8 runs per workflow, the newest 24 policy records and 6 routes per run, 20 ledger awards; anything left out is said in UNKNOWN, and identical lines are counted, not repeated. Values a record holds are facts; sums and rate × samples are derived; a failed action's error text is quoted as reported, not restated. `size` is the answer's characters and estimated tokens (the Context Compiler's estimator). Measured on the dev database: 100–1,500 estimated tokens per answer.

**Never a fact:** model-written content — decisions, ledger notes, deliverable bodies, summaries, findings, Keeper answers. Evidence and completion come from the loop's code-written terminal event, not from the document's own copy. Never read: Tool Binding config, environment variables, credentials.

## Think's guard rails

`system.inspect` returns the intent answer (only what the question needs, without the UI's list of other questions) when the question maps to an intent and found records, otherwise the subject's general explanation. Measured live: a level question sent ~1,070 tokens of context and cost 2,792 subscription tokens in total (token ledger run 11). The directive tells the Keeper to restate facts and derived lines, keep unknowns unknown and add nothing. After the answer is written, code compares its numbers of three or more digits with the records' own text — headline, facts, derived lines, unknowns; never ids, hashes, sizes or the operator's question (`recordText`, `unsupportedNumbers`, thousands separators ignored); any mismatch is stored on the answer and shown to the operator as a warning. It is a tripwire, not a gate: model output stays untrusted.

## Identity

The Keeper is the persistent Agent Definition named Keeper. `GET /keeper/identity` returns it, its appearance and the intent list. The dock, panel and entrance draw it through the ordinary appearance system, standing still; without an appearance it is the Rogue (D22). It gains no Grant by being the Keeper.

## Guarantees (tests)

`tests/api/keeperExplanations.test.ts`: every intent from its authority; unknowns; ambiguous names; bounds and size; one agent's answer never contains another's records; planted model claims and a planted binding credential never appear; no table changes after every intent; a write inside the READ ONLY transaction is refused by Postgres. `tests/api/keeper.test.ts`: Think gets the curated answer, the tripwire flags an invented number, the Keeper holds READ Grants only, and no Keeper module writes, reads the environment or imports governance, routing or providers. `tests/execution/structuralInvariants.test.ts`: the explainer is the only non-projection reader of the progression tables besides their routes, and nothing that authorizes, routes or executes imports it.

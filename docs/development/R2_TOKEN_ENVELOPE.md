# R2 live-work token envelope

**Envelope (D6):** 250,000 Claude Max subscription tokens for all R2 live work. **Topped up by the operator on 2026-09-16 by 40,000, to 290,000**, to cover one fresh-day Stage 5 attempt (conservative maximum ~61,200 against 66,864 then remaining). Still a hard limit; no further automatic extension. **Daily ceiling, 2026-09-16 only:** at the operator's instruction the day counter's stored limit was raised from 200,000 to 275,000 (189,828 already used), so the attempt could run the same day. The Budget Governor enforces a day row's stored limit and never raises it, so this affects that one day; the D3 default of 200,000 still seeds every later day. The runtime has no event for a ceiling change, so this ledger is its record. A hard application-level limit, and not a claim about the account's actual entitlement. At exhaustion: stop. No automatic extension, no API billing, no other paid provider.

Every live run is recorded here before the work continues.

| # | Date | Purpose | Model / tier | Invocations | Tokens | Cumulative | Remaining | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-16 | Does the runtime honour a schema `maxLength`? (Stage 1's largest economy depends on it) | claude_subscription, CLI default | 1 | ~1,000 (est.; direct CLI call, outside the budget counters) | ~1,000 | ~249,000 | **Yes** — asked for 300 words under a 40-character cap, returned 37 characters |

| 2 | 2026-09-16 | Live proof of Claude's native web search on the subscription runtime (D1 gate) | claude-sonnet-5 + claude-haiku-4-5 (its search worker), `claude_subscription` | 1 call, 8 turns, 5 searches | **53,998** (measured from `modelUsage`) | ~54,998 | ~195,002 | **Proven.** Correct current answer (npm 2.1.273, verified independently), five real searches with source URLs, no API key, `overageStatus: rejected`, quota five-hour 0.57 → 0.58 |

| 3 | 2026-09-16 | `research.search` against the real sources: Wikipedia, Crossref, arXiv | none — HTTP only, no model call | 3 searches | **0** | ~54,998 | ~195,002 | **Real results from all three.** Wikipedia returned the retrieval-augmented-generation article with its plain-text intro; Crossref returned DOIs, authors and dates; arXiv returned papers with full abstracts. No key, no account, no spend |

| 4 | 2026-09-16 | Stage 2 runtime proof: one governed autonomous Run using both research Capabilities, ending in a deliverable | claude-haiku-4-5 (CHEAP), `claude_subscription` | 7 model calls, 4 iterations | **50,185** (measured, Run `50ca71ab`) | ~105,183 | ~144,817 | **Worked.** arXiv search → Crossref search → analysis → live web search → deliverable with six real cited sources. All four actions ALLOWed by Policy against real Grants, at propose and again pre-dispatch |

| 5 | 2026-09-16 | Decision 2 live: does a web search record its queries and sources on the Invocation? | claude-haiku-4-5 (CHEAP), `claude_subscription` | 4 model calls, 2 iterations | **42,889** (measured, Run `039b035b`) | ~148,072 | ~101,928 | **Exposed two defects instead.** The loop refused its own search over a neighbouring action's field, and tool activity was being written as an all-zero record on calls that used no tools. Both fixed |

| 6 | 2026-09-16 | Decision 2, re-run on the fixed code | claude-haiku-4-5 (CHEAP), `claude_subscription` | 3 model calls, 1 iteration | **40,524** (measured, Run `7e5c50bd`) | ~188,596 | ~61,404 | **Proven.** The Invocation records four real queries and seven source URLs; the deliverable's basis records `research.web` as external evidence. The run stopped on budget headroom after one iteration |

| 7 | 2026-09-16 | **Stage 4:** evidence-driven mission, scholarly/encyclopedic sources only (`research.web` not offered) | claude-haiku-4-5 (CHEAP), `claude_subscription` | 4 model calls, 3 of 4 iterations | **18,113** (measured, Run `13c60dc8`) | ~206,709 | ~43,291 | **Deliberate evidence-based completion.** Wikipedia search → Crossref search → finish citing both results; code verified both citations (`evidence_sufficient`, none rejected). Four Policy ALLOWs, no refusals, no failures |

| 8 | 2026-09-16 | **Stage 5:** two-agent mission — Field Researcher v2 hands one deliverable to Evidence Analyst v1 (no Grants); scholarly/encyclopedic only | claude-haiku-4-5 (CHEAP), `claude_subscription` | 4 model calls across 2 Runs | **16,427** (measured: researcher `53cb1190` 11,842; analyst `a11d3155` 4,585) | ~223,136 | ~26,864 | **Handoff, isolation and governance proven; deliberate completion NOT demonstrated.** Both Runs stopped on `budget_headroom` — not the Task Instance ceiling, but the daily ceiling (D3, 200,000/day), which today's R2 runs plus the operator's own app use had taken to 189,828. The Budget Governor stopped both loops before they could overrun it |

**Stage 5 fresh-day proof — NOT dispatched (2026-09-16, 11:30 local).** Before any live call, the like-for-like two-agent mission was sized against the envelope using the largest CHEAP calls actually recorded today per loop position (decide 5,301; analyse 7,544; write 13,563):

| | Conservative maximum | Expected (observed shapes) |
|---|---|---|
| Researcher: 3 decisions + write | 29,466 | ~18,100 |
| Analyst: 2 decisions + analysis + write | 31,709 | ~7,600–15,100 |
| **Mission** | **~61,200** | **~25,700–33,200** |
| **Envelope remaining** | 26,864 | 26,864 |

It cannot fit: the expected cost reaches or exceeds the remaining envelope, and the researcher's maximum alone exceeds it. A fresh governance day restores the D3 daily ceiling (at that moment 10,172 of 200,000 remained), not this envelope, so waiting would not change the outcome. Stopped before dispatch; the envelope was not extended.

**What run 8 shows:** the collaboration itself worked exactly as designed, live — the analyst's only compiled context was its own task state, its own termination record and the handed-off deliverable (hash `213f2174…`, matching the researcher's artifact). It never saw the researcher's raw results, decisions or ledger, and it held no Grant. But neither agent finished on evidence: both were stopped by the day's governance ceiling, not the R2 envelope. The analyst's single write read ~2,200 tokens of context against the Stage 4 writer's ~3,900, because it received a curated document rather than raw search results.

**Operator use outside this ledger.** The runtime also recorded 14,456 subscription tokens today from five Runs created by `human:operator` through the UI (three Research-and-Publish goals, two Keeper Think questions). They are not R2 live work and are not counted against this envelope, but they do count against the same day's D3 ceiling — which is why that ceiling, not the envelope, ended run 8.

**What run 7 shows:** for the first time in R2 a loop ended because its criteria were met, not at a ceiling — one iteration early, with its evidence claim checked by code. Against the baselines: V1.1's dogfood spent 42,076 to stop on budget headroom; Stage 2's research run spent 50,185 to stop at its iteration limit (about 35,000 of it without the web search). This mission spent **18,113** to finish deliberately. The scholarly searches themselves cost no tokens; the whole cost is the three decisions (9,685) and the final write (8,428).

**What run 6 shows, including the uncomfortable part:** the governance and provenance work — the search is visible, attributable and recorded as evidence. But the answer itself was **wrong in detail**: it reported version 2.1.271 where the registry actually held 2.1.273. Web search returns titles and URLs, not page contents, so an exact version number is not reliably recoverable from it. That is a limit of the capability, and a deliverable resting on it should be read as "these sources were consulted", not "this number is verified". One CHEAP search cost 34,998 tokens of the run's 40,524 — two thirds of a Task Instance's whole ceiling for one question.

**What run 5 shows:** the value of running it rather than trusting the tests. A mocked suite could not have found either defect: one needed two registered actions with different input fields, the other needed a real provider report. It also cost 34,581 tokens for a single CHEAP web search — more than twice run 4's — so live-web cost varies widely and must be bounded per step, not estimated once.

**What run 4 shows:** a live web search inside a CHEAP call cost **15,098 tokens** — a quarter of the 54,000 the standalone proof cost at MID, because the model is cheaper and the search was bounded to one query. The two scholarly searches cost nothing beyond the reasoning around them. The run ended at its 4-iteration ceiling rather than by deciding it was finished.

**What run 3 shows:** the scholarly and encyclopedic half of R2 research costs nothing to run and nothing to prove. That is the argument for preferring it, and for keeping live web search a separate, deliberately granted Capability.

**What run 2 costs us to know:** web search charges its results as input tokens, so one question cost more than an entire autonomous Run's 50,000-token ceiling. Bounded use only.

**Note on estimates.** A direct adapter or CLI call touches no budget counter, exactly as in V1.1, so its cost is estimated from the prompt and reply. Runs that go through the runtime carry exact `subscription_tokens` from their Run's budget counter, and are recorded as measured rather than estimated.

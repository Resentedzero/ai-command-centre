# R2 live-work token envelope

**Envelope (D6):** 250,000 Claude Max subscription tokens for all R2 live work. A hard application-level limit, and not a claim about the account's actual entitlement. At exhaustion: stop. No automatic extension, no API billing, no other paid provider.

Every live run is recorded here before the work continues.

| # | Date | Purpose | Model / tier | Invocations | Tokens | Cumulative | Remaining | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-16 | Does the runtime honour a schema `maxLength`? (Stage 1's largest economy depends on it) | claude_subscription, CLI default | 1 | ~1,000 (est.; direct CLI call, outside the budget counters) | ~1,000 | ~249,000 | **Yes** — asked for 300 words under a 40-character cap, returned 37 characters |

| 2 | 2026-09-16 | Live proof of Claude's native web search on the subscription runtime (D1 gate) | claude-sonnet-5 + claude-haiku-4-5 (its search worker), `claude_subscription` | 1 call, 8 turns, 5 searches | **53,998** (measured from `modelUsage`) | ~54,998 | ~195,002 | **Proven.** Correct current answer (npm 2.1.273, verified independently), five real searches with source URLs, no API key, `overageStatus: rejected`, quota five-hour 0.57 → 0.58 |

| 3 | 2026-09-16 | `research.search` against the real sources: Wikipedia, Crossref, arXiv | none — HTTP only, no model call | 3 searches | **0** | ~54,998 | ~195,002 | **Real results from all three.** Wikipedia returned the retrieval-augmented-generation article with its plain-text intro; Crossref returned DOIs, authors and dates; arXiv returned papers with full abstracts. No key, no account, no spend |

**What run 3 shows:** the scholarly and encyclopedic half of R2 research costs nothing to run and nothing to prove. That is the argument for preferring it, and for keeping live web search a separate, deliberately granted Capability.

**What run 2 costs us to know:** web search charges its results as input tokens, so one question cost more than an entire autonomous Run's 50,000-token ceiling. Bounded use only.

**Note on estimates.** A direct adapter or CLI call touches no budget counter, exactly as in V1.1, so its cost is estimated from the prompt and reply. Runs that go through the runtime carry exact `subscription_tokens` from their Run's budget counter, and are recorded as measured rather than estimated.

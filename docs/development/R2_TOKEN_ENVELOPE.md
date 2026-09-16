# R2 live-work token envelope

**Envelope (D6):** 250,000 Claude Max subscription tokens for all R2 live work. A hard application-level limit, and not a claim about the account's actual entitlement. At exhaustion: stop. No automatic extension, no API billing, no other paid provider.

Every live run is recorded here before the work continues.

| # | Date | Purpose | Model / tier | Invocations | Tokens | Cumulative | Remaining | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-16 | Does the runtime honour a schema `maxLength`? (Stage 1's largest economy depends on it) | claude_subscription, CLI default | 1 | ~1,000 (est.; direct CLI call, outside the budget counters) | ~1,000 | ~249,000 | **Yes** — asked for 300 words under a 40-character cap, returned 37 characters |

**Note on estimates.** A direct adapter or CLI call touches no budget counter, exactly as in V1.1, so its cost is estimated from the prompt and reply. Runs that go through the runtime carry exact `subscription_tokens` from their Run's budget counter, and are recorded as measured rather than estimated.

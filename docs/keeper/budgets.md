# Budgets and cost

Keywords: budget, cost, tokens, subscription tokens, usd, quota, limit, ceiling, denied, headroom

Every model call reserves its worst-case cost before it runs and settles its actual usage afterwards. Units are never mixed: `subscription_tokens` (Claude subscription) and `usd` are separate counters.

Counters that apply to each call:

- the **run** counter,
- the **task instance** counter, shared by all attempts (50,000 subscription tokens),
- the **day** counter (200,000 subscription tokens, 5.00 usd).

If a reservation does not fit, the Budget Governor may try once at a lower tier with a smaller context, and otherwise refuses. Nothing overrides a ceiling. An autonomous agent stops early and writes its deliverable when too little is left for another iteration.

The **Costs** screen shows every counter.

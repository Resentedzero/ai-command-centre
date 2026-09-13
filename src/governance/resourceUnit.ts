/**
 * `ResourceUnit` — the accounting dimension a budget counter, reservation, and
 * usage record are denominated in (Phase 12 as amended 2026-09-13; the
 * concrete implementation of Phase 5.0's "Money/**quota**" pair).
 *
 * These are INCOMMENSURABLE. A `usd` amount and a `subscription_tokens` amount
 * must never be summed, compared, or substituted for one another, and no code
 * may convert between them — there is no honest exchange rate, which is
 * precisely why the dimension exists rather than a single blended number.
 *
 * - `usd`                  — metered, billable spend (Anthropic/OpenAI API).
 * - `subscription_tokens`  — tokens drawn from a flat Claude subscription
 *                            entitlement. Real consumption of a finite
 *                            resource; NOT "free", and never recorded as $0.
 * - `local_tokens`         — future local inference. Zero marginal cost but
 *                            still finite (time, VRAM, contention), so it is
 *                            counted rather than ignored.
 *
 * This module is a pure vocabulary type, exactly like `./costClass.ts`. It
 * knows nothing about Policy, providers, or pricing.
 */
export type ResourceUnit = "usd" | "subscription_tokens" | "local_tokens";

export const RESOURCE_UNITS: readonly ResourceUnit[] = ["usd", "subscription_tokens", "local_tokens"];

export function isResourceUnit(value: unknown): value is ResourceUnit {
  return typeof value === "string" && (RESOURCE_UNITS as readonly string[]).includes(value);
}

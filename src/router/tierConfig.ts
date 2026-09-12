/**
 * `tierConfig` — Phase 10's tier-to-model mapping. Explicitly a V1
 * implementation detail (a swappable static config), NOT an architectural
 * commitment: the interfaces in `./types.ts` and the functions in
 * `./modelRouter.ts` are what's actually load-bearing. Swapping any value
 * here (a model id, a provider, a price) changes routing behavior with zero
 * code changes elsewhere — that's the whole point of pulling it out of
 * `modelRouter.ts`, and `tests/router/modelRouter.test.ts` asserts this
 * directly rather than just documenting it.
 *
 * Model ids below are illustrative placeholders (current-generation-looking
 * names), not a verified product decision — picking real production model
 * ids is out of this unit's scope. `pricePerToken` is a flat, blended
 * per-token placeholder (input+output priced identically) used only for
 * `authorizeRoute`'s Pass-1 heuristic estimate and `callModel`'s Pass-3
 * reconciliation of *actual* usage — not a claim about real provider
 * pricing, which varies by input/output token and by model.
 *
 * Deliberately NOT frozen (no `Object.freeze`, no `as const` on the object
 * literal): tests mutate entries in place to prove routing is config-driven,
 * then restore the original values.
 */
import type { ModelTier } from "./types.js";

export type ProviderName = "anthropic" | "openai";

export type TierConfigEntry = {
  provider: ProviderName;
  modelId: string;
  pricePerToken: number;
};

export const tierConfig: Record<ModelTier, TierConfigEntry> = {
  CHEAP: {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    pricePerToken: 0.000001,
  },
  STRONG: {
    provider: "anthropic",
    modelId: "claude-opus-5",
    pricePerToken: 0.000015,
  },
};

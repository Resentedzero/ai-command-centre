/**
 * Provider candidate configuration — Phase 10's tier-to-model mapping,
 * generalized in Phase 7D into a declarative CANDIDATE LIST.
 *
 * This file is the single place routing behaviour is configured. Adding a
 * future provider (a local model, OpenAI, a second subscription) means adding
 * one entry below — the Model Router reads this list and contains no
 * provider-specific branch of any kind.
 *
 * ORDER IS PRIORITY. The array's declared order is the routing order, and there
 * is deliberately no separate numeric `priority` field: two representations of
 * the same fact drift apart, and a priority number that disagrees with the
 * array index is a bug nobody notices. To re-rank, move the entry.
 *
 * THE LADDER (Phase 7H): CHEAP -> Haiku, MID -> Sonnet, STRONG -> Opus, all on
 * Claude Max and all accounted in `subscription_tokens`. A tier is a model
 * QUALITY FLOOR; it is not a price band, and it represents no particular share
 * of Max entitlement — the per-run subscription ceiling is a single shared
 * budget, not a per-tier or per-model allocation.
 *
 * Model ids and prices are VERIFIED against Anthropic's official pricing and
 * model-overview documentation (checked 2026-09-13), not placeholders.
 *
 * Both ids are deliberately PINNED SNAPSHOTS, not floating aliases, because
 * `modelId` is recorded on immutable Events and reconciled against a
 * per-model price — a floating alias would make the event log non-reproducible
 * once it re-points:
 *   - Haiku 4.5 predates the 4.6 generation, so its Claude API ID is the dated
 *     `claude-haiku-4-5-20251001`; the bare `claude-haiku-4-5` is the ALIAS.
 *     Do not "normalize" this to the short form.
 *   - From the 4.6 generation on, dateless ids ARE their own pinned snapshot,
 *     so `claude-sonnet-5` and `claude-opus-5` are already correct as written.
 *
 * `pricing` is split into `inputPerToken`/`outputPerToken` because real pricing
 * is asymmetric — output is 5x input on both models here.
 *
 * Deliberately NOT frozen: tests mutate entries in place to prove routing is
 * config-driven, then restore the original values.
 */
import { MODEL_TIERS, type ModelTier, type TierAccounting } from "./types.js";

/**
 * A future provider (a local model accounted in `local_tokens`, say) is added
 * by adding its name HERE and its adapter to the Router's dispatch map in the
 * same change — the map is total, so the compiler refuses a name with no
 * adapter. That is the extensibility guarantee: the router needs no edit beyond
 * registering the adapter, and a half-added provider cannot compile.
 *
 * `"local"` is deliberately NOT listed. Naming it without an adapter would
 * either break the build or force a stub that could be dispatched to by
 * accident; Phase 7D implements no local provider.
 */
export type ProviderName = "anthropic" | "openai" | "claude_subscription";

/**
 * A capability a candidate must support to serve an invocation that needs it.
 * Deliberately a small, closed vocabulary rather than free-form strings: every
 * value here has to be true of a real adapter, and an unrecognized requirement
 * would silently match nothing.
 */
export type CandidateCapability = "structured_output";

/**
 * One declaratively configured routing candidate.
 *
 * Data only — no execution logic, no functions, no credentials. Credentials
 * live exclusively inside the adapter for `provider`; nothing in this structure
 * ever carries a key, and routing results are built from these fields, so a key
 * cannot leak into an event or the UI through routing.
 */
export type ProviderCandidate = {
  provider: ProviderName;
  modelId: string;
  /** Which tiers this candidate may serve. */
  tiers: ModelTier[];
  /**
   * The resource unit and, for metered providers, the price. This is what keeps
   * `anthropic`+`usd` and `claude_subscription`+`subscription_tokens` distinct
   * accounting dimensions rather than two spellings of the same thing.
   */
  accounting: TierAccounting;
  capabilities: CandidateCapability[];
  /**
   * The model's context window in tokens (spec §5.17, §10.7 Pass 2): the Router caps
   * a Task's input budget to it, less the expected output. VERIFIED against
   * Anthropic's models overview (platform.claude.com/docs/en/about-claude/models/overview,
   * checked 2026-09-14): Haiku 4.5 200K, Sonnet 5 and Opus 5 1M. It is the MODEL's
   * window; a `claude_subscription` call also carries the Claude CLI's own system
   * prompt, so its effective window is somewhat smaller (not measured). No seeded
   * budget comes near either.
   */
  contextWindowTokens: number;
  /** A disabled candidate is never eligible, for any tier, for any reason. */
  enabled: boolean;
};

/**
 * THE CANDIDATE LIST — declared order is routing order.
 *
 * PRODUCTION DEFAULT AS OF PHASE 7F (2026-09-13): subscription-backed Claude
 * (Claude Max) is the PRIMARY runtime provider for EVERY tier, accounted in
 * `subscription_tokens`. It was validated across Phases 7A-7E before this
 * switch: stream-json transport and usage extraction (7B), quota observation
 * and projection (7A), the advisory guardrail (7C), candidate routing (7D), and
 * an end-to-end governance-chain run plus a live readiness check (7E).
 *
 * The Anthropic API candidates remain CONFIGURED and ENABLED, deliberately
 * ranked BELOW the subscription ones. Being listed is not being a fallback:
 * `authorizeRoute` takes the first eligible candidate and stops, so a
 * subscription failure fails the invocation rather than quietly re-running it
 * against a billable provider. Automatic fallback would require an explicit
 * Policy/Budget decision and is not implemented (amended Phase 10.6.7).
 *
 * Ordering is the whole mechanism. To return the API to primary for CHEAP or
 * STRONG, move its entries above the subscription ones — no code changes
 * anywhere.
 *
 * MID IS THE EXCEPTION, deliberately: it has NO `anthropic` alternative,
 * because this repository has no VERIFIED USD price for Sonnet 5 and inventing
 * a rate would put fabricated money into `budget_counters`. So MID is
 * Max-only today, and disabling or demoting the subscription candidates would
 * leave MID unservable — `validateProviderCandidates` reports exactly that, and
 * `primaryCandidateFor` throws rather than silently routing MID elsewhere.
 * Adding a priced `anthropic` MID candidate is a deliberate follow-up that
 * needs a real published rate, not a guess.
 */
export const providerCandidates: ProviderCandidate[] = [
  // PRIMARY — subscription-backed Claude. Accounted in subscription_tokens:
  // never in dollars, and never at a fabricated $0.
  {
    provider: "claude_subscription",
    modelId: "claude-haiku-4-5-20251001",
    tiers: ["CHEAP"],
    accounting: { unit: "subscription_tokens" },
    capabilities: ["structured_output"],
    contextWindowTokens: 200_000,
    enabled: true,
  },
  {
    provider: "claude_subscription",
    modelId: "claude-sonnet-5",
    tiers: ["MID"],
    accounting: { unit: "subscription_tokens" },
    capabilities: ["structured_output"],
    contextWindowTokens: 1_000_000,
    enabled: true,
  },
  {
    provider: "claude_subscription",
    modelId: "claude-opus-5",
    tiers: ["STRONG"],
    accounting: { unit: "subscription_tokens" },
    capabilities: ["structured_output"],
    contextWindowTokens: 1_000_000,
    enabled: true,
  },
  // CONFIGURED ALTERNATIVES, not fallbacks. Reachable only by re-ordering this
  // list or by disabling the candidates above — never automatically.
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    tiers: ["CHEAP"],
    accounting: { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } },
    capabilities: ["structured_output"],
    contextWindowTokens: 200_000,
    enabled: true,
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-5",
    tiers: ["STRONG"],
    accounting: { unit: "usd", pricing: { inputPerToken: 0.000005, outputPerToken: 0.000025 } },
    capabilities: ["structured_output"],
    contextWindowTokens: 1_000_000,
    enabled: true,
  },
];

export type TierConfigEntry = {
  provider: ProviderName;
  modelId: string;
  accounting: TierAccounting;
};

/**
 * The primary (first enabled) candidate per tier, DERIVED from the list above
 * rather than declared separately.
 *
 * Kept because `estimateCost` and existing callers read it, and because
 * deriving it makes "Phase 7D changed no default" mechanically true instead of
 * merely asserted: if the list's ordering or enablement changed, this would
 * change with it and the frozen-defaults test would fail.
 */
function primaryCandidateFor(tier: ModelTier): TierConfigEntry {
  const candidate = providerCandidates.find((c) => c.enabled && c.tiers.includes(tier));
  if (!candidate) {
    throw new Error(
      `tierConfig: no enabled provider candidate is configured for tier "${tier}".` +
        " Every tier must have at least one enabled candidate."
    );
  }
  return { provider: candidate.provider, modelId: candidate.modelId, accounting: candidate.accounting };
}

export const tierConfig: Record<ModelTier, TierConfigEntry> = {
  CHEAP: primaryCandidateFor("CHEAP"),
  MID: primaryCandidateFor("MID"),
  STRONG: primaryCandidateFor("STRONG"),
};

/**
 * Rejects a structurally invalid candidate list loudly. A malformed entry would
 * otherwise surface as a mysterious routing failure at dispatch time, long
 * after the configuration mistake.
 */
export function validateProviderCandidates(candidates: ProviderCandidate[] = providerCandidates): void {
  for (const [index, candidate] of candidates.entries()) {
    const where = `providerCandidates[${index}] (${candidate.provider}/${candidate.modelId})`;

    if (!candidate.modelId || candidate.modelId.trim() === "") {
      throw new Error(`${where}: modelId must be a non-empty pinned model id.`);
    }
    if (candidate.tiers.length === 0) {
      throw new Error(`${where}: must declare at least one tier, or it can never be routed to.`);
    }
    if (new Set(candidate.tiers).size !== candidate.tiers.length) {
      throw new Error(`${where}: declares the same tier more than once.`);
    }
    if (!Number.isInteger(candidate.contextWindowTokens) || candidate.contextWindowTokens < 1) {
      throw new Error(`${where}: contextWindowTokens must be a positive integer (the model's verified window).`);
    }
    if (candidate.accounting.unit === "usd") {
      const { inputPerToken, outputPerToken } = candidate.accounting.pricing;
      for (const [name, rate] of [
        ["inputPerToken", inputPerToken],
        ["outputPerToken", outputPerToken],
      ] as const) {
        // A zero or negative rate on a METERED provider would silently make
        // billable work look free to the Budget Governor.
        if (!Number.isFinite(rate) || rate <= 0) {
          throw new Error(`${where}: ${name} must be a finite positive rate for a usd-accounted candidate.`);
        }
      }
    }
  }

  // Aggregate invariant, checked last: every tier must be servable. Without it,
  // adding a tier to `ModelTier` and forgetting its candidate would surface as a
  // module-load throw from `primaryCandidateFor` in whichever file happened to
  // import this first — an obscure failure far from the actual mistake.
  for (const tier of MODEL_TIERS) {
    if (!candidates.some((c) => c.enabled && c.tiers.includes(tier))) {
      throw new Error(
        `providerCandidates: tier "${tier}" has no enabled candidate, so nothing can ever serve it.`
      );
    }
  }
}

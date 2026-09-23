/**
 * USAGE ACCOUNTING — what the provider actually measured, category by category.
 *
 * WHY THIS EXISTS. `ProviderUsage` carries four numbers (`tokensIn`, `tokensOut`, `costAmount`,
 * `cacheHit`) and `events` has four matching columns. That is enough to charge a budget and not much
 * else: a per-model breakdown the adapter had computed was dropped at persistence, cache-read tokens
 * the provider really reported were collapsed into a boolean, and nothing recorded which categories the
 * provider had simply never mentioned. The result was a record that could not tell "the provider said
 * zero" from "the provider said nothing" — and one measured consequence: `events.tokens_in` on some
 * models reads 2–4 tokens, because cached input is reported in a field nobody read.
 *
 * This module defines the record that fixes that. It changes NO cost semantics: `costAmount`,
 * `costUnit`, budget reservation and reconciliation, resource-unit separation and the Model Router's
 * tier preference are all untouched. It only writes down, in the `invocation_completed` payload
 * (jsonb, no migration), what was measured and what was not.
 *
 * THE RULES, IN ORDER OF IMPORTANCE
 *
 *   1. MISSING IS NOT ZERO. Every category is `number | null`. `null` means the provider did not
 *      report it. A category is additionally NAMED in `unknown[]`, so a reader never has to infer
 *      absence from a null it might not have checked.
 *   2. NOTHING IS INFERRED. Thinking usage is never derived from output tokens; cache usage is never
 *      derived from prompt length; secondary usage is never derived by subtraction. A number appears
 *      here only because a provider field held it.
 *   3. NO INVENTED EQUATION. `unattributed` is populated ONLY when the provider itself reported a
 *      total that the per-category values can be compared against. No provider here does, so it is
 *      null everywhere today — see `UNATTRIBUTED_NOT_DERIVABLE`.
 *   4. CACHE SEMANTICS DIFFER BY PROVIDER, so the relationship is recorded rather than assumed.
 *      Anthropic reports `cache_read_input_tokens` SEPARATELY from `input_tokens`; OpenAI reports
 *      `prompt_tokens_details.cached_tokens` as a SUBSET of `prompt_tokens`. Flattening those into one
 *      "cache read" number would make the two silently non-comparable, so `cacheReadIncludedInInput`
 *      says which it is — and is itself null when we do not know.
 *   5. THIS IS TELEMETRY, NEVER AUTHORITY. Every value originates in an adapter reading a provider
 *      response. `buildUsageAccounting` is called ONLY from the three files in `./providers/` — the
 *      only code that ever holds one — and a structural invariant in
 *      `tests/execution/structuralInvariants.test.ts` fails if anything else calls it, so a value that
 *      reads as provider-measured cannot be manufactured from model output.
 */

/** A category name that can appear in `unknown[]`. Fixed, so a typo cannot invent a category. */
export const USAGE_CATEGORIES = [
  "primary.input",
  "primary.output",
  "secondary",
  "cache.read",
  "cache.creation",
  "cache.readIncludedInInput",
  "thinking",
  "thinking.includedInOutput",
  "primary.providerPrimaryOnly",
  "unattributed",
] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/**
 * How the primary model entry was identified. A provider that returns a per-model map does not
 * necessarily say WHICH entry answered the request, so the basis for calling one "primary" is itself
 * a fact worth recording: `matched` means an entry's model id equalled the one we routed to,
 * `assumed_only_entry` means there was exactly one, and `assumed_first` means we routed to a model the
 * provider did not name and fell back to the first entry. `sole_reported` means the provider reported
 * exactly one entry and it was the model we asked for — note that this is PRECISELY the case in which the
 * Claude CLI may have merged an internal secondary call into that entry, so a `sole_reported` primary is
 * not evidence that only the primary ran; `mergedWithSecondary` is what answers that. Only `matched` and
 * `sole_reported` rest on the provider naming the model; the two `assumed_` values are our inference, and
 * are labelled so nobody reads them as measurements.
 */
export type PrimaryBasis = "matched" | "assumed_only_entry" | "assumed_first" | "sole_reported";

export type UsageAccounting = {
  /** Always `provider_reported`: every number here came from a provider response, never an estimate. */
  basis: "provider_reported";
  primary: {
    modelId: string;
    identified: PrimaryBasis;
    input: number | null;
    output: number | null;
    /**
     * The provider's OWN primary-only view, when it publishes one separately from the per-model
     * breakdown. The Claude CLI does: its top-level `usage` object described the primary model alone in
     * all 16 recorded captures (`benchmark/raw/phase2-results.json`), while `modelUsage` can MERGE the
     * primary with an internal secondary call when both ran on the same model. Recorded beside
     * `input`/`output` rather than replacing them, because the CLI documents no such guarantee — this
     * is a consistent observation, not a published contract.
     */
    providerPrimaryOnly: { input: number | null; output: number | null } | null;
    /**
     * Whether the entry credited to the primary demonstrably contains more than the primary: true when
     * the provider's own primary-only view disagrees with it. `null` when there is no second view to
     * compare against, so nothing is claimed either way.
     */
    mergedWithSecondary: boolean | null;
  };
  /**
   * Non-primary model entries the provider reported. `null` means the provider gives no per-model
   * breakdown at all (so we cannot know whether secondary work happened); `[]` means it does give one
   * and reported no other model.
   */
  secondary: Array<{ modelId: string; input: number | null; output: number | null }> | null;
  cache: { read: number | null; creation: number | null; cacheReadIncludedInInput: boolean | null };
  thinking: number | null;
  /**
   * Whether `thinking` is already counted inside `primary.output`. Decisive for the Claude CLI and
   * evidenced rather than assumed: its own footprint figure sums input + output + cache only
   * (`D_totalReportedFootprint` = 1170 + 981 + 7568 + 0 in capture 1) and never adds thinking, while
   * the top-level view reports `output_tokens: 967` with `thinking_tokens: 566` inside it. Adding
   * thinking to output would therefore double-count it. `null` when unevidenced.
   */
  thinkingIncludedInOutput: boolean | null;
  /** Provider-reported usage that cannot be assigned to a category above. See rule 3. */
  unattributed: number | null;
  /** Every category the provider did not report. Named explicitly so absence is never inferred. */
  unknown: UsageCategory[];
  /** What `costAmount` was derived from, in words, so the counted figure is never mistaken for a total. */
  counted: { amount: number; unit: string; rule: string };
};

/**
 * Why `unattributed` is null for every provider the Keep talks to.
 *
 * Attributing a residual needs a provider-reported TOTAL to subtract the categories from. The Claude
 * CLI reports a per-model map and no total — the total the Keep charges is one IT computes by summing
 * the entries, so subtracting those same entries from it is guaranteed to yield zero and would say
 * nothing. Anthropic and OpenAI report one model's counts and no total either. Writing a residual here
 * would therefore be an equation whose terms no provider guarantees are additive, which rule 3 forbids.
 */
export const UNATTRIBUTED_NOT_DERIVABLE =
  "no provider reports a total independent of the per-category values, so a residual would be arithmetic, not a measurement";

/** A finite number as reported, or null. Never coerces, never defaults — see rule 1. */
export function reported(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type BuildInput = {
  primary: {
    modelId: string;
    identified: PrimaryBasis;
    input: number | null;
    output: number | null;
    providerPrimaryOnly?: { input: number | null; output: number | null } | null;
    mergedWithSecondary?: boolean | null;
  };
  secondary?: Array<{ modelId: string; input: number | null; output: number | null }> | null;
  cache?: { read?: number | null; creation?: number | null; cacheReadIncludedInInput?: boolean | null };
  thinking?: number | null;
  thinkingIncludedInOutput?: boolean | null;
  counted: { amount: number; unit: string; rule: string };
};

/**
 * Assembles the record and derives `unknown[]` from what is actually null, so the list can never drift
 * out of step with the values it describes. `unattributed` is always null here by construction: a
 * caller cannot pass one, because no provider supplies the total that would justify it.
 */
export function buildUsageAccounting(input: BuildInput): UsageAccounting {
  const cache = {
    read: input.cache?.read ?? null,
    creation: input.cache?.creation ?? null,
    cacheReadIncludedInInput: input.cache?.cacheReadIncludedInInput ?? null,
  };
  const secondary = input.secondary ?? null;
  const thinking = input.thinking ?? null;
  const thinkingIncludedInOutput = input.thinkingIncludedInOutput ?? null;
  const primary = {
    modelId: input.primary.modelId,
    identified: input.primary.identified,
    input: input.primary.input,
    output: input.primary.output,
    providerPrimaryOnly: input.primary.providerPrimaryOnly ?? null,
    mergedWithSecondary: input.primary.mergedWithSecondary ?? null,
  };

  const unknown: UsageCategory[] = [];
  if (primary.input === null) unknown.push("primary.input");
  if (primary.output === null) unknown.push("primary.output");
  if (primary.providerPrimaryOnly === null) unknown.push("primary.providerPrimaryOnly");
  if (secondary === null) unknown.push("secondary");
  if (cache.read === null) unknown.push("cache.read");
  if (cache.creation === null) unknown.push("cache.creation");
  if (cache.cacheReadIncludedInInput === null) unknown.push("cache.readIncludedInInput");
  if (thinking === null) unknown.push("thinking");
  if (thinkingIncludedInOutput === null) unknown.push("thinking.includedInOutput");
  // Always: see UNATTRIBUTED_NOT_DERIVABLE.
  unknown.push("unattributed");

  return { basis: "provider_reported", primary, secondary, cache, thinking, thinkingIncludedInOutput, unattributed: null, unknown, counted: input.counted };
}

/** Whether the provider reported this category at all. The one way a reader should ask. */
export function measured(accounting: UsageAccounting, category: UsageCategory): boolean {
  return !accounting.unknown.includes(category);
}

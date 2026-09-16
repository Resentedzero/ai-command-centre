/**
 * `callAnthropicModel` — the thin Anthropic-SDK wrapper (Phase 13.4/13.5's
 * already-approved provider stack). Per the Unit 5 brief, this file (and
 * `./openai.ts`) are the ONLY files in the codebase permitted to import a
 * provider SDK — `modelRouter.ts` never imports `@anthropic-ai/sdk` directly,
 * it only calls this function, selected via `tierConfig.ts`'s `provider`
 * field for the chosen tier.
 *
 * No test in this codebase calls this function against the real API:
 * `ANTHROPIC_API_KEY` is never set in the test environment (by design — see
 * the brief), and `tests/router/modelRouter.test.ts` mocks this entire
 * module via `vi.mock`. The API key is read from `process.env` only at call
 * time inside `callAnthropicModel` and is never logged, echoed into an
 * error message, or otherwise surfaced — a missing key throws a message that
 * names the *variable*, never its (absent) value.
 *
 * Signature deviation from the brief's illustrative example (explicitly
 * "your call" per the brief): a fourth parameter, `pricing`, is added so this
 * function can compute `usage.costAmount` from *actual* reported tokens using
 * the SAME per-token rates `authorizeRoute`'s Pass-1 estimate used
 * (`tierConfig[tier].pricing`) — keeping Pass-1's estimate and Pass-3's
 * reconciliation consistent, per one cost model, rather than inventing a
 * second one here or having this file reach into `tierConfig.ts` itself
 * (which would blur "provider wrapper" and "V1 config" responsibilities).
 * `modelRouter.ts`'s `dispatchModelCall` passes the route's pricing
 * through. Input and output are priced at SEPARATE rates (`TierPricing`,
 * imported from `../types.js` — a config-free type, so the "provider wrapper
 * never names tierConfig" rule is preserved): output costs ~5x input on the
 * real models, so a single blended rate would under-report output-heavy
 * invocations into `budget_counters.consumed_amount`.
 *
 * Fix round 1 (independent review, Important #2): prompt assembly
 * (`buildSystemPrompt`/`buildUserMessage`) is imported from
 * `./promptBuilder.ts`, shared with `./openai.ts`, rather than duplicated
 * here (the two implementations were previously byte-for-byte identical
 * with nothing coupling them). `promptBuilder.ts` imports no provider SDK,
 * so this does not affect the "only anthropic.ts/openai.ts import a
 * provider SDK" isolation rule — that rule is about SDK imports
 * specifically, not about banning a shared, SDK-free helper.
 *
 * Anthropic-provider spike (this unit): `assertReportedTokenCount` below is
 * the ONLY behavioral change. Everything else in this file was already
 * verified against the spike's constraints and left untouched. The gap it
 * closes is narrow but is a governance BYPASS, not a cosmetic one:
 *
 *   A response whose `usage` is missing ENTIRELY already failed safely —
 *   the property access throws, and the Executor settles the reservation
 *   (charged at its estimate: consumption unknown — DURABLE_EXECUTION §4.1)
 *   and emits `invocation_failed`. But a PARTIAL `usage`
 *   (e.g. `{input_tokens: 5}` with no `output_tokens`) did not throw: it
 *   RESOLVED, with `tokensOut === undefined` and
 *   `costAmount = (5 + undefined) * price === NaN`. No `invocation_failed`
 *   is emitted on that path at all, and `reconcileBudget` then writes
 *   `String(NaN)` -> `'NaN'::numeric` into `budget_counters.consumed_amount`
 *   — a value Postgres accepts. From that point on `reserveBudget`'s
 *   `available = limit - reserved - consumed` is NaN, every
 *   `estimatedAmount > available` comparison is false, and EVERY subsequent
 *   reservation against that scope is authorized. The Budget Governor is
 *   permanently neutered for that run, while still emitting events that
 *   assert it ran.
 *
 * The guard therefore validates the RAW reported fields (not the derived
 * cost — `{input_tokens: "5", output_tokens: 3}` would yield the finite but
 * wrong `"53" * price`), and fails closed into the SAME path the absent-
 * `usage` case already took. It invents no usage numbers, adds no lifecycle
 * state, and touches neither the event schema nor budget semantics.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CompiledContext } from "../../context/types.js";
import type { ProviderCallResult, TierAccounting, TierPricing } from "../types.js";
import { buildSystemPrompt, buildUserMessage } from "./promptBuilder.js";

export type { ProviderCallResult, ProviderUsage } from "../types.js";

/**
 * Fails closed if this adapter is handed a non-monetary accounting descriptor.
 * A misconfigured tier pointing `subscription_tokens` at the billable API
 * adapter would otherwise spend real money while reconciling against a token
 * counter — wrong on both sides of the ledger, and silent.
 */
function assertUsdAccounting(accounting: TierAccounting, modelId: string): TierPricing {
  if (accounting.unit !== "usd") {
    // `consumption: "none"`: refused before any request is sent (see
    // `providerConsumptionFrom` in ../types.ts).
    throw Object.assign(
      new Error(
        `callAnthropicModel: tier for model "${modelId}" is configured with accounting unit` +
          ` "${accounting.unit}", but this adapter bills real money and can only account in "usd".`
      ),
      { consumption: "none" as const }
    );
  }
  return accounting.pricing;
}

/**
 * Fails closed unless the provider actually reported this token count as a
 * finite number. Deliberately NOT a coercion or a `?? 0` default: a
 * fabricated or zeroed token count would be silently wrong usage data on an
 * immutable Event and a silently wrong `consumed_amount` — see the module
 * header for why the NaN case in particular is a budget bypass.
 */
function assertReportedTokenCount(value: unknown, field: string, modelId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `callAnthropicModel: the Anthropic API response for model "${modelId}" did not report a finite` +
        ` numeric usage.${field} (received ${typeof value === "number" ? value : typeof value}).` +
        " Refusing to reconcile budget or record usage from an unusable response."
    );
  }
  return value;
}

export async function callAnthropicModel(
  modelId: string,
  compiledContext: CompiledContext,
  // The shape reaches the model through the Compiler's invocation-instruction layer.
  _expectedOutputShape: Record<string, unknown>,
  accounting: TierAccounting,
  options?: { tools?: readonly string[] }
): Promise<ProviderCallResult> {
  // R2: this adapter implements no provider-side tools. Running the call without the tools
  // it was authorized to use would silently answer from model knowledge alone — the exact
  // dishonesty the evidence basis exists to prevent. Refuse instead.
  if (options?.tools && options.tools.length > 0) {
    throw Object.assign(
      new Error(
        `callAnthropicModel: asked for provider-side tools (${options.tools.join(", ")}), which this adapter does not implement. Refusing rather than answering without them.`
      ),
      { consumption: "none" as const }
    );
  }
  const pricing = assertUsdAccounting(accounting, modelId);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error("callAnthropicModel: ANTHROPIC_API_KEY is not set in this environment. Refusing to call the Anthropic API."),
      { consumption: "none" as const }
    );
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: buildSystemPrompt(compiledContext),
    messages: [{ role: "user", content: buildUserMessage(compiledContext) }],
  });

  const tokensIn = assertReportedTokenCount(response.usage?.input_tokens, "input_tokens", modelId);
  const tokensOut = assertReportedTokenCount(response.usage?.output_tokens, "output_tokens", modelId);
  const cacheRead = response.usage?.cache_read_input_tokens;

  return {
    result: response.content,
    usage: {
      tokensIn,
      tokensOut,
      costAmount: tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken,
      costUnit: "usd",
      cacheHit: typeof cacheRead === "number" && cacheRead > 0,
    },
  };
}

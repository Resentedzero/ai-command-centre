/**
 * `callOpenAiModel` — the thin OpenAI-SDK wrapper. See `./anthropic.ts`'s
 * header for the full rationale shared by both provider wrapper files
 * (only-permitted-SDK-importer status, no live calls in tests, credential
 * handling, and the `pricing` signature deviation). Everything there
 * applies here identically, mirrored against `OPENAI_API_KEY` and the
 * OpenAI SDK's chat-completions usage shape (`prompt_tokens`/
 * `completion_tokens`) — including the split input/output rates, so both
 * providers behind `dispatchModelCall`'s single dispatch site share one contract.
 * No tier currently routes here; the prices themselves are the caller's
 * concern, this file only applies whichever rates it is handed.
 *
 * Fix round 1 (independent review, Important #2): prompt assembly
 * (`buildSystemPrompt`/`buildUserMessage`) is imported from
 * `./promptBuilder.ts`, shared with `./anthropic.ts`, rather than
 * duplicated here. See `./anthropic.ts`'s header for the full rationale.
 */
import OpenAI from "openai";
import type { CompiledContext } from "../../context/types.js";
import type { ProviderCallResult, TierAccounting, TierPricing } from "../types.js";
import { buildUsageAccounting, reported } from "../usageAccounting.js";
import { buildSystemPrompt, buildUserMessage } from "./promptBuilder.js";

export type { ProviderCallResult, ProviderUsage } from "../types.js";

/** See `./anthropic.ts`'s equivalent — this adapter also bills real money. */
function assertUsdAccounting(accounting: TierAccounting, modelId: string): TierPricing {
  if (accounting.unit !== "usd") {
    // `consumption: "none"`: refused before any request is sent (see
    // `providerConsumptionFrom` in ../types.ts).
    throw Object.assign(
      new Error(
        `callOpenAiModel: tier for model "${modelId}" is configured with accounting unit` +
          ` "${accounting.unit}", but this adapter bills real money and can only account in "usd".`
      ),
      { consumption: "none" as const }
    );
  }
  return accounting.pricing;
}

/**
 * Fails closed unless the provider reported this token count as a finite
 * number — never `?? 0`. Zeroed usage would reconcile a real, billed call as
 * free. Mirrors `./anthropic.ts`'s guard (not imported from there: that module
 * imports the Anthropic SDK).
 */
function assertReportedTokenCount(value: unknown, field: string, modelId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `callOpenAiModel: the OpenAI API response for model "${modelId}" did not report a finite` +
        ` numeric usage.${field} (received ${typeof value === "number" ? value : typeof value}).`
    );
  }
  return value;
}

export async function callOpenAiModel(
  modelId: string,
  compiledContext: CompiledContext,
  // The shape reaches the model through the Compiler's invocation-instruction layer.
  _expectedOutputShape: Record<string, unknown>,
  accounting: TierAccounting,
  options?: { tools?: readonly string[] }
): Promise<ProviderCallResult> {
  // R2: see `callAnthropicModel` — no provider-side tools here, so refuse rather than
  // quietly serve a call that was authorized to use them.
  if (options?.tools && options.tools.length > 0) {
    throw Object.assign(
      new Error(
        `callOpenAiModel: asked for provider-side tools (${options.tools.join(", ")}), which this adapter does not implement. Refusing rather than answering without them.`
      ),
      { consumption: "none" as const }
    );
  }
  const pricing = assertUsdAccounting(accounting, modelId);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error("callOpenAiModel: OPENAI_API_KEY is not set in this environment. Refusing to call the OpenAI API."),
      { consumption: "none" as const }
    );
  }

  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: "system", content: buildSystemPrompt(compiledContext) },
      { role: "user", content: buildUserMessage(compiledContext) },
    ],
  });

  const tokensIn = assertReportedTokenCount(response.usage?.prompt_tokens, "prompt_tokens", modelId);
  const tokensOut = assertReportedTokenCount(response.usage?.completion_tokens, "completion_tokens", modelId);
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;

  return {
    result: response.choices,
    usage: {
      tokensIn,
      tokensOut,
      costAmount: tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken,
      costUnit: "usd",
      cacheHit: typeof cached === "number" && cached > 0,
      accounting: buildUsageAccounting({
        primary: { modelId, identified: "sole_reported", input: tokensIn, output: tokensOut },
        secondary: null,
        cache: {
          read: reported(cached),
          // OpenAI reports no cache-creation quantity: caching here is automatic and uncharged.
          creation: null,
          // THE OPPOSITE OF ANTHROPIC, and the reason this flag exists: `cached_tokens` is a SUBSET of
          // `prompt_tokens`, so adding it to the input count would double-count it. This comes from
          // OpenAI's published API reference, NOT from a response recorded in this repo — unlike the
          // CLI's separation, which 16 captures in `benchmark/raw/` demonstrate arithmetically. If a
          // real OpenAI response is ever captured here, confirm it.
          cacheReadIncludedInInput: true,
        },
        // Reasoning models report this; others omit it, and then it stays unknown rather than zero.
        thinking: reported(response.usage?.completion_tokens_details?.reasoning_tokens),
        counted: {
          amount: tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken,
          unit: "usd",
          rule: "prompt_tokens x inputPerToken + completion_tokens x outputPerToken, at a LOCAL list rate — an estimate, not a bill",
        },
      }),
    },
  };
}

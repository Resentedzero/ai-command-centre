/**
 * `callOpenAiModel` — the thin OpenAI-SDK wrapper. See `./anthropic.ts`'s
 * header for the full rationale shared by both provider wrapper files
 * (only-permitted-SDK-importer status, no live calls in tests, credential
 * handling, and the `pricing` signature deviation). Everything there
 * applies here identically, mirrored against `OPENAI_API_KEY` and the
 * OpenAI SDK's chat-completions usage shape (`prompt_tokens`/
 * `completion_tokens`) — including the split input/output rates, so both
 * providers behind `callModel`'s single dispatch site share one contract.
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

export async function callOpenAiModel(
  modelId: string,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>,
  accounting: TierAccounting
): Promise<ProviderCallResult> {
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
      { role: "user", content: buildUserMessage(compiledContext, expectedOutputShape) },
    ],
  });

  const tokensIn = response.usage?.prompt_tokens ?? 0;
  const tokensOut = response.usage?.completion_tokens ?? 0;

  return {
    result: response.choices,
    usage: {
      tokensIn,
      tokensOut,
      costAmount: tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken,
      costUnit: "usd",
    },
  };
}

/**
 * `callOpenAiModel` — the thin OpenAI-SDK wrapper. See `./anthropic.ts`'s
 * header for the full rationale shared by both provider wrapper files
 * (only-permitted-SDK-importer status, no live calls in tests, credential
 * handling, and the `pricePerToken` signature deviation). Everything there
 * applies here identically, mirrored against `OPENAI_API_KEY` and the
 * OpenAI SDK's chat-completions usage shape (`prompt_tokens`/
 * `completion_tokens`).
 *
 * Fix round 1 (independent review, Important #2): prompt assembly
 * (`buildSystemPrompt`/`buildUserMessage`) is imported from
 * `./promptBuilder.ts`, shared with `./anthropic.ts`, rather than
 * duplicated here. See `./anthropic.ts`'s header for the full rationale.
 */
import OpenAI from "openai";
import type { CompiledContext } from "../../context/types.js";
import { buildSystemPrompt, buildUserMessage } from "./promptBuilder.js";

export type ProviderUsage = {
  tokensIn: number;
  tokensOut: number;
  costAmount: number;
};

export type ProviderCallResult = {
  result: unknown;
  usage: ProviderUsage;
};

export async function callOpenAiModel(
  modelId: string,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>,
  pricePerToken: number
): Promise<ProviderCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "callOpenAiModel: OPENAI_API_KEY is not set in this environment. Refusing to call the OpenAI API."
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
      costAmount: (tokensIn + tokensOut) * pricePerToken,
    },
  };
}

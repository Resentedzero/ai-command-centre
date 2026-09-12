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
 * "your call" per the brief): a fourth parameter, `pricePerToken`, is added
 * so this function can compute `usage.costAmount` from *actual* reported
 * tokens using the SAME per-token pricing heuristic `authorizeRoute`'s Pass-1
 * estimate used (`tierConfig[tier].pricePerToken`) — keeping Pass-1's
 * estimate and Pass-3's reconciliation consistent, per one cost model, rather
 * than inventing a second one here or having this file reach into
 * `tierConfig.ts` itself (which would blur "provider wrapper" and "V1 config"
 * responsibilities). `modelRouter.ts`'s `callModel` passes
 * `tierConfig[route.tier].pricePerToken` through.
 *
 * Fix round 1 (independent review, Important #2): prompt assembly
 * (`buildSystemPrompt`/`buildUserMessage`) is imported from
 * `./promptBuilder.ts`, shared with `./openai.ts`, rather than duplicated
 * here (the two implementations were previously byte-for-byte identical
 * with nothing coupling them). `promptBuilder.ts` imports no provider SDK,
 * so this does not affect the "only anthropic.ts/openai.ts import a
 * provider SDK" isolation rule — that rule is about SDK imports
 * specifically, not about banning a shared, SDK-free helper.
 */
import Anthropic from "@anthropic-ai/sdk";
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

export async function callAnthropicModel(
  modelId: string,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>,
  pricePerToken: number
): Promise<ProviderCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "callAnthropicModel: ANTHROPIC_API_KEY is not set in this environment. Refusing to call the Anthropic API."
    );
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: buildSystemPrompt(compiledContext),
    messages: [{ role: "user", content: buildUserMessage(compiledContext, expectedOutputShape) }],
  });

  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;

  return {
    result: response.content,
    usage: {
      tokensIn,
      tokensOut,
      costAmount: (tokensIn + tokensOut) * pricePerToken,
    },
  };
}

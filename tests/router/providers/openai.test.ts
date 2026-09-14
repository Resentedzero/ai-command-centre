/**
 * `callOpenAiModel` usage handling, against a mocked OpenAI SDK (no live calls).
 * Mirrors the "malformed response shape" guarantees of `anthropic.test.ts`:
 * the adapter never invents usage. No tier routes here today, which is exactly
 * why a zeroed-usage default would go unnoticed until one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledContext } from "../../../src/context/types.js";

const { chatCreate, openAiConstructor } = vi.hoisted(() => {
  const chatCreate = vi.fn();
  const openAiConstructor = vi.fn(function () {
    return { chat: { completions: { create: chatCreate } } };
  });
  return { chatCreate, openAiConstructor };
});

vi.mock("openai", () => ({ default: openAiConstructor }));

import { callOpenAiModel } from "../../../src/router/providers/openai.js";

const PRICING = { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } } as const;

function buildCompiledContext(): CompiledContext {
  return {
    layers: { instructions: "I", constraints: "C", taskState: "T", memory: "M", artifacts: "A", toolSchemas: [], invocationInstruction: "N" },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: 1,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-not-a-real-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("callOpenAiModel usage", () => {
  it("returns the provider's own reported token counts, priced at separate input/output rates", async () => {
    chatCreate.mockResolvedValueOnce({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    const { usage } = await callOpenAiModel("model-x", buildCompiledContext(), {}, PRICING);
    expect(usage.tokensIn).toBe(1000);
    expect(usage.tokensOut).toBe(100);
    expect(usage.costAmount).toBeCloseTo(0.0015, 12);
  });

  it.each([
    ["no usage object", undefined],
    ["prompt_tokens only", { prompt_tokens: 10 }],
    ["a non-numeric count", { prompt_tokens: "10", completion_tokens: 5 }],
    ["a non-finite count", { prompt_tokens: 10, completion_tokens: Number.NaN }],
  ])("rejects %s rather than recording zero or NaN usage", async (_label, usage) => {
    chatCreate.mockResolvedValueOnce({ choices: [], usage });
    await expect(callOpenAiModel("model-x", buildCompiledContext(), {}, PRICING)).rejects.toThrow(
      /did not report a finite numeric usage\./
    );
  });
});

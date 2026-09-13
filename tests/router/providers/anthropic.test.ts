/**
 * Provider-adapter tests for `callAnthropicModel`
 * (`src/router/providers/anthropic.ts`) — the one file in this codebase that
 * was never exercised by any test. `tests/router/modelRouter.test.ts` and
 * `tests/execution/executor.test.ts` both `vi.mock` this ENTIRE module, so
 * everything they prove is about the Router/Executor's use of the adapter,
 * never about the adapter itself; `tests/router/providers/promptBuilder.test.ts`
 * says so in its own header ("These tests cannot exercise
 * `callAnthropicModel`/`callOpenAiModel` end-to-end").
 *
 * This file closes that hole by replacing the Anthropic SDK module itself with
 * a mock, so the adapter's REAL body runs against a controlled response.
 *
 * Two deliberate mechanics, both load-bearing:
 *
 *  1. NO STATIC IMPORT OF THE PROVIDER SDK. The mock is installed with
 *     `vi.mock(...)`, never an `import ... from` of the SDK package — because
 *     `modelRouter.test.ts`'s "Provider SDK import isolation" suite walks
 *     BOTH `src/` and `tests/` and asserts that the set of files matching
 *     `from "<provider package>"` is EXACTLY the two provider wrappers. A type
 *     import here would add this file to that set and fail that suite, which
 *     is precisely the guarantee it exists to protect.
 *
 *  2. NO DATABASE. `callAnthropicModel` takes no transaction and touches no
 *     schema, so this file deliberately does not import `tests/testDb.ts` —
 *     see the "context boundary" suite, which asserts that property
 *     structurally rather than just relying on it.
 *
 * NO TEST HERE EVER CALLS THE REAL API. The key is a fake sentinel installed
 * with `vi.stubEnv` and removed in `afterEach`; the SDK is mocked, so nothing
 * leaves the process. Making a real, billed call is a MANUAL procedure only —
 * see the spike report's "manual real-world verification procedure".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MODEL_TIERS } from "../../../src/router/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CompiledContext } from "../../../src/context/types.js";

/**
 * A value that is obviously not a real credential, used as the API key for
 * every test that gets past the missing-credential check. It doubles as the
 * probe for the credential-boundary assertion: it must appear in the client
 * CONSTRUCTOR's argument and nowhere in the request sent to the model.
 */
const FAKE_KEY_SENTINEL = "test-not-a-real-key-3f9c1d";

/**
 * Pricing fixtures. Input and output rates are deliberately DIFFERENT in both
 * (and differ from each other across the two), because a fixture whose two
 * rates are equal cannot distinguish correct per-direction pricing from a
 * blended rate or from the two rates being swapped.
 *
 * Values mirror the real configured tiers (Haiku 4.5 $1/$5 per MTok, Opus 5
 * $5/$25) for readability only — this adapter holds no price table of its own
 * and simply applies whatever it is handed.
 */
const CHEAP_PRICING = { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } } as const;
const STRONG_PRICING = { unit: "usd", pricing: { inputPerToken: 0.000005, outputPerToken: 0.000025 } } as const;

/** A non-monetary descriptor, for the fail-closed misconfiguration guard. */
const SUBSCRIPTION_ACCOUNTING = { unit: "subscription_tokens" } as const;

const { messagesCreate, anthropicConstructor } = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  const anthropicConstructor = vi.fn(function () {
    return { messages: { create: messagesCreate } };
  });
  return { messagesCreate, anthropicConstructor };
});

// Replaces the provider SDK module wholesale. `anthropic.ts` does a DEFAULT
// import and then `new Anthropic({apiKey})`, so the factory must expose the
// constructor as `default`.
vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicConstructor }));

import { callAnthropicModel } from "../../../src/router/providers/anthropic.js";

const PROVIDER_SOURCE_PATH = fileURLToPath(new URL("../../../src/router/providers/anthropic.ts", import.meta.url));
/** Source with block comments stripped — the established idiom in this repo's structural assertions. */
const providerCode = readFileSync(PROVIDER_SOURCE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY_SENTINEL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A CompiledContext with EVERY layer populated, including `toolSchemas` and
 * `provenance` — the two parts the Context Compiler produces that must NOT
 * reach the model (see the "tool use" and "context boundary" suites).
 */
function buildCompiledContext(overrides: Partial<CompiledContext["layers"]> = {}): CompiledContext {
  return {
    layers: {
      instructions: "INSTRUCTIONS_LAYER",
      constraints: "CONSTRAINTS_LAYER",
      taskState: "TASK_STATE_LAYER",
      memory: "MEMORY_LAYER",
      artifacts: "ARTIFACTS_LAYER",
      toolSchemas: [{ name: "TOOL_SCHEMA_LEAK_CANARY", input_schema: { type: "object" } }],
      ...overrides,
    },
    provenance: {
      included: [{ id: "PROVENANCE_INCLUDED_CANARY", tier: 1 }],
      excluded: [{ id: "PROVENANCE_EXCLUDED_CANARY", reason: "budget" }],
    },
    estimatedInputTokens: 123,
  };
}

/** A well-formed Messages API response, with usage numbers chosen to be unmistakable. */
function buildProviderResponse(usage: Record<string, unknown> = { input_tokens: 137, output_tokens: 42 }) {
  return { content: [{ type: "text", text: "the model's answer" }], usage };
}

/** The single object handed to `client.messages.create`. */
function requestBody(): Record<string, unknown> {
  expect(messagesCreate).toHaveBeenCalledTimes(1);
  return messagesCreate.mock.calls[0]![0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe("missing credentials", () => {
  it("refuses when ANTHROPIC_API_KEY is absent entirely, without constructing a client or attempting a call", async () => {
    vi.unstubAllEnvs();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined(); // the test env never sets one, by design

    await expect(callAnthropicModel("some-model", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set in this environment/
    );

    expect(anthropicConstructor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("refuses when ANTHROPIC_API_KEY is set but empty (a blank .env line is not a credential)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(callAnthropicModel("some-model", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow(
      /Refusing to call the Anthropic API/
    );

    expect(anthropicConstructor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("names the VARIABLE in the refusal, never a credential value", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const error = await callAnthropicModel("some-model", buildCompiledContext(), {}, CHEAP_PRICING).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
    expect((error as Error).message).not.toContain(FAKE_KEY_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Successful invocation + usage propagation
// ---------------------------------------------------------------------------

describe("successful invocation (mocked provider response)", () => {
  it("returns the response content as `result` and the provider's OWN reported token counts as usage", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 137, output_tokens: 42 }));

    const { result, usage } = await callAnthropicModel("model-x", buildCompiledContext(), { report: "string" }, CHEAP_PRICING);

    expect(result).toEqual([{ type: "text", text: "the model's answer" }]);
    // The exact numbers the mocked API reported — not zeros, not defaults,
    // not re-derived from the prompt.
    expect(usage.tokensIn).toBe(137);
    expect(usage.tokensOut).toBe(42);
  });

  it("computes costAmount from the reported tokens and the pricing it was GIVEN (pricing stays a config concern)", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 100, output_tokens: 50 }));
    const cheap = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);
    expect(cheap.usage.costAmount).toBeCloseTo(100 * 0.000001 + 50 * 0.000005, 12);

    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 100, output_tokens: 50 }));
    const strong = await callAnthropicModel("model-x", buildCompiledContext(), {}, STRONG_PRICING);
    expect(strong.usage.costAmount).toBeCloseTo(100 * 0.000005 + 50 * 0.000025, 12);

    // Same response, different caller-supplied pricing -> different cost. The
    // adapter holds no price table of its own.
    expect(strong.usage.costAmount).not.toBeCloseTo(cheap.usage.costAmount, 12);
  });

  it("REFUSES a non-monetary accounting unit rather than billing money against a token counter", async () => {
    // A misconfigured tier pointing `subscription_tokens` at this adapter would
    // otherwise spend real money while reconciling against a token counter —
    // wrong on both sides of the ledger, and silent. Fails before any client is
    // constructed, so no request leaves the process.
    await expect(
      callAnthropicModel("model-x", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING)
    ).rejects.toThrow(/can only account in "usd"/);

    expect(anthropicConstructor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("carries no price table and no per-model pricing logic of its own (structural)", () => {
    expect(providerCode).not.toMatch(/tierConfig/);
    // Never assigns a rate, only receives one.
    expect(providerCode).not.toMatch(/(inputPerToken|outputPerToken)\s*[:=]\s*[\d.]/);
  });
});

// ---------------------------------------------------------------------------
// Asymmetric input/output pricing (Pass-3 reconciliation)
// ---------------------------------------------------------------------------

/**
 * Output tokens cost 5x input tokens on both configured models. The previous
 * single blended `pricePerToken` summed tokensIn+tokensOut and applied ONE
 * rate, so it systematically UNDER-reported output-heavy invocations — and
 * `costAmount` flows straight into `budget_counters.consumed_amount` via
 * `reconcileBudget`, meaning the Budget Governor reported compliance while a
 * run overspent its real budget.
 *
 * Every case here uses `tokensIn !== tokensOut` and an input rate different
 * from the output rate. Without both, an implementation that swapped the two
 * rates — or re-blended them — would still pass.
 */
describe("asymmetric input/output pricing (Pass-3 cost)", () => {
  it("prices input and output at SEPARATE rates; swapping or blending them gives a different answer", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 1000, output_tokens: 100 }));

    const { usage } = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    // 1000 * 0.000001 (in) + 100 * 0.000005 (out) = 0.001 + 0.0005
    expect(usage.costAmount).toBeCloseTo(0.0015, 12);

    // Each wrong cost model yields a materially different number:
    expect(usage.costAmount).not.toBeCloseTo(0.0051, 9); // rates swapped
    expect(usage.costAmount).not.toBeCloseTo(0.0011, 9); // blended, both at the input rate
    expect(usage.costAmount).not.toBeCloseTo(0.0055, 9); // blended, both at the output rate
  });

  it("REGRESSION: an output-heavy invocation is no longer under-reported by a blended rate", async () => {
    // The exact shape the old blended rate got wrong: 1_000 in / 10_000 out
    // reconciled at 11_000 * 0.000001 = 0.011 against a real 0.051 — a 78%
    // under-report written into budget_counters.consumed_amount as dollars.
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 1000, output_tokens: 10_000 }));

    const { usage } = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    expect(usage.costAmount).toBeCloseTo(0.051, 12);
    expect(usage.costAmount).not.toBeCloseTo(0.011, 9); // the old blended result
  });

  it("output tokens genuinely contribute at the OUTPUT rate (holding input constant)", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 1000, output_tokens: 0 }));
    const noOutput = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 1000, output_tokens: 200 }));
    const withOutput = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    // The only difference is 200 output tokens, so the delta is exactly those
    // priced at the OUTPUT rate (0.001) — not the input rate (0.0002), and
    // not zero.
    expect(withOutput.usage.costAmount - noOutput.usage.costAmount).toBeCloseTo(200 * 0.000005, 12);
  });

  it("applies whichever rates it is handed, per tier (no price table of its own)", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 1000, output_tokens: 100 }));
    const strong = await callAnthropicModel("model-x", buildCompiledContext(), {}, STRONG_PRICING);

    // 1000 * 0.000005 + 100 * 0.000025 = 0.005 + 0.0025
    expect(strong.usage.costAmount).toBeCloseTo(0.0075, 12);
  });
});

// ---------------------------------------------------------------------------
// Model selection belongs to the Model Router, not the adapter
// ---------------------------------------------------------------------------

describe("model selection comes from the Model Router", () => {
  it("sends exactly the modelId it was passed, with no substitution", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("router-chose-this-model", buildCompiledContext(), {}, CHEAP_PRICING);
    expect(requestBody().model).toBe("router-chose-this-model");
  });

  it("a different modelId from the Router produces a different request, with no independent decision logic", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-a", buildCompiledContext(), {}, CHEAP_PRICING);
    expect(messagesCreate.mock.calls[0]![0].model).toBe("model-a");

    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    // A "complex/high-risk"-looking context must not tempt the adapter into
    // picking anything — tier/model selection is `selectTier`'s job in
    // modelRouter.ts, and this file has no access to riskTier at all.
    await callAnthropicModel("model-b", buildCompiledContext({ constraints: "HIGH RISK. USE THE STRONGEST MODEL." }), {}, CHEAP_PRICING);
    expect(messagesCreate.mock.calls[1]![0].model).toBe("model-b");
  });

  it("contains no model identifier literal and no tier/risk vocabulary (structural)", () => {
    expect(providerCode).not.toMatch(/claude-/);
    expect(providerCode).not.toMatch(/\b(selectTier|riskTier|taskDifficulty)\b/);
    // Built from MODEL_TIERS rather than a hand-listed pair: when Phase 7H added
    // MID, a literal `CHEAP|STRONG` enumeration silently stopped guarding the
    // new tier — the guard has to grow with the ladder automatically.
    for (const tier of MODEL_TIERS) {
      expect(providerCode).not.toMatch(new RegExp(`\\b${tier}\\b`));
    }
  });
});

// ---------------------------------------------------------------------------
// Tool use — MODEL-ONLY. No tool capability may ever be granted.
// ---------------------------------------------------------------------------

describe("no tool access is ever granted to the model", () => {
  it("sends EXACTLY {model, max_tokens, system, messages} — no tools, no tool_choice, nothing else", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    // An exact key-set assertion rather than `tools === undefined`: this also
    // catches `tool_choice`, `mcp_servers`, `container`, `betas`, and anything
    // else a future edit might add, in one check.
    expect(Object.keys(requestBody()).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
  });

  it("does not forward the compiled context's toolSchemas layer to the model", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    // The Compiler DID produce tool schemas; the adapter must drop them. Tool
    // execution belongs to this project's own Tool Adapter + Capability/Policy
    // chain, never to the model's native tool-calling.
    expect(JSON.stringify(requestBody())).not.toContain("TOOL_SCHEMA_LEAK_CANARY");
  });

  it("names no tool-use API surface at all (structural)", () => {
    expect(providerCode).not.toMatch(/\btools\b|\btool_choice\b|\bmcp\b|\bcontainer\b|\ballowed_callers\b/i);
  });
});

// ---------------------------------------------------------------------------
// Context boundary — only the already-compiled context reaches the provider
// ---------------------------------------------------------------------------

describe("context boundary", () => {
  it("sends only the prompt layers the Context Compiler produced, plus the expected output shape", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-x", buildCompiledContext(), { report: "string" }, CHEAP_PRICING);

    const body = requestBody();
    expect(body.system).toBe("INSTRUCTIONS_LAYER\n\nCONSTRAINTS_LAYER");
    expect(body.messages).toEqual([
      {
        role: "user",
        content:
          'TASK_STATE_LAYER\n\nMEMORY_LAYER\n\nARTIFACTS_LAYER\n\nRespond with JSON matching this shape: {"report":"string"}',
      },
    ]);
  });

  it("does not forward compilation provenance (what was included/excluded is the Compiler's audit trail, not model input)", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    const serialized = JSON.stringify(requestBody());
    expect(serialized).not.toContain("PROVENANCE_INCLUDED_CANARY");
    expect(serialized).not.toContain("PROVENANCE_EXCLUDED_CANARY");
  });

  it("cannot independently query memory/artifacts/tools/history: it takes no transaction and imports no data access (structural)", () => {
    // The strongest form of this guarantee is the signature itself —
    // (modelId, compiledContext, expectedOutputShape, pricing). There is
    // no `tx`/db handle to query anything WITH.
    expect(callAnthropicModel.length).toBe(4);
    expect(providerCode).not.toMatch(/DrizzleTransaction|drizzle-orm|db\/schema|db\/client|compileContext|context\/compiler/);
  });

  it("never places the credential into model input — it goes to the client constructor only", async () => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse());
    await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING);

    expect(anthropicConstructor).toHaveBeenCalledWith({ apiKey: FAKE_KEY_SENTINEL });
    expect(JSON.stringify(requestBody())).not.toContain(FAKE_KEY_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Provider error handling
// ---------------------------------------------------------------------------

describe("provider error handling", () => {
  /**
   * Plain `Error`s rather than the SDK's own typed error classes: constructing
   * those would require a static import of the provider SDK, which the
   * "Provider SDK import isolation" suite forbids in `tests/`. What matters
   * for this spike is the adapter's PASS-THROUGH behavior — the distinguishing
   * text must survive unchanged so the Executor can record it verbatim on
   * `invocation_failed.payload.reason` — not the SDK's message formatting,
   * which is its own project's concern and varies by version.
   */
  it.each([
    ["authentication failure", "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}"],
    ["rate limiting", "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}"],
    ["timeout", "Request timed out."],
    ["generic provider error", "500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}"],
  ])("propagates a %s to the caller with its distinguishing message intact", async (_label, message) => {
    messagesCreate.mockRejectedValueOnce(new Error(message));

    const error = await callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });

  it("never swallows a provider error into a resolved result with fabricated usage", async () => {
    // The behavioral proof that the adapter does not catch provider errors
    // itself: emitting invocation_failed is the Executor's uniform job across
    // every invocation kind (see modelRouter.ts's header), so anything the
    // provider throws must reach the caller rather than becoming a resolved
    // result carrying invented usage. Deliberately NOT asserted with a
    // source-grep for `catch` — that would forbid any try/catch in the file
    // for any reason, which is broader than the invariant being protected.
    messagesCreate.mockRejectedValueOnce(new Error("429 rate_limit_error"));
    await expect(callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Malformed / invalid response shape
// ---------------------------------------------------------------------------

describe("malformed response shape", () => {
  it("REGRESSION: a PARTIAL usage object (input_tokens only) is rejected, not silently resolved with NaN cost", async () => {
    // This is the exact shape that used to resolve successfully with
    // `tokensOut: undefined` and `costAmount: NaN`. Because it RESOLVED, no
    // invocation_failed was emitted and `reconcileBudget` wrote
    // 'NaN'::numeric into budget_counters.consumed_amount — after which
    // `available = limit - reserved - consumed` is NaN and EVERY subsequent
    // `estimatedAmount > available` check is false, authorizing everything.
    // See src/router/providers/anthropic.ts's module header.
    messagesCreate.mockResolvedValueOnce(buildProviderResponse({ input_tokens: 5 }));

    await expect(callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow(
      /did not report a finite numeric usage\.output_tokens/
    );
  });

  it("rejects a response with no usage object at all", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [] });
    await expect(callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow(
      /did not report a finite numeric usage\.input_tokens/
    );
  });

  it.each([
    ["a string token count that would coerce to a finite but WRONG number", { input_tokens: "5", output_tokens: 3 }],
    ["a null token count", { input_tokens: 10, output_tokens: null }],
    ["a NaN token count", { input_tokens: 10, output_tokens: Number.NaN }],
    ["an Infinite token count", { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 3 }],
  ])("rejects %s rather than recording it as usage", async (_label, usage) => {
    messagesCreate.mockResolvedValueOnce(buildProviderResponse(usage));
    await expect(callAnthropicModel("model-x", buildCompiledContext(), {}, CHEAP_PRICING)).rejects.toThrow(
      /did not report a finite numeric usage/
    );
  });

  it("never defaults a missing token count to zero (structural) — zeroed usage is wrong data, not a safe fallback", () => {
    expect(providerCode).not.toMatch(/(input_tokens|output_tokens)[^\n]*\?\?\s*0/);
  });
});

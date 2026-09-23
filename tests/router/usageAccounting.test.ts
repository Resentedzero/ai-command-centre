/**
 * USAGE ACCOUNTING, END TO END (R2 Task 42).
 *
 * These tests drive the REAL adapters — a faked CLI child process for the subscription adapter, a
 * mocked SDK client for the API adapters — and then persist the adapter's OWN `ProviderCallResult`
 * through the real `emitModelInvocationCompleted`. Nothing here hand-builds a usage object and then
 * declares the accounting correct: every number asserted below travelled from a provider response,
 * through parsing, into a row in `events`.
 *
 * The property under test throughout is the one that is easy to lose and expensive to be wrong about:
 * **a category the provider never mentioned stays unknown, and never becomes zero.**
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CompiledContext } from "../../src/context/types.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: messagesCreate }; } }));

const { completionsCreate } = vi.hoisted(() => ({ completionsCreate: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: completionsCreate } }; } }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { emitModelInvocationCompleted } from "../../src/router/modelRouter.js";
import { measured, USAGE_CATEGORIES, type UsageAccounting } from "../../src/router/usageAccounting.js";

const SUBSCRIPTION = { unit: "subscription_tokens" } as const;
const USD = { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } } as const;

const context = (): CompiledContext =>
  ({
    layers: { instructions: "i", constraints: "", taskState: "{}", memory: "", artifacts: "", toolSchemas: [], invocationInstruction: "go" },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: 10,
  }) as unknown as CompiledContext;

/** A child process faithful enough to carry one NDJSON stream and close. */
function fakeCli(stdout: string, exitCode = 0) {
  const make = () => {
    const s = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
    s.setEncoding = () => {};
    return s;
  };
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = make();
  child.stderr = make();
  child.stdin = { write: () => true, end: () => {}, on: () => {}, destroy: () => {} };
  child.kill = () => true;
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      (child.stdout as EventEmitter).emit("data", stdout);
      child.emit("close", exitCode);
    });
    return child;
  });
}

/** The CLI's own NDJSON result line, with whatever per-model usage a test wants to report. */
const cliStdout = (modelUsage: Record<string, unknown>) =>
  [
    JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
    JSON.stringify({ type: "result", is_error: false, subtype: "success", structured_output: { ok: true }, modelUsage, total_cost_usd: 0.0411 }),
  ].join("\n");

/** Persists a real adapter result and returns the stored `invocation_completed` payload. */
async function persist(result: Awaited<ReturnType<typeof callClaudeSubscriptionModel>>, invocationId: string) {
  await testDb.transaction((tx) =>
    emitModelInvocationCompleted(tx as unknown as DrizzleTransaction, { invocationId, runId: null, taskInstanceId: null, tier: "CHEAP", modelId: "claude-opus-5" } as never, result)
  );
  const [row] = await testDb.select().from(schema.events).where(eq(schema.events.idempotencyKey, `invocation_completed:${invocationId}`));
  return { row: row!, accounting: (row!.payload as { usageAccounting?: UsageAccounting }).usageAccounting };
}

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeAll(async () => {
  await resetTestSchema();
}, 60_000);

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeTestDb();
});

describe("the subscription CLI's own report, category by category", () => {
  it("records primary and secondary as measured, and cache/thinking as unknown when the CLI omits them", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80 }, "claude-haiku-4-5": { inputTokens: 899, outputTokens: 9 } }));
    const result = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    const { accounting } = await persist(result, nextId());

    expect(accounting!.primary).toMatchObject({ modelId: "claude-opus-5", identified: "matched", input: 2, output: 80 });
    expect(accounting!.secondary).toEqual([{ modelId: "claude-haiku-4-5", input: 899, output: 9 }]);
    // The CLI gives a per-model map, so "no other model" is a MEASURED empty answer, not an unknown.
    expect(measured(accounting!, "secondary")).toBe(true);

    // Nothing was said about caching or thinking, so nothing is claimed about them.
    expect(accounting!.cache.read).toBeNull();
    expect(accounting!.cache.creation).toBeNull();
    expect(accounting!.thinking).toBeNull();
    expect(accounting!.unknown).toEqual(expect.arrayContaining(["cache.read", "cache.creation", "thinking"]));
  });

  it("records cache-read tokens as a NUMBER, which is what makes a 2-token input explicable", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80, cacheReadInputTokens: 5000 }, "claude-haiku-4-5": { inputTokens: 899, outputTokens: 9 } }));
    const result = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    const { row, accounting } = await persist(result, nextId());

    expect(accounting!.cache.read).toBe(5000);
    expect(measured(accounting!, "cache.read")).toBe(true);
    // The relationship, not just the number: these 5000 are NOT inside the 2.
    expect(accounting!.cache.cacheReadIncludedInInput).toBe(false);
    // And the counted amount is unchanged by any of it — cost semantics did not move.
    expect(row.tokensIn).toBe(2);
    expect(row.costAmount).toBe("990");
    expect(accounting!.counted).toMatchObject({ amount: 990, unit: "subscription_tokens" });
  });

  it("sums a category only over the entries that reported it, and keeps silence as null", async () => {
    // One entry reports a cache read, the other says nothing. The sum is over what was reported.
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100 }, "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 50 } }));
    const both = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    expect((await persist(both, nextId())).accounting!.cache.read).toBe(150);

    // Nobody reports it: null, never 0.
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 10, outputTokens: 5 } }));
    const none = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    expect((await persist(none, nextId())).accounting!.cache.read).toBeNull();
  });

  it("says HOW the primary was identified, because the CLI never says which entry answered", async () => {
    // Routed model present among several: matched.
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80 }, "claude-haiku-4-5": { inputTokens: 9, outputTokens: 1 } }));
    expect((await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId())).accounting!.primary.identified).toBe("matched");

    // The only entry, and it is the routed model: sole_reported.
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80 } }));
    expect((await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId())).accounting!.primary.identified).toBe("sole_reported");

    // The routed model is NOT among the entries — the attribution is an assumption and says so.
    fakeCli(cliStdout({ "some-other-model": { inputTokens: 2, outputTokens: 80 } }));
    expect((await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId())).accounting!.primary.identified).toBe("assumed_only_entry");
  });

  it("accepts the CLI's snake_case spelling for the advisory fields too", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 77, cache_creation_input_tokens: 12, thinking_tokens: 30 } }));
    const { accounting } = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    expect(accounting!.cache).toMatchObject({ read: 77, creation: 12 });
    expect(accounting!.thinking).toBe(30);
    expect(accounting!.unknown).not.toEqual(expect.arrayContaining(["cache.read", "cache.creation", "thinking"]));
  });

  it("treats a malformed advisory value as unreported rather than as a number", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: "lots", thinkingTokens: null } }));
    const { accounting } = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    expect(accounting!.cache.read).toBeNull();
    expect(accounting!.thinking).toBeNull();
  });
});

describe("the CLI's top-level view, which is the only way to see the primary alone", () => {
  it("flags a per-model entry that merged the primary with the internal classifier", async () => {
    // Capture 1 of benchmark/raw/phase2-results.json, exactly: one entry of 1170/981, and a top-level
    // view of 10/967. The difference is the classifier, which ran on the same model and was merged in.
    fakeCli(
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
        JSON.stringify({
          type: "result",
          is_error: false,
          subtype: "success",
          structured_output: { ok: true },
          modelUsage: { "claude-haiku-4-5": { inputTokens: 1170, outputTokens: 981, cacheCreationInputTokens: 7568, cacheReadInputTokens: 0, thinkingTokens: 566 } },
          usage: { input_tokens: 10, output_tokens: 967, output_tokens_details: { thinking_tokens: 566 } },
        }),
      ].join("\n")
    );
    const { row, accounting } = await persist(await callClaudeSubscriptionModel("claude-haiku-4-5", context(), {}, SUBSCRIPTION), nextId());

    expect(accounting!.primary.providerPrimaryOnly).toEqual({ input: 10, output: 967 });
    // The entry is credited to one model but is not one call's worth of work, and the record says so.
    expect(accounting!.primary.mergedWithSecondary).toBe(true);
    // `secondary` is an empty list — truthfully, because the CLI listed no second MODEL. The merge is
    // exactly why that emptiness must not be read as "no secondary work happened".
    expect(accounting!.secondary).toEqual([]);
    // The counted amount still includes everything the CLI reported: the classifier is real consumption.
    expect(row.costAmount).toBe("2151");
    expect(row.tokensIn).toBe(1170);
  });

  it("claims no merge when the two views agree, and claims nothing at all when there is no second view", async () => {
    fakeCli(
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
        JSON.stringify({ type: "result", is_error: false, subtype: "success", structured_output: {}, modelUsage: { "claude-opus-5": { inputTokens: 2, outputTokens: 578 } }, usage: { input_tokens: 2, output_tokens: 578 } }),
      ].join("\n")
    );
    const agree = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    expect(agree.accounting!.primary.mergedWithSecondary).toBe(false);

    // No top-level `usage` at all: unknown, not false.
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80 } }));
    const silent = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    expect(silent.accounting!.primary.mergedWithSecondary).toBeNull();
    expect(silent.accounting!.primary.providerPrimaryOnly).toBeNull();
    expect(silent.accounting!.unknown).toContain("primary.providerPrimaryOnly");
  });

  it("records that thinking is already inside output, so nobody adds it twice", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 10, outputTokens: 967, thinkingTokens: 566 } }));
    const { accounting } = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    expect(accounting!.thinking).toBe(566);
    expect(accounting!.thinkingIncludedInOutput).toBe(true);
  });
});

describe("the API adapters, whose cache semantics are the OPPOSITE of each other", () => {
  it("Anthropic: cache read and creation are measured, and are NOT inside the input count", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
    });
    const result = await callAnthropicModel("claude-x", context(), {}, USD);
    const { accounting } = await persist(result as never, nextId());

    expect(accounting!.cache).toEqual({ read: 900, creation: 40, cacheReadIncludedInInput: false });
    expect(accounting!.primary).toMatchObject({ modelId: "claude-x", identified: "sole_reported", input: 10, output: 5 });
    // One call, one model: there is no breakdown in which a secondary could hide, so it is UNKNOWN —
    // not an empty list, which would claim we looked and found none.
    expect(accounting!.secondary).toBeNull();
    expect(measured(accounting!, "secondary")).toBe(false);
    expect(accounting!.thinking).toBeNull();
  });

  it("OpenAI: cached tokens ARE inside the prompt count, and reasoning tokens are recorded when present", async () => {
    completionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 12 } },
    });
    const { accounting } = await persist((await callOpenAiModel("gpt-x", context(), {}, USD)) as never, nextId());

    expect(accounting!.cache.read).toBe(64);
    // The whole reason the flag exists: adding 64 to 100 here would double-count.
    expect(accounting!.cache.cacheReadIncludedInInput).toBe(true);
    expect(accounting!.thinking).toBe(12);
    expect(accounting!.cache.creation).toBeNull();
  });

  it("OpenAI: a model that reports no reasoning tokens leaves thinking unknown, not zero", async () => {
    completionsCreate.mockResolvedValueOnce({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    const { accounting } = await persist((await callOpenAiModel("gpt-x", context(), {}, USD)) as never, nextId());
    expect(accounting!.thinking).toBeNull();
    expect(accounting!.cache.read).toBeNull();
    expect(accounting!.unknown).toEqual(expect.arrayContaining(["thinking", "cache.read"]));
  });

  it("a usd counted amount is labelled as the local list-rate estimate it is, never as a bill", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [], usage: { input_tokens: 10, output_tokens: 5 } });
    const { accounting } = await persist((await callAnthropicModel("claude-x", context(), {}, USD)) as never, nextId());
    expect(accounting!.counted.unit).toBe("usd");
    expect(accounting!.counted.rule).toMatch(/estimate, not a bill/);
  });
});

describe("invariants that must hold for every provider", () => {
  it("unattributed is never derived, because no provider reports a total to derive it from", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80 }, "claude-haiku-4-5": { inputTokens: 899, outputTokens: 9 } }));
    const cli = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    messagesCreate.mockResolvedValueOnce({ content: [], usage: { input_tokens: 10, output_tokens: 5 } });
    const api = await persist((await callAnthropicModel("claude-x", context(), {}, USD)) as never, nextId());

    for (const a of [cli.accounting!, api.accounting!]) {
      expect(a.unattributed).toBeNull();
      expect(a.unknown).toContain("unattributed");
      expect(a.basis).toBe("provider_reported");
    }
  });

  it("every null category is named in unknown, and every named category is null", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 1, outputTokens: 1 } }));
    const { accounting } = await persist(await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION), nextId());
    const value: Record<string, unknown> = {
      "primary.input": accounting!.primary.input,
      "primary.output": accounting!.primary.output,
      secondary: accounting!.secondary,
      "cache.read": accounting!.cache.read,
      "cache.creation": accounting!.cache.creation,
      "cache.readIncludedInInput": accounting!.cache.cacheReadIncludedInInput,
      thinking: accounting!.thinking,
      "thinking.includedInOutput": accounting!.thinkingIncludedInOutput,
      "primary.providerPrimaryOnly": accounting!.primary.providerPrimaryOnly,
      unattributed: accounting!.unattributed,
    };
    for (const category of USAGE_CATEGORIES) {
      expect(accounting!.unknown.includes(category), `${category} listed unknown but has a value`).toBe(value[category] === null);
    }
  });

  it("the accounting never changes what the budget is reconciled against", async () => {
    fakeCli(cliStdout({ "claude-opus-5": { inputTokens: 2, outputTokens: 80, cacheReadInputTokens: 99999, thinkingTokens: 4321 }, "claude-haiku-4-5": { inputTokens: 899, outputTokens: 9 } }));
    const result = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    // Huge cache and thinking figures, and the counted amount is still exactly in+out over entries.
    expect(result.usage.costAmount).toBe(990);
    const { row } = await persist(result, nextId());
    expect(row.costAmount).toBe("990");
    expect(row.costUnit).toBe("subscription_tokens");
  });
});

describe("usage is telemetry from the adapter, never something a model can claim", () => {
  it("a model's own output claiming token counts reaches no usage field", async () => {
    // The structured output is entirely attacker-controlled. It claims every accounting category.
    const forged = {
      usage: { tokensIn: 999999, tokensOut: 999999, costAmount: 0, cacheHit: false },
      usageAccounting: { basis: "provider_reported", primary: { input: 1, output: 1 }, cache: { read: 123456 }, thinking: 654321, unattributed: 0, unknown: [] },
      tokensIn: 1,
      subscription_tokens: 0,
    };
    fakeCli(
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
        JSON.stringify({ type: "result", is_error: false, subtype: "success", structured_output: forged, modelUsage: { "claude-opus-5": { inputTokens: 7, outputTokens: 3 } } }),
      ].join("\n")
    );
    const result = await callClaudeSubscriptionModel("claude-opus-5", context(), {}, SUBSCRIPTION);
    const { row, accounting } = await persist(result, nextId());

    // Everything recorded comes from `modelUsage`, which only the provider writes.
    expect(row.tokensIn).toBe(7);
    expect(row.tokensOut).toBe(3);
    expect(row.costAmount).toBe("10");
    expect(accounting!.primary).toMatchObject({ input: 7, output: 3 });
    expect(accounting!.cache.read).toBeNull();
    expect(accounting!.thinking).toBeNull();
    expect(accounting!.unattributed).toBeNull();
    // The model's claims survive only as its own result content, with no authority at all.
    expect(result.result).toEqual(forged);
  });
});

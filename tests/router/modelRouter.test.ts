import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CompiledContext } from "../../src/context/types.js";
import type { ModelTier, RouteRequest, RouteResult } from "../../src/router/types.js";
import { tierConfig, providerCandidates, type ProviderCandidate } from "../../src/router/tierConfig.js";
import * as policyModule from "../../src/governance/policy.js";
import * as quotaGuardrailModule from "../../src/governance/quotaGuardrail.js";
import { recordQuotaObservation } from "../../src/governance/subscriptionQuotaState.js";
import * as approvalsModule from "../../src/governance/approvals.js";
import { callEvaluatePolicyForTest } from "./policyCallHelper.js";

// ---------------------------------------------------------------------------
// Mock BOTH provider wrapper modules — no test in this file calls a real
// provider SDK. modelRouter.ts's `callModel` selects between these two
// exclusively via tierConfig[route.tier].provider, so mocking both and
// asserting on which one was invoked also proves the provider-dispatch
// (not just modelId) is config-driven.
// ---------------------------------------------------------------------------
vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  callClaudeSubscriptionModel: vi.fn(),
}));

import {
  authorizeRoute,
  dispatchModelCall,
  emitModelInvocationCompleted,
  finalizeModelCall,
  selectCandidates,
} from "../../src/router/modelRouter.js";

/**
 * Dispatch, finalize, then record completion — the Phase 9 halves composed for
 * Router-level tests (the Executor persists the result between the last two).
 */
async function callModel(
  tx: DrizzleTransaction,
  route: RouteResult,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>
) {
  const providerResult = await finalizeModelCall(tx, route, await dispatchModelCall(route, compiledContext, expectedOutputShape));
  await emitModelInvocationCompleted(tx, route, providerResult);
  return providerResult;
}
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Seeds a minimal FK-valid chain (project -> taskDefinition -> taskInstance
 * -> run -> invocation) plus a budget_counters row for the run, matching the
 * pre-dispatch ruling's instruction: this unit does NOT create Invocation
 * rows itself, so tests seed one as a fixture (same pattern Units 2-4 used).
 */
async function seedFixtureChain(
  tx: DrizzleTransaction,
  overrides: { limitAmount?: string; subscriptionTokenLimit?: string } = {}
): Promise<{ runId: string; taskInstanceId: string; invocationId: string }> {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: taskDefinition!.version,
      projectId: project!.id,
      status: "pending",
      input: {},
    })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId: taskInstance!.id, status: "active" })
    .returning();
  const [invocation] = await tx
    .insert(schema.invocations)
    .values({
      runId: run!.id,
      seqNo: 1,
      kind: "llm",
      costClass: "llm",
      status: "pending",
      idempotencyKey: `test-inv-${randomUUID()}`,
    })
    .returning();
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    limitAmount: overrides.limitAmount ?? "1000.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  // Mirrors production provisioning, which now creates one counter per unit.
  // `limitAmount` above stays a DOLLAR figure; this is an independent token
  // ceiling, never converted from it. `overrides.limitAmount` intentionally
  // applies only to the USD counter, so a "0.00" budget test still exercises
  // the USD path it was written for.
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: overrides.subscriptionTokenLimit ?? "200000",
    reservedAmount: "0",
    consumedAmount: "0",
  });

  return { runId: run!.id, taskInstanceId: taskInstance!.id, invocationId: invocation!.id };
}

/**
 * Default request: taskDifficulty "simple" + riskTier "low" -> CHEAP tier.
 * contextBudget.maxInputTokens=100_000, expectedOutputTokens=0 so
 * estimateCost = 100_000 * tierConfig[tier].pricing.inputPerToken lands on a
 * clean number (0.1 for CHEAP's 0.000001 input rate, 0.5 for STRONG's
 * 0.000005) rather than requiring float-imprecision tolerance everywhere.
 *
 * NOTE its `expectedOutputTokens: 0`: this fixture deliberately exercises the
 * INPUT rate only, so it cannot detect an output-pricing regression. The
 * "asymmetric pricing" suite below exists precisely to cover that path — do
 * not treat this fixture's passing as evidence output pricing works.
 */
function buildRequest(
  overrides: Partial<RouteRequest> & Pick<RouteRequest, "runId" | "taskInstanceId" | "invocationId">
): RouteRequest {
  return {
    taskDifficulty: "simple",
    riskTier: "low",
    contextBudget: {
      maxInputTokens: 100_000,
      maxArtifactTokens: 2_000,
      maxRetrievedItems: 50,
      maxToolSchemaTokens: 2_000,
      compressionThreshold: 2_000,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 0,
    },
    ...overrides,
  };
}

function buildCompiledContext(): CompiledContext {
  return {
    layers: {
      instructions: "do the task",
      constraints: "",
      taskState: "state",
      memory: "",
      artifacts: "",
      toolSchemas: [],
      invocationInstruction: "INVOCATION_INSTRUCTION_LAYER",
    },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: 100,
  };
}

/** Narrows `RouteResult | {authorized:false}` to `RouteResult`, throwing (test failure) otherwise. */
function assertAuthorized(route: RouteResult | { authorized: false }): asserts route is RouteResult {
  if ("authorized" in route) {
    throw new Error("expected authorizeRoute to succeed, got {authorized: false}");
  }
}

// ---------------------------------------------------------------------------
// Tier selection (Phase 10.7)
// ---------------------------------------------------------------------------

describe("authorizeRoute tier selection", () => {
  it.each(["high", "highest"] as const)(
    "selects STRONG when riskTier is %s, regardless of taskDifficulty (quality floor)",
    async (riskTier) => {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(
          tx,
          buildRequest({ runId, taskInstanceId, invocationId, taskDifficulty: "simple", riskTier })
        );
        assertAuthorized(route);
        expect(route.tier).toBe("STRONG");
        expect(route.modelId).toBe(tierConfig.STRONG.modelId);
      });
    }
  );

  // Phase 7H: the three difficulty levels map 1:1 onto the three tiers.
  // "standard" previously resolved to CHEAP because MID did not exist.
  it.each([
    ["simple", "CHEAP"],
    ["standard", "MID"],
    ["complex", "STRONG"],
  ] as const)("maps %s taskDifficulty to the %s tier at low/medium riskTier", async (taskDifficulty, tier) => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const route = await authorizeRoute(
        tx,
        buildRequest({ runId, taskInstanceId, invocationId, taskDifficulty, riskTier: "medium" })
      );
      assertAuthorized(route);
      expect(route.tier).toBe(tier);
    });
  });

  it("selects STRONG for complex taskDifficulty even at low riskTier", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const route = await authorizeRoute(
        tx,
        buildRequest({ runId, taskInstanceId, invocationId, taskDifficulty: "complex", riskTier: "low" })
      );
      assertAuthorized(route);
      expect(route.tier).toBe("STRONG");
    });
  });
});

// ---------------------------------------------------------------------------
// Budget failure (Pass 1)
// ---------------------------------------------------------------------------

describe("authorizeRoute budget failure", () => {
  useApiPrimary();
  it("returns {authorized:false} on budget failure, without emitting an event or calling a provider", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "0.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      // The reason distinguishes a budget denial from a Phase 7C quota refusal.
      expect(route).toEqual({ authorized: false, reason: "insufficient_budget" });

      const eventRow = await tx.query.events.findFirst({ where: eq(schema.events.invocationId, invocationId) });
      expect(eventRow).toBeUndefined();
    });

    expect(callAnthropicModel).not.toHaveBeenCalled();
    expect(callOpenAiModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// tierConfig is genuinely load-bearing, not decorative
// ---------------------------------------------------------------------------

/**
 * Phase 7D moved the source of truth from `tierConfig` (now a derived view) to
 * the declarative `providerCandidates` list. These tests mutate the primary
 * CHEAP candidate to prove routing and dispatch are still driven by
 * configuration rather than by anything hard-coded in the router.
 */
/**
 * Makes the Anthropic API candidates primary for the enclosing suite, by
 * disabling the subscription ones.
 *
 * Phase 7F made Claude Max the production default. The suites below test the
 * METERED USD path — asymmetric pricing, dollar reconciliation — which is still
 * a fully supported, configured candidate and still has to be correct. Pinning
 * the API candidate explicitly is what those suites always meant; before 7F it
 * was merely implicit in the default. No assertion is weakened: they check the
 * same USD arithmetic they always did.
 */
function useApiPrimary() {
  const subscriptionCandidates = providerCandidates.filter((c) => c.provider === "claude_subscription");
  const saved = subscriptionCandidates.map((c) => c.enabled);

  beforeEach(() => {
    for (const c of subscriptionCandidates) c.enabled = false;
  });
  afterEach(() => {
    subscriptionCandidates.forEach((c, i) => {
      c.enabled = saved[i]!;
    });
  });
}

async function withCheapCandidate(patch: Partial<ProviderCandidate>, fn: () => Promise<void>) {
  const candidate = providerCandidates.find((c) => c.enabled && c.tiers.includes("CHEAP"))!;
  const original = { ...candidate };
  Object.assign(candidate, patch);
  try {
    await fn();
  } finally {
    Object.assign(candidate, original);
  }
}

describe("tier->model mapping is read from configuration, not hard-coded", () => {
  useApiPrimary();
  it("swapping the CHEAP candidate's modelId AND provider changes authorizeRoute/callModel's behavior accordingly", async () => {
    // The API candidate's OWN accounting — not tierConfig.CHEAP, which is the
    // derived view of the SUBSCRIPTION primary now that Phase 7F flipped it.
    const original = providerCandidates.find((c) => c.provider === "anthropic" && c.tiers.includes("CHEAP"))!;
    await withCheapCandidate({ modelId: "custom-swapped-model-id", provider: "openai" }, async () => {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
        assertAuthorized(route);
        expect(route.tier).toBe("CHEAP");
        expect(route.modelId).toBe("custom-swapped-model-id");

        vi.mocked(callOpenAiModel).mockResolvedValueOnce({
          result: { ok: true },
          usage: { tokensIn: 10, tokensOut: 5, costAmount: 1, costUnit: "usd" },
        });

        await callModel(tx, route, buildCompiledContext(), {});

        expect(callOpenAiModel).toHaveBeenCalledWith(
          "custom-swapped-model-id",
          expect.anything(),
          expect.anything(),
          original.accounting
        );
        expect(callAnthropicModel).not.toHaveBeenCalled();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Provider dispatch is a total map, not a conditional
// ---------------------------------------------------------------------------

/**
 * The old dispatch was `provider === "anthropic" ? anthropic : openai`, whose
 * else-branch accepted ANY other value. Adding a third provider to the union
 * would therefore have silently sent subscription calls to the OpenAI adapter —
 * a billable call instead of a quota one — and the type system would not have
 * caught it, because the ternary has no exhaustiveness requirement.
 *
 * These tests pin each provider to its OWN adapter and, critically, assert the
 * other two were not called.
 */
describe("provider dispatch map", () => {
  const cases = [
    {
      provider: "anthropic" as const,
      accounting: { unit: "usd" as const, pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } },
      expected: callAnthropicModel,
      others: [callOpenAiModel, callClaudeSubscriptionModel],
      costUnit: "usd" as const,
    },
    {
      provider: "openai" as const,
      accounting: { unit: "usd" as const, pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } },
      expected: callOpenAiModel,
      others: [callAnthropicModel, callClaudeSubscriptionModel],
      costUnit: "usd" as const,
    },
    {
      provider: "claude_subscription" as const,
      accounting: { unit: "subscription_tokens" as const },
      expected: callClaudeSubscriptionModel,
      others: [callAnthropicModel, callOpenAiModel],
      costUnit: "subscription_tokens" as const,
    },
  ];

  it.each(cases)("routes provider $provider to its own adapter and no other", async ({
    provider,
    accounting,
    expected,
    others,
    costUnit,
  }) => {
    await withCheapCandidate({ provider, accounting }, async () => {
      await withRollback(async (tx) => {
        const ids = await seedFixtureChain(tx, { limitAmount: "1000000" });
        // seedFixtureChain already provisions BOTH a usd and a
        // subscription_tokens counter, mirroring production.

        const route = await authorizeRoute(tx, buildRequest(ids));
        assertAuthorized(route);

        vi.mocked(expected).mockResolvedValueOnce({
          result: { ok: true },
          usage: { tokensIn: 3, tokensOut: 4, costAmount: 7, costUnit },
        });

        await callModel(tx, route, buildCompiledContext(), {});

        expect(expected).toHaveBeenCalledTimes(1);
        for (const other of others) {
          expect(other).not.toHaveBeenCalled();
        }
      });
    });
  });

  it("records the provider's OWN declared cost unit on invocation_completed", async () => {
    await withCheapCandidate(
      { provider: "claude_subscription", accounting: { unit: "subscription_tokens" } },
      async () => {
      await withRollback(async (tx) => {
        const ids = await seedFixtureChain(tx, {
          limitAmount: "1000000",
          subscriptionTokenLimit: "1000000",
        });

        const route = await authorizeRoute(tx, buildRequest(ids));
        assertAuthorized(route);

        vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
          result: {},
          usage: {
            tokensIn: 2,
            tokensOut: 80,
            costAmount: 990,
            costUnit: "subscription_tokens",
            secondaryUsage: [{ modelId: "claude-haiku-4-5-20251001", tokensIn: 899, tokensOut: 9 }],
          },
        });

        await callModel(tx, route, buildCompiledContext(), {});

        const completed = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, ids.invocationId), eq(schema.events.eventType, "invocation_completed")),
        });

        // Token units are recorded as tokens and labelled as such — never as
        // dollars, and never as $0.
        expect(completed?.costUnit).toBe("subscription_tokens");
        expect(Number(completed?.costAmount)).toBe(990);

        // Reconciliation landed in the token counter, not the monetary one.
        const tokenCounter = await tx.query.budgetCounters.findFirst({
          where: and(
            eq(schema.budgetCounters.scopeRefId, ids.runId),
            eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
          ),
        });
        const usdCounter = await tx.query.budgetCounters.findFirst({
          where: and(
            eq(schema.budgetCounters.scopeRefId, ids.runId),
            eq(schema.budgetCounters.resourceUnit, "usd")
          ),
        });
        expect(Number(tokenCounter!.consumedAmount)).toBe(990);
        expect(Number(usdCounter!.consumedAmount)).toBe(0);
      });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Default tier mapping must stay on the metered API until benchmarked
// ---------------------------------------------------------------------------

describe("default tier mapping", () => {
  it("defaults BOTH tiers to claude_subscription, accounted in subscription_tokens", () => {
    // UPDATED BY PHASE 7F. This assertion previously guarded the opposite —
    // that the subscription provider stayed off until the Max benchmark had
    // run. That benchmark and the 7A-7E validation are complete, and the
    // production default was deliberately switched, so the guard now pins the
    // NEW default just as strictly: ordering in `providerCandidates` is the
    // entire mechanism, and this fails if it drifts.
    expect(tierConfig.CHEAP.provider).toBe("claude_subscription");
    expect(tierConfig.STRONG.provider).toBe("claude_subscription");
    expect(tierConfig.CHEAP.accounting.unit).toBe("subscription_tokens");
    expect(tierConfig.STRONG.accounting.unit).toBe("subscription_tokens");
  });
});

// ---------------------------------------------------------------------------
// Asymmetric input/output pricing (Pass-1 estimate)
// ---------------------------------------------------------------------------

/**
 * Output tokens cost ~5x input tokens on both configured models. The previous
 * single blended `pricePerToken` could not express that: it summed the input
 * and output token counts and applied ONE rate, systematically under-pricing
 * output-heavy invocations — and that error landed in
 * `budget_counters.consumed_amount` as if it were dollars, i.e. the Budget
 * Governor reported compliance while a run overspent its real budget.
 *
 * Each case below needs ALL of: `expectedOutputTokens > 0`, an input rate
 * different from the output rate, and (Pass 3, in the provider tests)
 * `tokensIn !== tokensOut`. With any one of those missing, an implementation
 * that SWAPPED the two rates, or re-blended them, still passes. The
 * `buildRequest` fixture above uses `expectedOutputTokens: 0` and therefore
 * cannot catch any of this — hence this suite.
 */
describe("asymmetric input/output pricing (Pass-1 reservation)", () => {
  useApiPrimary();
  /** Differs from buildRequest's default ONLY in expectedOutputTokens. */
  const budgetWithOutput = (expectedOutputTokens: number) => ({
    maxInputTokens: 100_000,
    maxArtifactTokens: 2_000,
    maxRetrievedItems: 50,
    maxToolSchemaTokens: 2_000,
    compressionThreshold: 2_000,
    freshnessRequirementSeconds: 0,
    expectedOutputTokens,
  });

  async function reservedFor(
    tx: Parameters<typeof authorizeRoute>[0],
    overrides: Partial<RouteRequest> & Pick<RouteRequest, "runId" | "taskInstanceId" | "invocationId">
  ): Promise<{ tier: ModelTier; reserved: number }> {
    const route = await authorizeRoute(tx, buildRequest(overrides));
    assertAuthorized(route);
    const counter = await tx.query.budgetCounters.findFirst({
      where: and(
        eq(schema.budgetCounters.scopeRefId, overrides.runId),
        eq(schema.budgetCounters.resourceUnit, "usd")
      ),
    });
    return { tier: route.tier, reserved: Number(counter!.reservedAmount) };
  }

  it("CHEAP: prices the input ceiling and expected output at SEPARATE rates", async () => {
    await withRollback(async (tx) => {
      const ids = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const { tier, reserved } = await reservedFor(tx, { ...ids, contextBudget: budgetWithOutput(10_000) });

      expect(tier).toBe("CHEAP");
      // 100_000 * 0.000001 (in) + 10_000 * 0.000005 (out) = 0.1 + 0.05
      expect(reserved).toBeCloseTo(0.15, 10);

      // Each wrong cost model yields a materially different number, so this
      // assertion cannot be satisfied by accident:
      expect(reserved).not.toBeCloseTo(0.51, 6); // rates swapped
      expect(reserved).not.toBeCloseTo(0.11, 6); // blended, both at the input rate
      expect(reserved).not.toBeCloseTo(0.55, 6); // blended, both at the output rate
    });
  });

  it("STRONG: uses STRONG's own input/output rates, not CHEAP's and not a blend", async () => {
    await withRollback(async (tx) => {
      const ids = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const { tier, reserved } = await reservedFor(tx, {
        ...ids,
        taskDifficulty: "complex",
        contextBudget: budgetWithOutput(10_000),
      });

      expect(tier).toBe("STRONG");
      // 100_000 * 0.000005 (in) + 10_000 * 0.000025 (out) = 0.5 + 0.25
      expect(reserved).toBeCloseTo(0.75, 10);

      expect(reserved).not.toBeCloseTo(2.55, 6); // rates swapped
      expect(reserved).not.toBeCloseTo(0.15, 6); // CHEAP's rates
    });
  });

  it("expectedOutputTokens genuinely contributes to the reservation, priced at the OUTPUT rate", async () => {
    await withRollback(async (tx) => {
      const a = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const withoutOutput = await reservedFor(tx, { ...a, contextBudget: budgetWithOutput(0) });

      const b = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const withOutput = await reservedFor(tx, { ...b, contextBudget: budgetWithOutput(10_000) });

      // The ONLY difference is 10_000 expected output tokens, so the delta is
      // exactly those tokens priced at CHEAP's output rate (0.000005) — not at
      // its input rate (which would be 0.01), and not zero (which is what a
      // reservation ignoring output entirely would give).
      expect(withOutput.reserved - withoutOutput.reserved).toBeCloseTo(0.05, 10);
      expect(withOutput.reserved).toBeGreaterThan(withoutOutput.reserved);
    });
  });
});

// ---------------------------------------------------------------------------
// callModel: reconciliation + invocation_completed event
// ---------------------------------------------------------------------------

describe("callModel", () => {
  useApiPrimary();
  it("reconciles actual usage against budget_counters in one transaction", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      const afterReserve = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      // CHEAP: 100_000 input * 0.000001 + 0 output * 0.000005 = 0.1
      expect(Number(afterReserve!.reservedAmount)).toBeCloseTo(0.1, 10);
      expect(Number(afterReserve!.consumedAmount)).toBe(0);

      vi.mocked(callAnthropicModel).mockResolvedValueOnce({
        result: {},
        usage: { tokensIn: 100, tokensOut: 50, costAmount: 0.05, costUnit: "usd" },
      });

      await callModel(tx, route, buildCompiledContext(), {});

      const afterReconcile = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      // Original estimate (0.1) fully released from reserved_amount...
      expect(Number(afterReconcile!.reservedAmount)).toBeCloseTo(0, 10);
      // ...and actual usage (0.05) added to consumed_amount.
      expect(Number(afterReconcile!.consumedAmount)).toBeCloseTo(0.05, 10);
    });
  });

  it("emits invocation_completed with usage populated (tokensIn/tokensOut/cacheHit/costAmount/modelId), correlated to runId/taskInstanceId/invocationId", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      vi.mocked(callAnthropicModel).mockResolvedValueOnce({
        result: { text: "hi" },
        usage: { tokensIn: 120, tokensOut: 40, costAmount: 2, costUnit: "usd" },
      });

      await callModel(tx, route, buildCompiledContext(), { foo: "bar" });

      const eventRow = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_completed")),
      });
      expect(eventRow).toBeDefined();
      // Fix round 1 (independent review, Important #1): runId/taskInstanceId
      // must be the real, non-null ids — a null runId here would put this
      // event in emit.ts's shared GLOBAL sequence bucket instead of the
      // per-run one, breaking per-run ordering queries.
      expect(eventRow!.runId).toBe(runId);
      expect(eventRow!.taskInstanceId).toBe(taskInstanceId);
      expect(eventRow!.tokensIn).toBe(120);
      expect(eventRow!.tokensOut).toBe(40);
      expect(eventRow!.cacheHit).toBe(false);
      expect(Number(eventRow!.costAmount)).toBe(2);
      expect(eventRow!.modelId).toBe(route.modelId);
    });
  });

  it("invocation_completed's sequenceNo is scoped to the real per-run counter, not the shared null-runId bucket (regression guard for Important #1)", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      vi.mocked(callAnthropicModel).mockResolvedValueOnce({
        result: {},
        usage: { tokensIn: 1, tokensOut: 1, costAmount: 0.001, costUnit: "usd" },
      });
      await callModel(tx, route, buildCompiledContext(), {});

      // Both invocation_started (Pass 1) and invocation_completed (Pass 3)
      // must share ONE per-run monotonic sequence — that's only possible if
      // neither has a null runId.
      const rows = await tx.query.events.findMany({
        where: eq(schema.events.runId, runId),
        orderBy: (events, { asc }) => [asc(events.sequenceNo)],
      });
      // budget_consumed (spec §8.5) is written by the reconcile, in the same run sequence.
      expect(rows.map((r) => r.eventType)).toEqual(["invocation_started", "budget_consumed", "invocation_completed"]);
      expect(rows.map((r) => r.sequenceNo)).toEqual([1, 2, 3]);
    });
  });

  it("on a thrown provider error, propagates the error and does NOT emit invocation_completed or reconcile budget (pre-dispatch ruling point 3)", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      const beforeCall = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });

      vi.mocked(callAnthropicModel).mockRejectedValueOnce(new Error("provider boom"));

      await expect(callModel(tx, route, buildCompiledContext(), {})).rejects.toThrow(/provider boom/);

      // No invocation_completed event: callModel does not emit on failure —
      // that is the future Unit 6 Executor's uniform responsibility, not
      // this module's (see modelRouter.ts's header).
      const eventRow = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_completed")),
      });
      expect(eventRow).toBeUndefined();

      // No reconciliation: reserved_amount/consumed_amount unchanged from
      // right after authorizeRoute's reservation.
      const afterCall = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(afterCall!.reservedAmount).toBe(beforeCall!.reservedAmount);
      expect(afterCall!.consumedAmount).toBe(beforeCall!.consumedAmount);
    });
  });
});

// ---------------------------------------------------------------------------
// The full routing decision on invocation_started (brief's required test)
// ---------------------------------------------------------------------------

describe("authorizeRoute invocation_started event", () => {
  it("captures the full routing decision as structured payload, correlated to runId/taskInstanceId/invocationId", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const req = buildRequest({
        runId,
        taskInstanceId,
        invocationId,
        taskDifficulty: "complex",
        riskTier: "medium",
      });
      const route = await authorizeRoute(tx, req);
      assertAuthorized(route);

      const eventRow = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_started")),
      });
      expect(eventRow).toBeDefined();
      expect(eventRow!.runId).toBe(runId);
      expect(eventRow!.taskInstanceId).toBe(taskInstanceId);
      expect(eventRow!.payload).toEqual({
        taskDifficulty: "complex",
        riskTier: "medium",
        contextBudgetMaxInputTokens: req.contextBudget.maxInputTokens,
        resultingTier: route.tier,
        resultingModelId: route.modelId,
      });
    });
  });

  it("is idempotent per invocationId (re-authorizing the same invocationId does not duplicate the event)", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "1000.00" });
      const req = buildRequest({ runId, taskInstanceId, invocationId });
      await authorizeRoute(tx, req);
      await authorizeRoute(tx, req);

      const rows = await tx.query.events.findMany({
        where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_started")),
      });
      expect(rows.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Structural decoupling from Policy/Approval (Unit 3) — the critical test
// ---------------------------------------------------------------------------

describe("Zero Policy/Approval coupling", () => {
  useApiPrimary();
  it("positive control: vi.spyOn on governance/policy.ts's namespace intercepts a REAL cross-module call", async () => {
    const spy = vi.spyOn(policyModule, "evaluatePolicy");
    try {
      await withRollback(async (tx) => {
        await callEvaluatePolicyForTest(tx);
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("authorizeRoute/callModel never call evaluatePolicy/createApproval/resolveApproval/reauthorize (spy-based)", async () => {
    const evaluatePolicySpy = vi.spyOn(policyModule, "evaluatePolicy");
    const createApprovalSpy = vi.spyOn(approvalsModule, "createApproval");
    const resolveApprovalSpy = vi.spyOn(approvalsModule, "resolveApproval");
    const reauthorizeSpy = vi.spyOn(approvalsModule, "reauthorize");

    try {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "1000.00" });
        // riskTier "highest" deliberately: this is exactly the case that
        // forces STRONG (a "high-risk action" per the brief's explicit
        // non-authorization test) — proving that even in this case, no
        // Approval is created/resolved/bypassed as a side effect of tier
        // selection.
        const route = await authorizeRoute(
          tx,
          buildRequest({ runId, taskInstanceId, invocationId, taskDifficulty: "simple", riskTier: "highest" })
        );
        assertAuthorized(route);
        expect(route.tier).toBe("STRONG");

        vi.mocked(callAnthropicModel).mockResolvedValueOnce({
          result: {},
          usage: { tokensIn: 10, tokensOut: 10, costAmount: 1, costUnit: "usd" },
        });
        await callModel(tx, route, buildCompiledContext(), {});
      });

      expect(evaluatePolicySpy).not.toHaveBeenCalled();
      expect(createApprovalSpy).not.toHaveBeenCalled();
      expect(resolveApprovalSpy).not.toHaveBeenCalled();
      expect(reauthorizeSpy).not.toHaveBeenCalled();
    } finally {
      evaluatePolicySpy.mockRestore();
      createApprovalSpy.mockRestore();
      resolveApprovalSpy.mockRestore();
      reauthorizeSpy.mockRestore();
    }
  });

  it("modelRouter.ts source contains no import of policy.ts/approvals.ts (structural backstop, matching policy.test.ts's own idiom)", () => {
    const routerPath = fileURLToPath(new URL("../../src/router/modelRouter.ts", import.meta.url));
    const source = readFileSync(routerPath, "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/from\s+["'].*\/(policy|approvals)\.js["']/);
    expect(code).not.toMatch(/\b(evaluatePolicy|createApproval|resolveApproval|reauthorize)\b/);
  });
});

// ---------------------------------------------------------------------------
// Provider SDK import isolation
// ---------------------------------------------------------------------------

describe("Provider SDK import isolation", () => {
  it("only src/router/providers/anthropic.ts and openai.ts import @anthropic-ai/sdk or openai", () => {
    const normalize = (p: string) => p.replace(/\\/g, "/");
    const roots = [
      fileURLToPath(new URL("../../src", import.meta.url)),
      fileURLToPath(new URL("../../tests", import.meta.url)),
    ];
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (/from\s+["'](@anthropic-ai\/sdk|openai)["']/.test(source)) {
          offenders.push(normalize(full));
        }
      }
    }
    for (const root of roots) walk(root);

    const expected = [
      normalize(path.join(roots[0]!, "router", "providers", "anthropic.ts")),
      normalize(path.join(roots[0]!, "router", "providers", "openai.ts")),
    ].sort();

    expect(offenders.sort()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Phase 7C — the quota guardrail's dispatch boundary
// ---------------------------------------------------------------------------

describe("quota guardrail integration", () => {
  /** Records a quota reading that WOULD close dispatch if the guardrail were on. */
  async function recordCriticalQuota(tx: DrizzleTransaction) {
    await recordQuotaObservation(
      tx,
      {
        provider: "claude_subscription",
        observedAt: new Date(),
        status: "allowed",
        overageStatus: "rejected",
        source: "rate_limit_event",
        fiveHour: { utilization: 0.99, resetsAt: null },
        sevenDay: { utilization: 0.99, resetsAt: null },
        observationCount: 1,
      },
      {
        idempotencyKey: `provider_quota_observed:${randomUUID()}:0`,
        causationId: null,
        correlation: {
          goalId: null,
          workflowRunId: null,
          taskInstanceId: null,
          runId: null,
          invocationId: null,
        },
        producer: "claude-subscription-provider",
      }
    );
  }

  it("is DISABLED by default: near-exhausted quota does not block authorization", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      await recordCriticalQuota(tx);

      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));

      // Unchanged pre-Phase-7C behaviour: authorization succeeds and the
      // invocation_started event is emitted exactly as before.
      assertAuthorized(route);
      const started = await tx.query.events.findFirst({
        where: eq(schema.events.invocationId, invocationId),
      });
      expect(started!.eventType).toBe("invocation_started");
    });
  });

  it("refuses dispatch and RELEASES the reservation when the guardrail closes", async () => {
    const spy = vi
      .spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail")
      .mockResolvedValue({ decision: { decision: "REFUSE_QUOTA", reason: "five_hour_upper" }, state: "CLOSED", changed: false });

    try {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));

        expect(route).toEqual({ authorized: false, reason: "quota_guardrail" });

        // Nothing was dispatched, so nothing may stay reserved.
        const counter = await tx.query.budgetCounters.findFirst({
          where: and(eq(schema.budgetCounters.scope, "run"), eq(schema.budgetCounters.scopeRefId, runId)),
        });
        expect(Number(counter!.reservedAmount)).toBe(0);
        expect(Number(counter!.consumedAmount)).toBe(0);

        // And no invocation was ever started.
        const eventRow = await tx.query.events.findFirst({
          where: eq(schema.events.invocationId, invocationId),
        });
        expect(eventRow).toBeUndefined();
      });
    } finally {
      spy.mockRestore();
    }

    // NO FALLBACK: a quota refusal never reaches another provider.
    expect(callAnthropicModel).not.toHaveBeenCalled();
    expect(callOpenAiModel).not.toHaveBeenCalled();
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
  });

  it("reports an explicit provider rejection distinctly from a threshold refusal", async () => {
    const spy = vi.spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail").mockResolvedValue({
      decision: { decision: "PROVIDER_REJECTED", reason: "status_not_allowed" },
      state: "OPEN",
      changed: false,
    });

    try {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
        expect(route).toEqual({ authorized: false, reason: "provider_quota_rejected" });
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("allows dispatch on UNKNOWN_ALLOWED, leaving the Budget Governor as the only control", async () => {
    const spy = vi.spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail").mockResolvedValue({
      decision: { decision: "UNKNOWN_ALLOWED", reason: "no_observation" },
      state: "OPEN",
      changed: false,
    });

    try {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
        assertAuthorized(route);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("budget denial still denies even when the guardrail allows (DENY remains DENY)", async () => {
    // ORDER CHANGED IN PHASE 7D: quota is now an input to candidate
    // ELIGIBILITY, and ranking must not reserve budget, so the guardrail is
    // consulted BEFORE the reservation rather than after it (7C had the
    // reverse, with a reserve-then-release path that no longer exists).
    //
    // What matters is unchanged and is what this test pins: the advisory
    // control cannot overturn the hard one. The guardrail allowing does not
    // make an unaffordable invocation authorized.
    const spy = vi.spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail").mockResolvedValue({
      decision: { decision: "ALLOW", reason: "below_threshold" },
      state: "OPEN",
      changed: false,
    });

    try {
      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, {
          limitAmount: "0.00",
          subscriptionTokenLimit: "0",
        });
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
        expect(route).toEqual({ authorized: false, reason: "insufficient_budget" });
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("ranks candidates BEFORE reserving, so ranking never costs budget", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedFixtureChain(tx, { limitAmount: "1000000" });

      const routing = await selectCandidates(tx, { tier: "CHEAP", runId });
      expect(routing.status).toBe("routed");

      // Candidate selection reserved nothing.
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scope, "run"), eq(schema.budgetCounters.scopeRefId, runId)),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(0);
    });
  });
});

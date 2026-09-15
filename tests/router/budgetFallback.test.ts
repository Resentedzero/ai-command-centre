/**
 * The Budget Governor's one fallback (Phase 4 downgrade/degrade, §5.0; values decided by the
 * operator 2026-09-15): a denied routed tier gets exactly one more attempt, one tier lower where
 * the risk and escalation floors allow (downgraded) or at the same tier (degraded), under a 75%
 * Context Budget, in the same resource unit; denied again, the route is refused. Providers mocked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { RouteRequest, RouteResult } from "../../src/router/types.js";
import type { LlmInvocationSpec } from "../../src/execution/types.js";

vi.mock("../../src/governance/dailyBudgetPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/governance/dailyBudgetPolicy.js")>()),
  DAILY_BUDGET_CEILINGS: Object.freeze({}),
}));
vi.mock("../../src/governance/runBudgetPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/governance/runBudgetPolicy.js")>()),
  TASK_INSTANCE_BUDGET_CEILINGS: Object.freeze({}),
}));
vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { authorizeRoute, degradedContextBudget, BUDGET_FALLBACK_CONTEXT_FACTOR } from "../../src/router/modelRouter.js";
import { providerCandidates } from "../../src/router/tierConfig.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { budgetOutcomeOf } from "../../src/api/budgetOutcome.js";
import { routeRecordOf } from "../../src/api/routeRecord.js";
import { executeRunToBoundary } from "../helpers/driveToBoundary.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const BUDGET: RouteRequest["contextBudget"] = {
  maxInputTokens: 100_000,
  maxArtifactTokens: 2_000,
  maxRetrievedItems: 50,
  maxToolSchemaTokens: 2_000,
  compressionThreshold: 2_000,
  freshnessRequirementSeconds: 30,
  expectedOutputTokens: 0,
};

async function seed(tx: DrizzleTransaction, subscriptionTokens: string, usd = "1000.00") {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "pending", input: {} })
    .returning();
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active" }).returning();
  const [invocation] = await tx
    .insert(schema.invocations)
    .values({ runId: run!.id, seqNo: 1, kind: "llm", costClass: "llm", status: "pending", idempotencyKey: `inv-${randomUUID()}` })
    .returning();
  await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, limitAmount: usd, reservedAmount: "0", consumedAmount: "0" });
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: subscriptionTokens,
    reservedAmount: "0",
    consumedAmount: "0",
  });
  return { runId: run!.id, taskInstanceId: taskInstance!.id, invocationId: invocation!.id };
}

const request = (ids: { runId: string; taskInstanceId: string; invocationId: string }, overrides: Partial<RouteRequest> = {}): RouteRequest => ({
  taskDifficulty: "standard",
  riskTier: "low",
  contextBudget: BUDGET,
  ...ids,
  ...overrides,
});

async function counter(tx: DrizzleTransaction, runId: string, unit: string) {
  return tx.query.budgetCounters.findFirst({ where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, unit)) });
}

async function runEvents(tx: DrizzleTransaction, runId: string, eventType: string) {
  return tx.query.events.findMany({ where: and(eq(schema.events.runId, runId), eq(schema.events.eventType, eventType)) });
}

function routed(route: RouteResult | { authorized: false }): RouteResult {
  if ("authorized" in route) throw new Error(`expected a route, got a refusal: ${JSON.stringify(route)}`);
  return route;
}

describe("degradedContextBudget", () => {
  it("tightens every bounded quantity to 75% rounded down, keeps positives at least 1 and zeros at zero, and leaves the rest", () => {
    expect(BUDGET_FALLBACK_CONTEXT_FACTOR).toBe(0.75);
    expect(degradedContextBudget(BUDGET)).toEqual({ ...BUDGET, maxInputTokens: 75_000, maxArtifactTokens: 1_500, maxRetrievedItems: 37, maxToolSchemaTokens: 1_500, expectedOutputTokens: 0 });
    expect(
      degradedContextBudget({ maxInputTokens: 1, maxArtifactTokens: 0, maxRetrievedItems: 3, maxToolSchemaTokens: 2, compressionThreshold: 10, freshnessRequirementSeconds: 5, expectedOutputTokens: 1 })
    ).toEqual({ maxInputTokens: 1, maxArtifactTokens: 0, maxRetrievedItems: 2, maxToolSchemaTokens: 1, compressionThreshold: 10, freshnessRequirementSeconds: 5, expectedOutputTokens: 1 });
    // The configured budget object is never changed.
    expect(BUDGET.maxInputTokens).toBe(100_000);
  });
});

describe("authorizeRoute budget fallback", () => {
  it("downgraded: MID denied, CHEAP authorized under the 75% budget, recorded as a budget downgrade", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "80000");
      const route = routed(await authorizeRoute(tx, request(ids)));
      expect(route).toMatchObject({ tier: "CHEAP", modelId: "claude-haiku-4-5-20251001", effectiveMaxInputTokens: 75_000 });
      expect(route.contextBudget).toEqual(degradedContextBudget(BUDGET));

      const [started] = await runEvents(tx, ids.runId, "invocation_started");
      expect(started!.payload).toMatchObject({
        defaultTier: "MID",
        tierSource: "budget_downgrade",
        resultingTier: "CHEAP",
        contextBudget: BUDGET,
        contextBudgetMaxInputTokens: 75_000,
        budgetAuthorization: { authorized: true, outcome: "downgraded", resourceUnit: "subscription_tokens", estimatedAmount: 75_000 },
        budgetFallback: {
          outcome: "downgraded",
          fromTier: "MID",
          attemptedTier: "CHEAP",
          authorized: true,
          contextBudgetFactor: 0.75,
          contextBudget: degradedContextBudget(BUDGET),
          deniedAuthorization: { authorized: false, outcome: "denied", modelId: "claude-sonnet-5", estimatedAmount: 100_000 },
        },
      });
      expect(await runEvents(tx, ids.runId, "budget_denied")).toHaveLength(1);
      expect((await counter(tx, ids.runId, "subscription_tokens"))!.reservedAmount).toBe("75000");

      // The read models show the runtime's record.
      expect(budgetOutcomeOf({ kind: "llm", costClass: "llm", status: "completed" }, { startedPayload: started!.payload, preDispatchChecked: false, approvalRequired: false })).toBe("downgraded");
      expect(routeRecordOf("llm", started!.payload, undefined)).toMatchObject({
        resultingTier: "CHEAP",
        tierSource: "budget_downgrade",
        budgetFallback: { outcome: "downgraded", fromTier: "MID", attemptedTier: "CHEAP", authorized: true, contextBudgetFactor: 0.75, maxInputTokens: 75_000 },
      });
    });
  });

  it("degraded: no tier below CHEAP, so the one attempt is CHEAP with the 75% budget; the tier source is unchanged", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "80000");
      const route = routed(await authorizeRoute(tx, request(ids, { taskDifficulty: "simple" })));
      expect(route.tier).toBe("CHEAP");
      const [started] = await runEvents(tx, ids.runId, "invocation_started");
      expect(started!.payload).toMatchObject({
        tierSource: "default",
        resultingTier: "CHEAP",
        budgetAuthorization: { outcome: "degraded", estimatedAmount: 75_000 },
        budgetFallback: { outcome: "degraded", fromTier: "CHEAP", attemptedTier: "CHEAP" },
      });
      expect(budgetOutcomeOf({ kind: "llm", costClass: "llm", status: "completed" }, { startedPayload: started!.payload, preDispatchChecked: false, approvalRequired: false })).toBe("degraded");
    });
  });

  it("never goes below the risk floor: high risk stays STRONG and degrades", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "80000");
      const route = routed(await authorizeRoute(tx, request(ids, { riskTier: "high" })));
      expect(route.tier).toBe("STRONG");
      expect(route.contextBudget.maxInputTokens).toBe(75_000);
      const [started] = await runEvents(tx, ids.runId, "invocation_started");
      expect(started!.payload).toMatchObject({ budgetAuthorization: { outcome: "degraded" }, budgetFallback: { fromTier: "STRONG", attemptedTier: "STRONG" } });
    });
  });

  it("never goes below a retry's escalation floor: a MID floor degrades at MID", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "80000");
      await tx.update(schema.runs).set({ minimumModelTier: "MID", attempt: 2 }).where(eq(schema.runs.id, ids.runId));
      const route = routed(await authorizeRoute(tx, request(ids, { taskDifficulty: "simple" })));
      expect(route.tier).toBe("MID");
      const [started] = await runEvents(tx, ids.runId, "invocation_started");
      expect(started!.payload).toMatchObject({ tierSource: "escalation_floor", budgetAuthorization: { outcome: "degraded" } });
    });
  });

  it("denied: the one fallback is refused too, so the route is refused, nothing is reserved, and no third attempt is made", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "50000");
      const refusal = await authorizeRoute(tx, request(ids, { riskTier: "medium" }));
      expect(refusal).toMatchObject({
        authorized: false,
        reason: "insufficient_budget",
        decision: {
          attemptedTier: "MID",
          budgetAuthorization: { authorized: false, outcome: "denied", modelId: "claude-sonnet-5", estimatedAmount: 100_000 },
          budgetFallback: { outcome: "denied", attemptedOutcome: "downgraded", attemptedTier: "CHEAP", authorized: false, refusal: "insufficient_budget", estimatedAmount: 75_000 },
        },
      });
      expect(await runEvents(tx, ids.runId, "invocation_started")).toHaveLength(0);
      expect(await runEvents(tx, ids.runId, "budget_denied")).toHaveLength(2);
      expect((await counter(tx, ids.runId, "subscription_tokens"))!.reservedAmount).toBe("0");
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();

      const failedPayload = { reason: "insufficient_budget", routingDecision: (refusal as { decision: unknown }).decision };
      expect(budgetOutcomeOf({ kind: "llm", costClass: "llm", status: "failed" }, { failedPayload, preDispatchChecked: false, approvalRequired: false })).toBe("denied");
      expect(routeRecordOf("llm", undefined, failedPayload)).toMatchObject({ resultingTier: null, attemptedTier: "MID", budgetFallback: { attemptedTier: "CHEAP", authorized: false } });
    });
  });

  it("never switches resource unit: with no subscription candidate at the lower tier, it does not fall back to billed usd", async () => {
    const cheapSubscription = providerCandidates.find((c) => c.provider === "claude_subscription" && c.tiers.includes("CHEAP"))!;
    cheapSubscription.enabled = false;
    try {
      await withRollback(async (tx) => {
        const ids = await seed(tx, "80000", "1000.00");
        const refusal = await authorizeRoute(tx, request(ids));
        expect(refusal).toMatchObject({
          authorized: false,
          reason: "insufficient_budget",
          decision: { budgetFallback: { attemptedTier: "CHEAP", authorized: false } },
        });
        // The billed usd CHEAP candidate was excluded for its unit, not tried.
        const fallback = (refusal as unknown as { decision: { budgetFallback: { excludedCandidates: { provider: string; reason: string }[] } } }).decision.budgetFallback;
        expect(fallback.excludedCandidates).toContainEqual(expect.objectContaining({ provider: "anthropic", reason: "resource_mismatch" }));
        expect((await counter(tx, ids.runId, "usd"))!.reservedAmount).toBe("0");
      });
    } finally {
      cheapSubscription.enabled = true;
    }
  });
});

describe("the Executor compiles to the degraded budget", () => {
  it("records the tightened input ceiling on context_compiled and completes on the downgraded route", async () => {
    await withRollback(async (tx) => {
      const ids = await seed(tx, "8000");
      const spec: LlmInvocationSpec = {
        kind: "llm",
        costClass: "llm",
        intent: "synthesize",
        candidateArtifactIds: [],
        candidateToolCapabilityIds: [],
        contextBudget: { ...BUDGET, maxInputTokens: 10_000, expectedOutputTokens: 100 },
        taskDifficulty: "standard",
        riskTier: "low",
        expectedOutputShape: {},
      };
      await tx.delete(schema.invocations).where(eq(schema.invocations.id, ids.invocationId));
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { text: "hi" },
        usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
      });

      expect(await executeRunToBoundary(tx, ids.runId, [spec])).toEqual({ status: "completed", runId: ids.runId });
      const [compiled] = await runEvents(tx, ids.runId, "context_compiled");
      expect(compiled!.payload).toMatchObject({ maxInputTokens: 7_500, taskMaxInputTokens: 10_000, effectiveMaxInputTokens: 7_500, budgetOutcome: "downgraded" });
      const [started] = await runEvents(tx, ids.runId, "invocation_started");
      expect(started!.payload).toMatchObject({ resultingTier: "CHEAP", budgetAuthorization: { outcome: "downgraded", estimatedAmount: 7_575 } });
    });
  });
});

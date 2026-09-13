/**
 * DAY budget containment through the REAL production path (Phase 8).
 *
 * `tests/governance/dailyBudget.test.ts` proves the Budget Governor directly.
 * This file proves it is actually reached by live execution: two independent,
 * fully-funded Runs driven through `executeRun` -> `authorizeRoute` ->
 * `reserveBudget`, where the second is refused only because the shared day is
 * exhausted.
 *
 * The daily-budget policy module is mocked to supply a ceiling, because the
 * shipped configuration is deliberately empty. That mock is file-wide, which is
 * why this lives apart from the inert-by-default unit tests.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/governance/dailyBudgetPolicy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/governance/dailyBudgetPolicy.js")>();
  return { ...original, DAILY_BUDGET_CEILINGS: Object.freeze({ subscription_tokens: "1500" }) };
});
vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

// Phase 9: executeRun yields at each LLM Invocation; this drives it to the next
// real boundary exactly as the production driver does. See the helper's header.
import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { dayScopeRef } from "../../src/governance/dailyBudgetPolicy.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedFundedRun(tx: DrizzleTransaction) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "pending", input: {} })
    .returning();
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active" }).returning();
  // Each run is independently funded well above what either invocation needs.
  for (const [unit, limit] of [
    ["usd", "1000.00"],
    ["subscription_tokens", "200000"],
  ] as const) {
    await tx.insert(schema.budgetCounters).values({
      scope: "run",
      scopeRefId: run!.id,
      resourceUnit: unit,
      limitAmount: limit,
      reservedAmount: "0",
      consumedAmount: "0",
    });
  }
  return run!.id;
}

/** Worst-case reservation = 1000 input + 50 output = 1050 subscription tokens. */
function llmSpec() {
  return {
    kind: "llm" as const,
    costClass: "llm" as const,
    intent: "synthesize" as const,
    candidateArtifactIds: [],
    candidateToolCapabilityIds: [],
    contextBudget: {
      maxInputTokens: 1_000,
      maxArtifactTokens: 500,
      maxRetrievedItems: 5,
      maxToolSchemaTokens: 500,
      compressionThreshold: 500,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 50,
    },
    taskDifficulty: "simple" as const,
    riskTier: "low" as const,
    expectedOutputShape: { sum: "number" },
  };
}

describe("the day scope binds live execution across runs", () => {
  it("refuses a second fully-funded run once the shared day is spent, without falling back to the API", async () => {
    await withRollback(async (tx) => {
      const first = await seedFundedRun(tx);
      const second = await seedFundedRun(tx);

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValue({
        result: { sum: 50 },
        usage: { tokensIn: 700, tokensOut: 200, costAmount: 900, costUnit: "subscription_tokens" },
      });

      // Day 1500: reserve 1050, reconcile 900 consumed -> 600 left.
      expect((await executeRun(tx, first, [llmSpec()])).status).toBe("completed");

      // The second run's OWN counter has 200000 available, but it needs 1050
      // and the day has only 600.
      expect((await executeRun(tx, second, [llmSpec()])).status).toBe("failed");

      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      expect(callAnthropicModel).not.toHaveBeenCalled();

      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.runId, second), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed!.payload).toMatchObject({ reason: "insufficient_budget" });

      const day = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scope, "day"),
          eq(schema.budgetCounters.scopeRefId, dayScopeRef(new Date())),
          eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
        ),
      });
      expect(day!.limitAmount).toBe("1500");
      expect(day!.consumedAmount).toBe("900");
      expect(day!.reservedAmount).toBe("0");

      // The refused run's own counter never moved, and no USD was touched.
      const secondTokens = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, second),
          eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
        ),
      });
      expect(secondTokens!.reservedAmount).toBe("0");
      expect(secondTokens!.consumedAmount).toBe("0");
    });
  });
});

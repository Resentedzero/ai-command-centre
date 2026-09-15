/**
 * Task Instance budget containment through the REAL production path (operator decision
 * D20, 2026-09-15), with the SHIPPED ceilings: no policy module is mocked.
 *
 * `tests/governance/taskInstanceBudget.test.ts` proves the Budget Governor directly. This
 * file proves live execution reaches it: two attempts of ONE Task Instance, each on a
 * fully funded Run, driven through `executeRun` -> `authorizeRoute` -> `reserveBudget`,
 * where the second is refused only because the Task Instance's 50,000
 * subscription_tokens are spent. The day (200,000) and each Run (200,000) still have room.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
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

/** One Task Instance with two attempts, each Run funded well above one call. */
async function seedTwoAttempts(tx: DrizzleTransaction) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "active", input: {} })
    .returning();
  const runIds: string[] = [];
  for (const attempt of [1, 2]) {
    const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active", attempt }).returning();
    for (const [resourceUnit, limitAmount] of [
      ["usd", "1000.00"],
      ["subscription_tokens", "200000"],
    ] as const) {
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, resourceUnit, limitAmount, reservedAmount: "0", consumedAmount: "0" });
    }
    runIds.push(run!.id);
  }
  return { taskInstanceId: taskInstance!.id, first: runIds[0]!, second: runIds[1]! };
}

/** Worst-case reservation = 30000 input + 1000 output = 31000 subscription tokens. */
function llmSpec() {
  return {
    kind: "llm" as const,
    costClass: "llm" as const,
    intent: "synthesize" as const,
    candidateArtifactIds: [],
    candidateToolCapabilityIds: [],
    contextBudget: {
      maxInputTokens: 30_000,
      maxArtifactTokens: 500,
      maxRetrievedItems: 5,
      maxToolSchemaTokens: 500,
      compressionThreshold: 500,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 1_000,
    },
    taskDifficulty: "simple" as const,
    riskTier: "low" as const,
    expectedOutputShape: { sum: "number" },
  };
}

async function tokens(tx: DrizzleTransaction, scope: "run" | "task_instance" | "day", scopeRefId: string) {
  return tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scope, scope), eq(schema.budgetCounters.scopeRefId, scopeRefId), eq(schema.budgetCounters.resourceUnit, "subscription_tokens")),
  });
}

describe("the Task Instance counter binds live execution across its attempts", () => {
  it("refuses a second fully funded attempt once the Task's 50,000 tokens are spent, without falling back to the API", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, first, second } = await seedTwoAttempts(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValue({
        result: { sum: 50 },
        usage: { tokensIn: 25_000, tokensOut: 5_000, costAmount: 30_000, costUnit: "subscription_tokens" },
      });

      // Task 50000: reserve 31000, reconcile 30000 consumed -> 20000 left.
      expect((await executeRun(tx, first, [llmSpec()])).status).toBe("completed");
      // The second attempt's own Run has 200000 and the day 170000, but the Task has 20000.
      expect((await executeRun(tx, second, [llmSpec()])).status).toBe("failed");

      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      expect(callAnthropicModel).not.toHaveBeenCalled();
      expect(callOpenAiModel).not.toHaveBeenCalled();

      const failed = await tx.query.events.findFirst({ where: and(eq(schema.events.runId, second), eq(schema.events.eventType, "invocation_failed")) });
      expect(failed!.payload).toMatchObject({ reason: "insufficient_budget" });
      const denied = await tx.query.events.findFirst({ where: and(eq(schema.events.runId, second), eq(schema.events.eventType, "budget_denied")) });
      expect((denied!.payload as { deniedCounter: unknown }).deniedCounter).toMatchObject({ scope: "task_instance", scopeRefId: taskInstanceId, limitAmount: "50000" });

      expect(await tokens(tx, "task_instance", taskInstanceId)).toMatchObject({ limitAmount: "50000", consumedAmount: "30000", reservedAmount: "0" });
      expect(await tokens(tx, "day", dayScopeRef(new Date()))).toMatchObject({ limitAmount: "200000", consumedAmount: "30000", reservedAmount: "0" });
      expect(await tokens(tx, "run", second)).toMatchObject({ consumedAmount: "0", reservedAmount: "0" });
      // No USD counter above the Run was touched: units stay separate.
      expect(await tx.query.budgetCounters.findFirst({ where: and(eq(schema.budgetCounters.scope, "task_instance"), eq(schema.budgetCounters.resourceUnit, "usd")) })).toBeUndefined();
    });
  });
});

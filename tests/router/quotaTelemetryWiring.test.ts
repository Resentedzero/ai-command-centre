/**
 * Quota telemetry wiring (Phase 8 — closes B-3).
 *
 * Before Phase 8 the subscription adapter returned a quota observation and
 * nothing recorded it, so `subscription_quota_state` was permanently empty in
 * production and the guardrail could never have acted even if enabled.
 *
 * Driven through the REAL `executeRun` -> `authorizeRoute` -> `callModel` path
 * against real Postgres; only the provider's own call is mocked. Asserts the
 * flow the operator specified:
 *
 *   provider result/error -> quota observation -> record -> invocation outcome
 *
 * and, just as importantly, what telemetry must NEVER do: touch budget
 * counters, decide the invocation's outcome, or enable the guardrail.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { QuotaObservation } from "../../src/governance/subscriptionQuotaState.js";
import * as subscriptionQuotaStateModule from "../../src/governance/subscriptionQuotaState.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { executeRun } from "../../src/execution/executor.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { quotaGuardrailConfig } from "../../src/governance/quotaGuardrail.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function observation(overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    provider: "claude_subscription",
    observedAt: new Date("2026-09-13T20:00:00.000Z"),
    status: "allowed",
    overageStatus: "rejected",
    source: "rate_limit_event",
    fiveHour: { utilization: 0.42, resetsAt: "2026-09-13T22:30:00.000Z" },
    sevenDay: { utilization: 0.18, resetsAt: "2026-09-20T03:00:00.000Z" },
    observationCount: 1,
    ...overrides,
  };
}

const USAGE = { tokensIn: 40, tokensOut: 10, costAmount: 50, costUnit: "subscription_tokens" as const };

async function seedRun(tx: DrizzleTransaction) {
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

async function eventsFor(tx: DrizzleTransaction, runId: string) {
  return tx.select().from(schema.events).where(eq(schema.events.runId, runId));
}

async function counter(tx: DrizzleTransaction, runId: string, unit: "usd" | "subscription_tokens") {
  return tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, unit)),
  });
}

describe("success path", () => {
  it("records the observation in the same transaction, before invocation completion, caused by invocation_started", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: USAGE,
        quotaObservation: observation(),
      });

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("completed");

      const rows = await eventsFor(tx, runId);
      const observed = rows.find((r) => r.eventType === "provider_quota_observed");
      const started = rows.find((r) => r.eventType === "invocation_started");
      const completed = rows.find((r) => r.eventType === "invocation_completed");

      expect(observed).toBeDefined();
      expect(observed!.invocationId).toBe(completed!.invocationId);
      expect(observed!.causationId).toBe(started!.id);
      // provider result -> observation -> record -> completion
      expect(observed!.sequenceNo).toBeLessThan(completed!.sequenceNo);
      // Telemetry carries no usage envelope.
      expect(observed!.costAmount).toBeNull();
      expect(observed!.costUnit).toBeNull();

      const state = await tx.query.subscriptionQuotaState.findFirst({
        where: eq(schema.subscriptionQuotaState.provider, "claude_subscription"),
      });
      expect(Number(state!.fiveHourUtilization)).toBe(0.42);
      expect(state!.observationEventId).toBe(observed!.id);
    });
  });

  it("writes nothing when the provider supplied no observation", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({ result: { sum: 50 }, usage: USAGE });

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("completed");

      expect((await eventsFor(tx, runId)).some((r) => r.eventType === "provider_quota_observed")).toBe(false);
      expect(await tx.select().from(schema.subscriptionQuotaState)).toHaveLength(0);
    });
  });

  it("never touches budget counters: tokens reconcile from usage, not from utilization", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: USAGE,
        // A near-exhaustion reading must not bleed into accounting.
        quotaObservation: observation({ fiveHour: { utilization: 0.99, resetsAt: null } }),
      });

      await executeRun(tx, runId, [llmSpec()]);

      const tokens = await counter(tx, runId, "subscription_tokens");
      expect(Number(tokens!.consumedAmount)).toBe(50); // exactly the reported usage
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect(Number(tokens!.limitAmount)).toBe(200000);
      const usd = await counter(tx, runId, "usd");
      expect(Number(usd!.consumedAmount)).toBe(0);
      expect(Number(usd!.reservedAmount)).toBe(0);
    });
  });

  it("a malformed reading cannot fail a completed invocation — only the telemetry write is dropped", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: USAGE,
        quotaObservation: observation({ fiveHour: { utilization: Number.NaN, resetsAt: null } }),
      });

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("completed");

      expect((await eventsFor(tx, runId)).some((r) => r.eventType === "provider_quota_observed")).toBe(false);
      expect(logged).toHaveBeenCalled();
      expect(Number((await counter(tx, runId, "subscription_tokens"))!.consumedAmount)).toBe(50);
    });
  });

  it("a real DATABASE error in the telemetry write rolls back only its savepoint — the invocation completes", async () => {
    // The case the savepoint actually exists for. A NaN reading throws in
    // plain code before any SQL runs; this forces a genuine Postgres error
    // inside the savepoint, which without it would abort the whole transaction.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(subscriptionQuotaStateModule, "recordQuotaObservation").mockImplementation(async (savepoint) => {
      await savepoint.execute(sql`select * from phase8_definitely_missing_table`);
      return undefined as never;
    });

    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: USAGE,
        quotaObservation: observation(),
      });

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("completed");

      // The transaction was not aborted: the later writes all landed.
      const tokens = await counter(tx, runId, "subscription_tokens");
      expect(Number(tokens!.consumedAmount)).toBe(50);
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect((await eventsFor(tx, runId)).some((r) => r.eventType === "invocation_completed")).toBe(true);
      expect(logged).toHaveBeenCalled();
    });
  });

  it("a rolled-back invocation leaves neither the observation event nor the projection behind", async () => {
    let runId = "";
    await withRollback(async (tx) => {
      runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: USAGE,
        quotaObservation: observation(),
      });
      await executeRun(tx, runId, [llmSpec()]);
    });

    const leaked = await testDb
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.runId, runId), eq(schema.events.eventType, "provider_quota_observed")));
    expect(leaked).toHaveLength(0);
    expect(await testDb.select().from(schema.subscriptionQuotaState)).toHaveLength(0);
  });
});

describe("failure path", () => {
  it("records telemetry carried by a provider failure, then fails the invocation and releases the hold", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      const failure = Object.assign(new Error("usage limit reached"), {
        quotaObservation: observation({ fiveHour: { utilization: 1, resetsAt: null } }),
      });
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(failure);

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("failed");

      const rows = await eventsFor(tx, runId);
      expect(rows.some((r) => r.eventType === "provider_quota_observed")).toBe(true);
      expect(rows.some((r) => r.eventType === "invocation_failed")).toBe(true);

      const tokens = await counter(tx, runId, "subscription_tokens");
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect(Number(tokens!.consumedAmount)).toBe(0);
    });
  });

  it("records nothing for a failure that carries no telemetry", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(new Error("cli crashed"));

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("failed");
      expect((await eventsFor(tx, runId)).some((r) => r.eventType === "provider_quota_observed")).toBe(false);
    });
  });

  it("a provider failure never falls back to the API and is never retried", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(
        Object.assign(new Error("quota exhausted"), { quotaObservation: observation() })
      );

      await executeRun(tx, runId, [llmSpec()]);

      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      expect(callAnthropicModel).not.toHaveBeenCalled();
    });
  });
});

describe("resource-unit guard", () => {
  it("refuses to reconcile usage reported in a different unit than the route reserved", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      // A subscription route whose provider claims to have spent DOLLARS.
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { sum: 50 },
        usage: { tokensIn: 40, tokensOut: 10, costAmount: 50, costUnit: "usd" },
      });

      expect((await executeRun(tx, runId, [llmSpec()])).status).toBe("failed");

      // Neither counter absorbed the mislabelled amount.
      const tokens = await counter(tx, runId, "subscription_tokens");
      expect(Number(tokens!.consumedAmount)).toBe(0);
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect(Number((await counter(tx, runId, "usd"))!.consumedAmount)).toBe(0);
    });
  });
});

describe("guardrail stays inert", () => {
  it("recording observations does not enable the quota guardrail", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValue({
        result: { sum: 50 },
        usage: USAGE,
        quotaObservation: observation({ fiveHour: { utilization: 1, resetsAt: null } }),
      });

      // Two back-to-back invocations at 100% utilization: with the guardrail
      // disabled, the second still dispatches.
      expect((await executeRun(tx, runId, [llmSpec(), llmSpec()])).status).toBe("completed");
      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(2);
      expect(quotaGuardrailConfig.claude_subscription!.enabled).toBe(false);
    });
  });
});

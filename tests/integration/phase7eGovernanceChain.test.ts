/**
 * PHASE 7E — end-to-end validation of the complete provider governance chain.
 *
 * This drives the REAL runtime path against a real database:
 *
 *   executeRun -> candidate routing -> Capability/Policy -> Budget Governor
 *              -> quota guardrail -> provider dispatch -> usage accounting
 *              -> events
 *
 * WHAT IS REAL AND WHAT IS NOT — stated plainly, because the distinction is
 * the whole value of this file. Every layer above is the production module,
 * executed for real, against real Postgres, with real transactions and real
 * event writes. The ONLY stub is the outermost boundary: the provider's network
 * call itself, which is mocked so the suite never spawns the Claude CLI or
 * spends subscription entitlement on `npm test`. Live Max behaviour is
 * established separately, once, in `benchmark/raw/phase7e-max-readiness.json`.
 *
 * Updated by Phase 7F: the routed primary is now `claude_subscription`, so
 * these tests assert token accounting. Updated by Phase 7G: two tests drive the
 * quota guardrail through injected decisions, since it ships disabled.
 *
 * This file adds no invariant the unit suites do not already assert
 * individually; its job is to prove they hold TOGETHER, in one run, through the
 * real Executor rather than through a router called directly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { tierConfig, providerCandidates } from "../../src/router/tierConfig.js";
import type { CapabilityPermission } from "../../src/governance/policy.js";
import * as quotaGuardrailModule from "../../src/governance/quotaGuardrail.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { executeRun } from "../../src/execution/executor.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

// Without this, "was never dispatched" assertions would see the PREVIOUS
// test's call and fail (or, worse, pass for the wrong reason).
afterEach(() => {
  vi.clearAllMocks();
});

const PERMISSION: CapabilityPermission = "READ";

/** A complete, FK-valid governance chain: Capability -> Grant -> Binding -> Run. */
async function seedChain(tx: DrizzleTransaction) {
  const [capability] = await tx
    .insert(schema.capabilities)
    .values({ name: "cap-" + randomUUID(), staticRiskTag: "low" })
    .returning();
  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 })
    .returning();
  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "validator", objective: "7E", instructions: "n/a" })
    .returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
    capabilityId: capability!.id,
    permissions: [PERMISSION],
    maxTrustLevelRequired: 1,
    autonomyState: "AUTONOMOUS",
  });

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
    .values({
      taskInstanceId: taskInstance!.id,
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      status: "active",
    })
    .returning();
  // BOTH counters, exactly as production provisioning now creates them
  // (`provisionRunBudgets`, one counter per unit). Independent ceilings in
  // independent units — the token limit is not derived from the dollar one.
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "usd",
    limitAmount: "1000.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: "200000",
    reservedAmount: "0",
    consumedAmount: "0",
  });

  return {
    runId: run!.id,
    taskInstanceId: taskInstance!.id,
    capabilityId: capability!.id,
    toolBindingId: toolBinding!.id,
  };
}

/** The tiny deterministic task: 17 + 33 = 50. */
const TASK_ANSWER = { sum: 50 };

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

async function eventsForRun(tx: DrizzleTransaction, runId: string) {
  return tx
    .select()
    .from(schema.events)
    .where(eq(schema.events.runId, runId))
    .orderBy(asc(schema.events.sequenceNo));
}

// ---------------------------------------------------------------------------

describe("production defaults (updated by Phase 7F — Claude Max is primary)", () => {
  it("records the primary candidates as claude_subscription/subscription_tokens for both tiers", () => {
    expect(tierConfig.CHEAP).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(tierConfig.CHEAP.accounting.unit).toBe("subscription_tokens");
    expect(tierConfig.STRONG).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-opus-5",
    });
    expect(tierConfig.STRONG.accounting.unit).toBe("subscription_tokens");
  });

  it("keeps the API candidates configured and USD-accounted, ranked below Max", () => {
    const api = providerCandidates.filter((c) => c.provider === "anthropic");
    expect(api).toHaveLength(2);
    expect(api.every((c) => c.enabled && c.accounting.unit === "usd")).toBe(true);
  });
});

describe("Phase 7E — end-to-end governance chain", () => {
  it("runs one LLM invocation through the whole chain, with correct routing, accounting and events", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedChain(tx);

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: TASK_ANSWER,
        usage: { tokensIn: 40, tokensOut: 10, costAmount: 50, costUnit: "subscription_tokens" },
      });

      const outcome = await executeRun(tx, runId, [llmSpec()]);
      expect(outcome.status).toBe("completed");

      // --- ROUTING ---------------------------------------------------------
      // The configured primary (Claude Max) was selected, and the API candidate
      // ranked below it was NOT attempted — being configured is not being a
      // fallback.
      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      expect(callAnthropicModel).not.toHaveBeenCalled();
      expect(callOpenAiModel).not.toHaveBeenCalled();
      expect(vi.mocked(callClaudeSubscriptionModel).mock.calls[0]![0]).toBe("claude-haiku-4-5-20251001");

      // --- EVENTS ----------------------------------------------------------
      const rows = await eventsForRun(tx, runId);
      const types = rows.map((r) => r.eventType);
      expect(types).toContain("invocation_started");
      expect(types).toContain("invocation_completed");
      expect(types).not.toContain("invocation_failed");

      const started = rows.find((r) => r.eventType === "invocation_started")!;
      // The routing decision is carried on invocation_started — no separate
      // routing event type was invented for this validation.
      expect(started.payload).toMatchObject({
        resultingTier: "CHEAP",
        resultingModelId: "claude-haiku-4-5-20251001",
      });
      expect(started.costUnit).toBeNull();

      const completed = rows.find((r) => r.eventType === "invocation_completed")!;
      expect(completed.costUnit).toBe("subscription_tokens");
      expect(Number(completed.costAmount)).toBe(50);
      expect(completed.modelId).toBe("claude-haiku-4-5-20251001");
      // Ordering is monotonic per run, and completion follows start.
      expect(completed.sequenceNo).toBeGreaterThan(started.sequenceNo);

      // --- BUDGET / ACCOUNTING ---------------------------------------------
      const tokens = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
        ),
      });
      // Reserved worst-case, then reconciled to ACTUAL: reservation released,
      // consumption recorded — in TOKENS.
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect(Number(tokens!.consumedAmount)).toBe(50);

      // The USD counter is completely untouched. A Max invocation neither
      // reserves nor consumes dollars — no conversion exists in either
      // direction.
      const usd = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(usd!.reservedAmount)).toBe(0);
      expect(Number(usd!.consumedAmount)).toBe(0);
      expect(Number(usd!.limitAmount)).toBe(1000);

      // --- QUOTA SEPARATION -------------------------------------------------
      // No quota state was written or consulted into accounting: an API
      // invocation produces no provider quota observation at all.
      const quotaState = await tx.select().from(schema.subscriptionQuotaState);
      expect(quotaState).toHaveLength(0);
      expect(types).not.toContain("provider_quota_observed");
      expect(types).not.toContain("quota_guardrail_state_changed");
    });
  });

  it("keeps Capability/Policy authoritative for a tool invocation in the same run", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId } = await seedChain(tx);

      const toolSpec = {
        kind: "tool" as const,
        costClass: "metered_api" as const,
        capabilityId,
        toolBindingId,
        permission: PERMISSION,
        proposedActionSnapshot: { action: "read-thing" },
        estimatedCost: 1,
        execute: vi.fn(async () => ({ ok: true })),
      };

      const outcome = await executeRun(tx, runId, [toolSpec]);
      expect(outcome.status).toBe("completed");
      expect(toolSpec.execute).toHaveBeenCalledTimes(1);

      // The invocation row records WHICH capability/permission was exercised —
      // routing never substitutes for that.
      const invocation = await tx.query.invocations.findFirst({
        where: eq(schema.invocations.runId, runId),
      });
      expect(invocation!.capabilityId).toBe(capabilityId);
      expect(invocation!.permission).toBe(PERMISSION);
    });
  });

  it("runs a MID invocation through the same chain: Sonnet, subscription_tokens, no USD", async () => {
    // Phase 7H. `taskDifficulty: "standard"` selects MID, which must travel the
    // identical governance path — no Sonnet-specific routing, budget or
    // authorization anywhere.
    await withRollback(async (tx) => {
      const { runId } = await seedChain(tx);

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: TASK_ANSWER,
        usage: { tokensIn: 60, tokensOut: 20, costAmount: 80, costUnit: "subscription_tokens" },
      });

      const outcome = await executeRun(tx, runId, [{ ...llmSpec(), taskDifficulty: "standard" as const }]);
      expect(outcome.status).toBe("completed");

      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      expect(vi.mocked(callClaudeSubscriptionModel).mock.calls[0]![0]).toBe("claude-sonnet-5");
      expect(callAnthropicModel).not.toHaveBeenCalled();

      const started = (await eventsForRun(tx, runId)).find((r) => r.eventType === "invocation_started")!;
      expect(started.payload).toMatchObject({
        resultingTier: "MID",
        resultingModelId: "claude-sonnet-5",
      });

      const completed = (await eventsForRun(tx, runId)).find((r) => r.eventType === "invocation_completed")!;
      expect(completed.costUnit).toBe("subscription_tokens");
      expect(Number(completed.costAmount)).toBe(80);

      // Reconciled in TOKENS against the shared per-run subscription counter —
      // there is no Sonnet-specific budget, and no dollars moved.
      const tokens = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
        ),
      });
      expect(Number(tokens!.reservedAmount)).toBe(0);
      expect(Number(tokens!.consumedAmount)).toBe(80);
      expect(Number(tokens!.limitAmount)).toBe(200000);

      const usd = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(usd!.reservedAmount)).toBe(0);
      expect(Number(usd!.consumedAmount)).toBe(0);
    });
  });

  it("refuses a MID invocation before dispatch when the subscription budget is exhausted", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedChain(tx);
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "0" })
        .where(
          and(
            eq(schema.budgetCounters.scopeRefId, runId),
            eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
          )
        );

      const outcome = await executeRun(tx, runId, [{ ...llmSpec(), taskDifficulty: "standard" as const }]);
      expect(outcome.status).toBe("failed");

      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      // The funded USD candidate never rescues a MID invocation either.
      expect(callAnthropicModel).not.toHaveBeenCalled();

      const failed = (await eventsForRun(tx, runId)).find((r) => r.eventType === "invocation_failed");
      expect(failed!.payload).toMatchObject({ reason: "insufficient_budget" });
    });
  });

  it("keeps the Budget Governor authoritative even when the guardrail would ALLOW", async () => {
    // The advisory control saying yes must never make an unaffordable
    // invocation authorized.
    const spy = vi.spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail").mockResolvedValue({
      decision: { decision: "ALLOW", reason: "below_threshold" },
      state: "OPEN",
      changed: false,
    });

    try {
      await withRollback(async (tx) => {
        const { runId } = await seedChain(tx);
        // Exhaust the SUBSCRIPTION counter specifically — the unit Max reserves
        // in. The dollar counter stays fully funded, and must not rescue it.
        await tx
          .update(schema.budgetCounters)
          .set({ limitAmount: "0" })
          .where(
            and(
              eq(schema.budgetCounters.scopeRefId, runId),
              eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
            )
          );

        const outcome = await executeRun(tx, runId, [llmSpec()]);
        expect(outcome.status).toBe("failed");
        expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
        // And NOT rescued by the funded USD candidate ranked behind Max.
        expect(callAnthropicModel).not.toHaveBeenCalled();

        const failed = (await eventsForRun(tx, runId)).find((r) => r.eventType === "invocation_failed");
        expect(failed!.payload).toMatchObject({ reason: "insufficient_budget" });
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a quota refusal fails the invocation and reserves nothing, without touching the API", async () => {
    const spy = vi.spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail").mockImplementation(async (_tx, input) =>
      input.provider === "claude_subscription"
        ? { decision: { decision: "REFUSE_QUOTA", reason: "five_hour_upper" }, state: "CLOSED", changed: false }
        : { decision: { decision: "ALLOW", reason: "not_configured" }, state: "OPEN", changed: false }
    );

    try {
      await withRollback(async (tx) => {
        const { runId } = await seedChain(tx);
        const outcome = await executeRun(tx, runId, [llmSpec()]);
        expect(outcome.status).toBe("failed");

        // NO FALLBACK: the billable API candidate ranked behind Max is never
        // dispatched, however much budget it has.
        expect(callAnthropicModel).not.toHaveBeenCalled();
        expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();

        // Quota is evaluated during candidate RANKING, before any reservation
        // exists — so there is nothing to release, and both counters are
        // untouched rather than merely restored.
        const counters = await tx
          .select()
          .from(schema.budgetCounters)
          .where(eq(schema.budgetCounters.scopeRefId, runId));
        expect(counters).toHaveLength(2);
        for (const c of counters) {
          expect(Number(c.reservedAmount)).toBe(0);
          expect(Number(c.consumedAmount)).toBe(0);
        }

        // The decision is observable on the failure event — the guardrail needs
        // no event of its own for a non-transition decision.
        const failed = (await eventsForRun(tx, runId)).find((r) => r.eventType === "invocation_failed");
        expect(failed!.payload).toMatchObject({ reason: "quota_guardrail" });
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("denies on budget alone, with routing unable to widen authorization", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedChain(tx);
      // Drain the counter: the hard control must refuse regardless of the fact
      // that a candidate was perfectly eligible for routing.
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "0" })
        .where(eq(schema.budgetCounters.scopeRefId, runId));

      const outcome = await executeRun(tx, runId, [llmSpec()]);
      expect(outcome.status).toBe("failed");

      // No provider was dispatched by ANY route.
      expect(callAnthropicModel).not.toHaveBeenCalled();
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      expect(callOpenAiModel).not.toHaveBeenCalled();

      const rows = await eventsForRun(tx, runId);
      const failed = rows.find((r) => r.eventType === "invocation_failed");
      expect(failed).toBeDefined();
      expect(failed!.payload).toMatchObject({ reason: "insufficient_budget" });
    });
  });
});

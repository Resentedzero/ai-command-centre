/**
 * The minimum sample criterion (`governance/performanceEligibility.ts`) and the Model
 * Router's measured tier preference (`preferTier`, spec §10.2/§10.5): below N nothing
 * moves, groups never mix, the risk floor, budget and candidate checks still decide,
 * and the snapshot consulted is recorded. Every provider adapter is mocked; nothing
 * is dispatched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb, testPool, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";
import { refreshAgentPerformance } from "../../src/projections/agentPerformance.js";
import type { ModelTier, RouteRequest } from "../../src/router/types.js";
import { providerCandidates } from "../../src/router/tierConfig.js";
import {
  MIN_PERFORMANCE_SAMPLES,
  performanceEligibility,
  type TierPerformanceRow,
  type TierPerformanceSnapshot,
} from "../../src/governance/performanceEligibility.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));
// Pass-through spy, so a refused route can be shown to have reserved exactly once.
vi.mock("../../src/governance/budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/governance/budget.js")>();
  return { ...actual, reserveBudget: vi.fn(actual.reserveBudget) };
});

import { authorizeRoute, preferTier } from "../../src/router/modelRouter.js";
import { reserveBudget } from "../../src/governance/budget.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("the minimum sample criterion", () => {
  it("ships with the operator's N = 10; an unset N would make nothing eligible", () => {
    expect(MIN_PERFORMANCE_SAMPLES).toBe(10);
    expect(performanceEligibility(9)).toEqual({ eligible: false, reason: "insufficient_samples" });
    expect(performanceEligibility(10)).toEqual({ eligible: true });
    expect(performanceEligibility(1_000_000, null)).toEqual({ eligible: false, reason: "no_criterion" });
  });

  it("below N is ineligible; exactly N and above are eligible", () => {
    expect(performanceEligibility(9, 10)).toEqual({ eligible: false, reason: "insufficient_samples" });
    expect(performanceEligibility(10, 10)).toEqual({ eligible: true });
    expect(performanceEligibility(11, 10)).toEqual({ eligible: true });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses a malformed N (%s)", (n) => {
    expect(() => performanceEligibility(5, n)).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// preferTier (pure)
// ---------------------------------------------------------------------------

function row(tier: string, sampleCount: number, successRate: string, avgCost: Record<string, string>, minSamples = 10): TierPerformanceRow {
  return { tier, sampleCount, successRate, avgCost, updatedAt: "2026-09-14T00:00:00.000Z", eligibility: performanceEligibility(sampleCount, minSamples) };
}
const snapshot = (...rows: TierPerformanceRow[]): TierPerformanceSnapshot => ({ consulted: true, minSamples: 10, rows });
/** CHEAP succeeds a quarter of the time at 1000 tokens a Run: 4000 per success. */
const cheapRow = (samples = 10) => row("CHEAP", samples, "0.25", { subscription_tokens: "1000" });
/** MID always succeeds at 2000 tokens a Run: 2000 per success. */
const midRow = (samples = 10) => row("MID", samples, "1", { subscription_tokens: "2000" });

describe("preferTier", () => {
  it("moves up to a tier that costs less per successful outcome when both rows are eligible", () => {
    expect(preferTier("CHEAP", snapshot(cheapRow(), midRow()))).toBe("MID");
  });

  it("does nothing when performance was not consulted", () => {
    expect(preferTier("CHEAP", { consulted: false, reason: "no_criterion" })).toBe("CHEAP");
    expect(preferTier("CHEAP", { consulted: false, reason: "unbound_run" })).toBe("CHEAP");
  });

  it("insufficient data moves nothing: a below-N better tier, or a below-N default", () => {
    expect(preferTier("CHEAP", snapshot(cheapRow(), midRow(9)))).toBe("CHEAP");
    expect(preferTier("CHEAP", snapshot(cheapRow(9), midRow()))).toBe("CHEAP");
    expect(preferTier("CHEAP", snapshot(midRow()))).toBe("CHEAP");
  });

  it("a tie keeps the default, including one that differs only by the projection's decimal rounding", () => {
    expect(preferTier("CHEAP", snapshot(cheapRow(), row("MID", 10, "0.5", { subscription_tokens: "2000" })))).toBe("CHEAP");
    // 5 of 7 successes at 3000 per success, as the projector stores it (20 decimal places).
    // In floating point that is 2999.9999999999995, which would read as cheaper than CHEAP's exact 3000.
    const rounded = row("MID", 10, "0.71428571428571428571", { subscription_tokens: "2142.8571428571428571" });
    expect(preferTier("CHEAP", snapshot(row("CHEAP", 10, "1", { subscription_tokens: "3000" }), rounded))).toBe("CHEAP");
  });

  it("never moves below the default, however cheap the lower tier", () => {
    expect(preferTier("MID", snapshot(row("CHEAP", 50, "1", { subscription_tokens: "1" }), midRow()))).toBe("MID");
  });

  it("never trades one resource unit against another", () => {
    const mixed = row("MID", 10, "1", { subscription_tokens: "10", usd: "1" });
    expect(preferTier("CHEAP", snapshot(cheapRow(), mixed))).toBe("CHEAP");
    const noWorse = row("MID", 10, "1", { subscription_tokens: "10", usd: "0" });
    expect(preferTier("CHEAP", snapshot(row("CHEAP", 10, "0.25", { subscription_tokens: "1000", usd: "0" }), noWorse))).toBe("MID");
  });

  it("the nearest cheaper tier wins; a tier that never succeeds is never preferred", () => {
    const strong = row("STRONG", 10, "1", { subscription_tokens: "1500" });
    expect(preferTier("CHEAP", snapshot(cheapRow(), midRow(), strong))).toBe("MID");
    expect(preferTier("CHEAP", snapshot(cheapRow(), row("MID", 10, "0", { subscription_tokens: "0" })))).toBe("CHEAP");
    expect(preferTier("CHEAP", snapshot(row("CHEAP", 10, "0", {}), row("MID", 10, "0.1", {})))).toBe("MID");
  });

  it("ignores rows that are not tiers (a Run with no model call)", () => {
    expect(preferTier("CHEAP", snapshot(cheapRow(), row("none", 99, "1", {})))).toBe("CHEAP");
  });
});

// ---------------------------------------------------------------------------
// authorizeRoute reads the Run's own group through the gate
// ---------------------------------------------------------------------------

type Group = { agentDefinitionId: string; agentDefinitionVersion: number; taskDefinitionId: string };

async function seedBoundRun(tx: DrizzleTransaction, subscriptionTokenLimit = "200000") {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [otherTask] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const name = "a-" + randomUUID();
  const agent = async (version: number) =>
    (await tx.insert(schema.agentDefinitions).values({ name, version, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id;
  const agentV1 = await agent(1);
  const agentV2 = await agent(2);
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "pending", input: {} })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId: taskInstance!.id, agentDefinitionId: agentV1, agentDefinitionVersion: 1, status: "active" })
    .returning();
  const [invocation] = await tx
    .insert(schema.invocations)
    .values({ runId: run!.id, seqNo: 1, kind: "llm", costClass: "llm", status: "pending", idempotencyKey: `test-inv-${randomUUID()}` })
    .returning();
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: subscriptionTokenLimit,
    reservedAmount: "0",
    consumedAmount: "0",
  });
  const group: Group = { agentDefinitionId: agentV1, agentDefinitionVersion: 1, taskDefinitionId: taskDefinition!.id };
  const request: RouteRequest = {
    taskDifficulty: "simple",
    riskTier: "low",
    contextBudget: {
      maxInputTokens: 1_000,
      maxArtifactTokens: 100,
      maxRetrievedItems: 5,
      maxToolSchemaTokens: 100,
      compressionThreshold: 100,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 100,
    },
    runId: run!.id,
    taskInstanceId: taskInstance!.id,
    invocationId: invocation!.id,
  };
  return { group, request, agentV2, otherTaskDefinitionId: otherTask!.id };
}

async function performance(tx: DrizzleTransaction, group: Group, tier: ModelTier, sampleCount: number, successRate: string, tokens: string) {
  await tx.insert(schema.agentPerformance).values({ ...group, modelTier: tier, sampleCount, successRate, avgCost: { subscription_tokens: tokens }, avgRetries: "0" });
}

/** CHEAP: 4000 tokens per success; MID: 2000. */
async function midIsBetter(tx: DrizzleTransaction, group: Group, samples = 10) {
  await performance(tx, group, "CHEAP", samples, "0.25", "1000");
  await performance(tx, group, "MID", samples, "1", "2000");
}

async function started(tx: DrizzleTransaction, invocationId: string) {
  const event = await tx.query.events.findFirst({
    where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_started")),
  });
  return event?.payload as Record<string, unknown> | undefined;
}

async function routedTier(tx: DrizzleTransaction, request: RouteRequest, minPerformanceSamples?: number | null) {
  const route = await authorizeRoute(tx, request, minPerformanceSamples === undefined ? {} : { minPerformanceSamples });
  if ("authorized" in route) throw new Error(`expected a route, got ${route.reason}`);
  return route.tier;
}

describe("authorizeRoute with measured tier preference", () => {
  it("with the configured N (10), eligible measured performance moves the Run", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await midIsBetter(tx, group);
      expect(await routedTier(tx, request)).toBe("MID");
      expect(await started(tx, request.invocationId)).toMatchObject({ historicalPerformance: { consulted: true, minSamples: 10 } });
    });
  });

  it("with N unconfigured, performance is not consulted and the default tier stands", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await midIsBetter(tx, group, 1_000);
      expect(await routedTier(tx, request, null)).toBe("CHEAP");
      expect(await started(tx, request.invocationId)).toMatchObject({
        defaultTier: "CHEAP",
        historicalPerformance: { consulted: false, reason: "no_criterion" },
        resultingTier: "CHEAP",
      });
    });
  });

  it.each([
    [11, "CHEAP"],
    [10, "MID"],
    [9, "MID"],
  ] as const)("with 10 samples and N = %s the Router routes %s", async (n, tier) => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await midIsBetter(tx, group);
      expect(await routedTier(tx, request, n)).toBe(tier);
    });
  });

  it("records the snapshot consulted, with each row's eligibility, on invocation_started", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await midIsBetter(tx, group);
      await performance(tx, group, "STRONG", 3, "1", "1");
      const route = await authorizeRoute(tx, request, { minPerformanceSamples: 10 });
      if ("authorized" in route) throw new Error(route.reason);
      expect(route.modelId).toBe("claude-sonnet-5");
      const payload = await started(tx, request.invocationId);
      expect(payload).toMatchObject({ defaultTier: "CHEAP", resultingTier: "MID", resultingModelId: "claude-sonnet-5" });
      expect(payload!.historicalPerformance).toEqual({
        consulted: true,
        minSamples: 10,
        rows: [
          expect.objectContaining({ tier: "CHEAP", sampleCount: 10, successRate: "0.25", avgCost: { subscription_tokens: "1000" }, eligibility: { eligible: true } }),
          expect.objectContaining({ tier: "MID", sampleCount: 10, eligibility: { eligible: true } }),
          expect.objectContaining({ tier: "STRONG", sampleCount: 3, eligibility: { eligible: false, reason: "insufficient_samples" } }),
        ],
      });
    });
  });

  it("another Task Definition's or Agent Definition version's performance never moves this Run", async () => {
    await withRollback(async (tx) => {
      const { group, request, agentV2, otherTaskDefinitionId } = await seedBoundRun(tx);
      await midIsBetter(tx, { ...group, taskDefinitionId: otherTaskDefinitionId });
      await midIsBetter(tx, { ...group, agentDefinitionId: agentV2, agentDefinitionVersion: 2 });
      // The same Agent Definition id under another version number: only the version tells them apart.
      await midIsBetter(tx, { ...group, agentDefinitionVersion: 2 });
      expect(await routedTier(tx, request, 10)).toBe("CHEAP");
      expect((await started(tx, request.invocationId))!.historicalPerformance).toEqual({ consulted: true, minSamples: 10, rows: [] });
    });
  });

  it("a below-N tier is not compared even when an eligible, costlier tier is", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await performance(tx, group, "CHEAP", 10, "0.25", "1000");
      await performance(tx, group, "MID", 9, "1", "2000");
      await performance(tx, group, "STRONG", 10, "1", "5000");
      expect(await routedTier(tx, request, 10)).toBe("CHEAP");
    });
  });

  it("a Run bound to no Agent is not consulted", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await midIsBetter(tx, group);
      await tx.update(schema.runs).set({ agentDefinitionId: null, agentDefinitionVersion: null }).where(eq(schema.runs.id, request.runId));
      expect(await routedTier(tx, request, 10)).toBe("CHEAP");
      expect((await started(tx, request.invocationId))!.historicalPerformance).toEqual({ consulted: false, reason: "unbound_run" });
    });
  });

  it("an escalation floor raises the tier, never lowers it, and the risk floor still applies", async () => {
    await withRollback(async (tx) => {
      const { request } = await seedBoundRun(tx);
      await tx.update(schema.runs).set({ minimumModelTier: "MID" }).where(eq(schema.runs.id, request.runId));
      expect(await routedTier(tx, request, null)).toBe("MID");
      expect(await started(tx, request.invocationId)).toMatchObject({ defaultTier: "CHEAP", escalationFloor: "MID", resultingTier: "MID" });
      // A default above the floor stands: high risk forces STRONG.
      expect(await routedTier(tx, { ...request, riskTier: "high" }, null)).toBe("STRONG");
    });
  });

  it("a retried Run never routes to a usd candidate, and is refused rather than falling back", async () => {
    await withRollback(async (tx) => {
      const { request } = await seedBoundRun(tx);
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: request.runId, resourceUnit: "usd", limitAmount: "100", reservedAmount: "0", consumedAmount: "0" });
      const usdOnly: RouteRequest = { ...request, allowedResourceUnits: ["usd"] };
      const first = await authorizeRoute(tx, usdOnly, { minPerformanceSamples: null });
      if ("authorized" in first) throw new Error(`a first attempt may route to usd; got ${first.reason}`);
      expect(first.accounting.unit).toBe("usd");

      await tx.update(schema.runs).set({ attempt: 2 }).where(eq(schema.runs.id, request.runId));
      const [second] = await tx
        .insert(schema.invocations)
        .values({ runId: request.runId, seqNo: 2, kind: "llm", costClass: "llm", status: "pending", idempotencyKey: `test-inv-${randomUUID()}` })
        .returning();
      const retried = await authorizeRoute(tx, { ...usdOnly, invocationId: second!.id }, { minPerformanceSamples: null });
      expect(retried).toMatchObject({ authorized: false, reason: "no_eligible_candidate", decision: { attempt: 2 } });
    });
  });

  it("a malformed N fails the route before anything is reserved or recorded", async () => {
    await withRollback(async (tx) => {
      const { request } = await seedBoundRun(tx);
      await expect(authorizeRoute(tx, request, { minPerformanceSamples: 0 })).rejects.toThrow(/positive integer/);
      expect(await started(tx, request.invocationId)).toBeUndefined();
    });
  });
});

describe("end to end: Events -> projector -> route", () => {
  async function terminalRun(tx: DrizzleTransaction, request: RouteRequest, group: Group, events: [string, Record<string, unknown>][]) {
    const source = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, request.taskInstanceId) });
    const [taskInstance] = await tx
      .insert(schema.taskInstances)
      .values({ taskDefinitionId: group.taskDefinitionId, taskDefinitionVersion: 1, projectId: source!.projectId, status: "completed" })
      .returning();
    const [run] = await tx
      .insert(schema.runs)
      .values({ taskInstanceId: taskInstance!.id, agentDefinitionId: group.agentDefinitionId, agentDefinitionVersion: group.agentDefinitionVersion, status: "completed" })
      .returning();
    for (const [eventType, payload] of events) {
      await emitEvent(tx, {
        idempotencyKey: `${eventType}:${randomUUID()}`,
        eventType,
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: taskInstance!.id, runId: run!.id, invocationId: null },
        actor: "system",
        producer: "test",
        payload,
        usage: null,
      });
    }
  }
  const modelCall = (resultingTier: ModelTier): [string, Record<string, unknown>] => ["invocation_started", { resultingTier }];
  const consumed = (amount: string): [string, Record<string, unknown>] => ["budget_consumed", { resourceUnit: "subscription_tokens", amount }];

  it("governance, stop and crash failures do not count toward N as routing sees it", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      // CHEAP: 9 agent samples at 4000 per success, plus Runs that are not the agent's outcome.
      for (let i = 0; i < 9; i++) await terminalRun(tx, request, group, [modelCall("CHEAP"), consumed("4000"), ["run_completed", {}]]);
      for (const reason of ["policy_denied", "insufficient_budget", "approval_expired", "interrupted_outcome_unknown", "execution_stopped"]) {
        await terminalRun(tx, request, group, [modelCall("CHEAP"), ["invocation_failed", { reason }], ["run_failed", {}]]);
      }
      await terminalRun(tx, request, group, [modelCall("CHEAP"), ["run_halted", {}], ["run_completed", {}]]);
      // MID: 10 samples at 2000 per success.
      for (let i = 0; i < 10; i++) await terminalRun(tx, request, group, [modelCall("MID"), consumed("2000"), ["run_completed", {}]]);
      await refreshAgentPerformance(tx);

      expect(await routedTier(tx, request, 10)).toBe("CHEAP");
      const snapshot = (await started(tx, request.invocationId))!.historicalPerformance as { rows: TierPerformanceRow[] };
      expect(snapshot.rows.find((r) => r.tier === "CHEAP")).toMatchObject({ sampleCount: 9, eligibility: { eligible: false, reason: "insufficient_samples" } });

      // Control: with N = 9 the same data does move the tier, so the exclusions are what held it.
      const [second] = await tx
        .insert(schema.invocations)
        .values({ runId: request.runId, seqNo: 2, kind: "llm", costClass: "llm", status: "pending", idempotencyKey: `test-inv-${randomUUID()}` })
        .returning();
      expect(await routedTier(tx, { ...request, invocationId: second!.id }, 9)).toBe("MID");
    });
  });
});

describe("performance never overrides hard constraints", () => {
  it("the risk floor still forces STRONG, whatever the data", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx);
      await performance(tx, group, "STRONG", 10, "0.1", "90000");
      await performance(tx, group, "CHEAP", 100, "1", "1");
      expect(await routedTier(tx, { ...request, riskTier: "high" }, 10)).toBe("STRONG");
    });
  });

  // Token-accounted tiers share one estimate (maxInputTokens + expectedOutputTokens), so a retry at the
  // default tier would be refused too; the single reservation attempt is what shows there was none.
  it("a budget refusal still refuses the route at the preferred tier: one reservation attempt, nothing reserved, nothing recorded", async () => {
    await withRollback(async (tx) => {
      const { group, request } = await seedBoundRun(tx, "10");
      await midIsBetter(tx, group);
      vi.mocked(reserveBudget).mockClear();
      // The refusal still records the routing decision it made (§10.7).
      expect(await authorizeRoute(tx, request, { minPerformanceSamples: 10 })).toMatchObject({
        authorized: false,
        reason: "insufficient_budget",
        decision: {
          taskDifficulty: "simple",
          defaultTier: "CHEAP",
          attemptedTier: "MID",
          contextBudget: request.contextBudget,
          historicalPerformance: { consulted: true, minSamples: 10 },
          budgetAuthorization: { authorized: false, modelId: "claude-sonnet-5", resourceUnit: "subscription_tokens", estimatedAmount: 1_100 },
        },
      });
      expect(reserveBudget).toHaveBeenCalledTimes(1);
      expect(await started(tx, request.invocationId)).toBeUndefined();
      const counter = await tx.query.budgetCounters.findFirst({ where: eq(schema.budgetCounters.scopeRefId, request.runId) });
      expect(counter!.reservedAmount).toBe("0");
    });
  });

  it("no candidate at the preferred tier fails explicitly; it never falls back to the default tier's model", async () => {
    const mid = providerCandidates.filter((c) => c.tiers.includes("MID"));
    for (const c of mid) c.enabled = false;
    try {
      await withRollback(async (tx) => {
        const { group, request } = await seedBoundRun(tx);
        await midIsBetter(tx, group);
        expect(await authorizeRoute(tx, request, { minPerformanceSamples: 10 })).toMatchObject({
          authorized: false,
          reason: "no_eligible_candidate",
          decision: { attemptedTier: "MID", excludedCandidates: expect.arrayContaining([{ provider: "claude_subscription", modelId: "claude-sonnet-5", reason: "disabled" }]) },
        });
      });
    } finally {
      for (const c of mid) c.enabled = true;
    }
  });
});

describe("a concurrent projection refresh (real transactions)", () => {
  it("routing sees the committed rows while a refresh is uncommitted, without waiting for it, and missing rows after it commits", async () => {
    const seeded = await testDb.transaction(async (tx) => {
      const s = await seedBoundRun(tx);
      await midIsBetter(tx, s.group);
      return s;
    });

    const refresh = await testPool.connect();
    try {
      await refresh.query("BEGIN");
      await refresh.query("DELETE FROM agent_performance WHERE agent_definition_id = $1", [seeded.group.agentDefinitionId]);

      // A blocked read fails fast here instead of hanging until the test timeout.
      const tier = await testDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        return routedTier(tx, seeded.request, 10);
      });
      expect(tier).toBe("MID");

      await refresh.query("COMMIT");
    } catch (error) {
      await refresh.query("ROLLBACK");
      throw error;
    } finally {
      refresh.release();
    }

    const second = await testDb.transaction(async (tx) => {
      const [invocation] = await tx
        .insert(schema.invocations)
        .values({ runId: seeded.request.runId, seqNo: 2, kind: "llm", costClass: "llm", status: "pending", idempotencyKey: `test-inv-${randomUUID()}` })
        .returning();
      return routedTier(tx, { ...seeded.request, invocationId: invocation!.id }, 10);
    });
    expect(second).toBe("CHEAP");
  });
});

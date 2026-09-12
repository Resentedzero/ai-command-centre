import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CompiledContext } from "../../src/context/types.js";
import type { RouteRequest, RouteResult } from "../../src/router/types.js";
import { tierConfig } from "../../src/router/tierConfig.js";
import * as policyModule from "../../src/governance/policy.js";
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

import { authorizeRoute, callModel } from "../../src/router/modelRouter.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";

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
  overrides: { limitAmount?: string } = {}
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

  return { runId: run!.id, taskInstanceId: taskInstance!.id, invocationId: invocation!.id };
}

/**
 * Default request: taskDifficulty "simple" + riskTier "low" -> CHEAP tier.
 * contextBudget.maxInputTokens=100_000, expectedOutputTokens=0 so
 * estimateCost = 100_000 * tierConfig[tier].pricePerToken lands on a clean
 * number (0.1 for CHEAP's default 0.000001, 1.5 for STRONG's default
 * 0.000015) rather than requiring float-imprecision tolerance everywhere.
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

  it("selects CHEAP for simple/standard taskDifficulty at low/medium riskTier", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
      const route = await authorizeRoute(
        tx,
        buildRequest({ runId, taskInstanceId, invocationId, taskDifficulty: "standard", riskTier: "medium" })
      );
      assertAuthorized(route);
      expect(route.tier).toBe("CHEAP");
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
  it("returns {authorized:false} on budget failure, without emitting an event or calling a provider", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "0.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      expect(route).toEqual({ authorized: false });

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

describe("tier->model mapping is read from tierConfig.ts, not hard-coded", () => {
  it("swapping tierConfig.CHEAP's modelId AND provider changes authorizeRoute/callModel's behavior accordingly", async () => {
    const original = { ...tierConfig.CHEAP };
    try {
      tierConfig.CHEAP.modelId = "custom-swapped-model-id";
      tierConfig.CHEAP.provider = "openai";

      await withRollback(async (tx) => {
        const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx);
        const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
        assertAuthorized(route);
        expect(route.tier).toBe("CHEAP");
        expect(route.modelId).toBe("custom-swapped-model-id");

        vi.mocked(callOpenAiModel).mockResolvedValueOnce({
          result: { ok: true },
          usage: { tokensIn: 10, tokensOut: 5, costAmount: 1 },
        });

        await callModel(tx, route, buildCompiledContext(), {});

        expect(callOpenAiModel).toHaveBeenCalledWith(
          "custom-swapped-model-id",
          expect.anything(),
          expect.anything(),
          original.pricePerToken
        );
        expect(callAnthropicModel).not.toHaveBeenCalled();
      });
    } finally {
      tierConfig.CHEAP.modelId = original.modelId;
      tierConfig.CHEAP.provider = original.provider;
      tierConfig.CHEAP.pricePerToken = original.pricePerToken;
    }
  });
});

// ---------------------------------------------------------------------------
// callModel: reconciliation + invocation_completed event
// ---------------------------------------------------------------------------

describe("callModel", () => {
  it("reconciles actual usage against budget_counters in one transaction", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      const afterReserve = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
      });
      // CHEAP: 100_000 * 0.000001 = 0.1
      expect(Number(afterReserve!.reservedAmount)).toBeCloseTo(0.1, 10);
      expect(Number(afterReserve!.consumedAmount)).toBe(0);

      vi.mocked(callAnthropicModel).mockResolvedValueOnce({
        result: {},
        usage: { tokensIn: 100, tokensOut: 50, costAmount: 0.05 },
      });

      await callModel(tx, route, buildCompiledContext(), {});

      const afterReconcile = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
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
        usage: { tokensIn: 120, tokensOut: 40, costAmount: 2 },
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
        usage: { tokensIn: 1, tokensOut: 1, costAmount: 0.001 },
      });
      await callModel(tx, route, buildCompiledContext(), {});

      // Both invocation_started (Pass 1) and invocation_completed (Pass 3)
      // must share ONE per-run monotonic sequence — that's only possible if
      // neither has a null runId.
      const rows = await tx.query.events.findMany({
        where: eq(schema.events.runId, runId),
        orderBy: (events, { asc }) => [asc(events.sequenceNo)],
      });
      expect(rows.map((r) => r.eventType)).toEqual(["invocation_started", "invocation_completed"]);
      expect(rows[0]!.sequenceNo).toBe(1);
      expect(rows[1]!.sequenceNo).toBe(2);
    });
  });

  it("on a thrown provider error, propagates the error and does NOT emit invocation_completed or reconcile budget (pre-dispatch ruling point 3)", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, invocationId } = await seedFixtureChain(tx, { limitAmount: "10.00" });
      const route = await authorizeRoute(tx, buildRequest({ runId, taskInstanceId, invocationId }));
      assertAuthorized(route);

      const beforeCall = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
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
        where: eq(schema.budgetCounters.scopeRefId, runId),
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
          usage: { tokensIn: 10, tokensOut: 10, costAmount: 1 },
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

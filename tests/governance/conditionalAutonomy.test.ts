/**
 * The Conditional Autonomy rule end to end (spec §9.4, values decided 2026-09-15): a
 * CONDITIONAL Grant's tool action is decided by the Run's own Agent Definition version and
 * Task Definition performance at the tier the Model Router selected in that Run, resolved
 * through the sample criterion's gate, and every evaluation records the rule and evidence.
 * Policy's per-branch rules are in policy.test.ts; this file drives the real Executor.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";
import { readConditionalEvidence } from "../../src/governance/performanceEligibility.js";
import { toPolicyDecisionRecord } from "../../src/api/policyDecisionRecord.js";
import type { ToolInvocationSpec } from "../../src/execution/types.js";

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

import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";
import { executeRun as executeRunOnce } from "../../src/execution/executor.js";
import { dispatchAndRecord } from "../../src/workflow/advanceWorkflowRunUntilBlocked.js";
import { transactionRunner } from "../../src/db/transactionRunner.js";
import { resolveApproval } from "../../src/governance/approvals.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

type Fixture = { runId: string; taskInstanceId: string; capabilityId: string; toolBindingId: string; agentDefinitionId: string; taskDefinitionId: string };

async function seed(tx: DrizzleTransaction, opts: { permission?: string; staticRiskTag?: string } = {}): Promise<Fixture> {
  const permission = opts.permission ?? "READ";
  const [capability] = await tx.insert(schema.capabilities).values({ name: "cap-" + randomUUID(), staticRiskTag: opts.staticRiskTag ?? "low" }).returning();
  const [binding] = await tx.insert(schema.toolBindings).values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 }).returning();
  const [agent] = await tx.insert(schema.agentDefinitions).values({ name: "agent-" + randomUUID(), version: 1, role: "r", objective: "o", instructions: "i" }).returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agent!.id,
    agentDefinitionVersion: 1,
    capabilityId: capability!.id,
    permissions: [permission],
    maxTrustLevelRequired: 1,
    autonomyState: "CONDITIONAL",
  });
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "pending", input: {} })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId: taskInstance!.id, agentDefinitionId: agent!.id, agentDefinitionVersion: 1, status: "active" })
    .returning();
  await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, limitAmount: "1000.00", reservedAmount: "0", consumedAmount: "0" });
  return {
    runId: run!.id,
    taskInstanceId: taskInstance!.id,
    capabilityId: capability!.id,
    toolBindingId: binding!.id,
    agentDefinitionId: agent!.id,
    taskDefinitionId: taskDefinition!.id,
  };
}

/** The Model Router's record of a route in this Run (`invocation_started.resultingTier`). */
async function routed(tx: DrizzleTransaction, f: Fixture, tier: string): Promise<void> {
  await emitEvent(tx, {
    idempotencyKey: `test-route:${randomUUID()}`,
    eventType: "invocation_started",
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: f.taskInstanceId, runId: f.runId, invocationId: null },
    actor: "system",
    producer: "model-router",
    payload: { defaultTier: tier, resultingTier: tier },
    usage: null,
  });
}

async function performance(tx: DrizzleTransaction, f: Fixture, tier: string, sampleCount: number, successRate: string, taskDefinitionId = f.taskDefinitionId) {
  await tx.insert(schema.agentPerformance).values({
    agentDefinitionId: f.agentDefinitionId,
    agentDefinitionVersion: 1,
    taskDefinitionId,
    modelTier: tier,
    sampleCount,
    successRate,
    avgCost: {},
    avgRetries: "0",
  });
}

function toolSpec(f: Fixture, permission = "READ"): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "metered_api",
    capabilityId: f.capabilityId,
    toolBindingId: f.toolBindingId,
    permission: permission as ToolInvocationSpec["permission"],
    proposedActionSnapshot: { action: "read-thing" },
    estimatedCost: 1,
    execute: vi.fn(async () => ({ ok: true })),
  };
}

async function evaluations(tx: DrizzleTransaction, runId: string) {
  const rows = await tx.query.events.findMany({
    where: and(eq(schema.events.runId, runId), eq(schema.events.eventType, "policy_evaluated")),
    orderBy: (e, { asc }) => asc(e.sequenceNo),
  });
  return rows.map((r) => r.payload as Record<string, unknown>);
}

describe("Conditional Autonomy through the Executor", () => {
  it("allows a low-risk READ when the routed tier's eligible row meets 0.80, with no Approval, and records rule and evidence", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 10, "0.9");
      const spec = toolSpec(f);

      expect(await executeRun(tx, f.runId, [spec])).toEqual({ status: "completed", runId: f.runId });
      expect(spec.execute).toHaveBeenCalledTimes(1);
      expect(await tx.query.approvals.findMany({ where: eq(schema.approvals.invocationId, (await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, f.runId) }))!.id) })).toEqual([]);

      const payloads = await evaluations(tx, f.runId);
      expect(payloads.map((p) => [p.checkpoint, p.decision, p.basis])).toEqual([
        ["propose", "ALLOW", "conditional_performance_meets_allow_threshold"],
        ["pre_dispatch", "ALLOW", "conditional_performance_meets_allow_threshold"],
      ]);
      expect(payloads[0]).toMatchObject({
        autonomyState: "CONDITIONAL",
        riskTier: "low",
        conditionalRule: { id: "conditional_autonomy_v1", allowAtOrAboveSuccessRate: 0.8, requireApprovalAtOrAboveSuccessRate: 0.6, autoAllowPermissions: ["READ"], autoAllowRiskTiers: ["low"] },
        performanceEvidence: {
          agentDefinitionId: f.agentDefinitionId,
          agentDefinitionVersion: 1,
          taskDefinitionId: f.taskDefinitionId,
          effectiveTier: "MID",
          sampleCount: 10,
          successRate: "0.9",
          minSamples: 10,
          eligible: true,
          eligibilityReason: null,
        },
      });
      // The read model exposes exactly what was recorded.
      expect(toPolicyDecisionRecord(payloads[0])).toMatchObject({
        decision: "ALLOW",
        basis: "conditional_performance_meets_allow_threshold",
        conditionalRule: { id: "conditional_autonomy_v1" },
        performanceEvidence: { effectiveTier: "MID", sampleCount: 10, successRate: "0.9", eligible: true },
      });
    });
  });

  it("requires approval between 0.60 and 0.80 and denies below 0.60 (Run failed, risk tier still recorded)", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 20, "0.7");
      expect(await executeRun(tx, f.runId, [toolSpec(f)])).toEqual({ status: "awaiting_approval", runId: f.runId });
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_performance_below_allow_threshold" });
    });
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 20, "0.5");
      const spec = toolSpec(f);
      expect(await executeRun(tx, f.runId, [spec])).toEqual({ status: "failed", runId: f.runId });
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({ decision: "DENY", basis: "conditional_performance_below_deny_threshold", riskTier: "low" });
      const failed = await tx.query.events.findFirst({ where: and(eq(schema.events.runId, f.runId), eq(schema.events.eventType, "invocation_failed")) });
      expect(failed!.payload).toMatchObject({ reason: "policy_denied" });
    });
  });

  it("uses only the routed tier's row for this Agent version and Task: another tier, another Task, or too few samples require approval", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      const [otherTask] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
      await performance(tx, f, "CHEAP", 50, "1");
      await performance(tx, f, "MID", 50, "1", otherTask!.id);
      // Another version of the same Agent Definition.
      await tx.insert(schema.agentPerformance).values({
        agentDefinitionId: f.agentDefinitionId,
        agentDefinitionVersion: 2,
        taskDefinitionId: f.taskDefinitionId,
        modelTier: "MID",
        sampleCount: 50,
        successRate: "1",
        avgCost: {},
        avgRetries: "0",
      });
      expect(await executeRun(tx, f.runId, [toolSpec(f)])).toEqual({ status: "awaiting_approval", runId: f.runId });
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({
        basis: "conditional_insufficient_evidence",
        performanceEvidence: { effectiveTier: "MID", sampleCount: null, eligible: false, eligibilityReason: "no_performance_row" },
      });
    });
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 9, "1");
      expect(await executeRun(tx, f.runId, [toolSpec(f)])).toEqual({ status: "awaiting_approval", runId: f.runId });
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({
        basis: "conditional_insufficient_evidence",
        performanceEvidence: { sampleCount: 9, eligible: false, eligibilityReason: "insufficient_samples" },
      });
    });
  });

  it("requires approval when the Run has routed no model call: there is no selected tier to consult", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await performance(tx, f, "MID", 50, "1");
      await performance(tx, f, "none", 50, "1");
      expect(await executeRun(tx, f.runId, [toolSpec(f)])).toEqual({ status: "awaiting_approval", runId: f.runId });
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({
        basis: "conditional_insufficient_evidence",
        performanceEvidence: { effectiveTier: null, eligibilityReason: "no_routed_tier" },
      });
    });
  });

  it("keeps a gated CONDITIONAL action human-approved even with perfect evidence, and consults no performance", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx, { permission: "WRITE" });
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 50, "1");
      expect(await executeRun(tx, f.runId, [toolSpec(f, "WRITE")])).toEqual({ status: "awaiting_approval", runId: f.runId });
      expect((await evaluations(tx, f.runId))[0]).toMatchObject({ basis: "conditional_human_gated_action", performanceEvidence: null, conditionalRule: { id: "conditional_autonomy_v1" } });
    });
  });
});

describe("Conditional Autonomy at the later checkpoints (re-read, fail closed)", () => {
  async function setRate(tx: DrizzleTransaction, f: Fixture, successRate: string) {
    await tx
      .update(schema.agentPerformance)
      .set({ successRate })
      .where(and(eq(schema.agentPerformance.agentDefinitionId, f.agentDefinitionId), eq(schema.agentPerformance.modelTier, "MID")));
  }

  it("an ALLOW at propose whose rate falls below 0.80 before dispatch is refused, the effect never runs, and the hold is released", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 20, "0.9");
      const spec = toolSpec(f);
      const outcome = await executeRunOnce(tx, f.runId, [spec]);
      expect(outcome.status).toBe("dispatch_required");
      await setRate(tx, f, "0.7");
      await dispatchAndRecord(transactionRunner(tx), (outcome as Extract<typeof outcome, { status: "dispatch_required" }>).dispatch);

      expect(spec.execute).not.toHaveBeenCalled();
      expect((await evaluations(tx, f.runId)).map((p) => [p.checkpoint, p.decision])).toEqual([
        ["propose", "ALLOW"],
        ["pre_dispatch", "REQUIRE_APPROVAL"],
      ]);
      const failed = await tx.query.events.findFirst({ where: and(eq(schema.events.runId, f.runId), eq(schema.events.eventType, "invocation_failed")) });
      expect(failed!.payload).toMatchObject({ reservationSettlement: "released" });
      const counter = await tx.query.budgetCounters.findFirst({ where: and(eq(schema.budgetCounters.scopeRefId, f.runId), eq(schema.budgetCounters.resourceUnit, "usd")) });
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });

  it("a human-approved action whose rate falls below 0.60 before resume is denied, and its hold released", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "MID");
      await performance(tx, f, "MID", 20, "0.7");
      const spec = toolSpec(f);
      expect(await executeRun(tx, f.runId, [spec])).toEqual({ status: "awaiting_approval", runId: f.runId });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, f.runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "human:reviewer");
      await setRate(tx, f, "0.5");

      expect(await executeRun(tx, f.runId, [spec])).toEqual({ status: "failed", runId: f.runId });
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await evaluations(tx, f.runId)).map((p) => [p.checkpoint, p.decision])).toEqual([
        ["propose", "REQUIRE_APPROVAL"],
        ["resume", "DENY"],
      ]);
      const failed = await tx.query.events.findFirst({ where: and(eq(schema.events.runId, f.runId), eq(schema.events.eventType, "invocation_failed")) });
      expect(failed!.payload).toMatchObject({ reason: "reauthorization_policy_denied" });
      const counter = await tx.query.budgetCounters.findFirst({ where: and(eq(schema.budgetCounters.scopeRefId, f.runId), eq(schema.budgetCounters.resourceUnit, "usd")) });
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });
});

describe("readConditionalEvidence", () => {
  it("ignores a started event that is not the Model Router's", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await emitEvent(tx, {
        idempotencyKey: `test-other:${randomUUID()}`,
        eventType: "invocation_started",
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: f.taskInstanceId, runId: f.runId, invocationId: null },
        actor: "system",
        producer: "executor",
        payload: { kind: "tool", resultingTier: "MID" },
        usage: null,
      });
      await performance(tx, f, "MID", 50, "1");
      expect(await readConditionalEvidence(tx, f.runId)).toMatchObject({ effectiveTier: null, eligibilityReason: "no_routed_tier" });
    });
  });

  it("reads the latest route's tier in the Run", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      await routed(tx, f, "CHEAP");
      await routed(tx, f, "STRONG");
      await performance(tx, f, "CHEAP", 30, "1");
      await performance(tx, f, "STRONG", 30, "0.85");
      expect(await readConditionalEvidence(tx, f.runId)).toMatchObject({ effectiveTier: "STRONG", sampleCount: 30, successRate: "0.85", eligible: true });
    });
  });

  it("reports an unbound Run and no criterion without consulting any row", async () => {
    await withRollback(async (tx) => {
      const f = await seed(tx);
      expect(await readConditionalEvidence(tx, f.runId, null)).toMatchObject({ eligible: false, eligibilityReason: "no_criterion", effectiveTier: null });
      await tx.update(schema.runs).set({ agentDefinitionId: null, agentDefinitionVersion: null }).where(eq(schema.runs.id, f.runId));
      expect(await readConditionalEvidence(tx, f.runId)).toMatchObject({ eligible: false, eligibilityReason: "unbound_run" });
    });
  });
});

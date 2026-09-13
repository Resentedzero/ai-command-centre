import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CapabilityPermission } from "../../src/governance/policy.js";
import type {
  DeterministicInvocationSpec,
  LlmInvocationSpec,
  RetrievalInvocationSpec,
  ToolInvocationSpec,
} from "../../src/execution/types.js";

// ---------------------------------------------------------------------------
// Mock BOTH provider wrapper modules — this file never calls a real provider
// SDK; the llm-kind tests exercise the REAL authorizeRoute/callModel/
// compileContext/evaluatePolicy/reserveBudget code, only the outermost
// provider boundary is mocked (same pattern as modelRouter.test.ts).
// ---------------------------------------------------------------------------
vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  // MANDATORY since Phase 7F made Claude Max the routed default: without this
  // mock these tests would dispatch to the REAL adapter, spawn the Claude CLI,
  // and consume subscription entitlement on every `npm test`.
  callClaudeSubscriptionModel: vi.fn(),
}));

// Phase 9: executeRun yields at each LLM Invocation; this drives it to the next
// real boundary exactly as the production driver does. See the helper's header.
import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";
import * as invocationLifecycleModule from "../../src/execution/invocationLifecycle.js";
import * as policyModule from "../../src/governance/policy.js";
import * as budgetModule from "../../src/governance/budget.js";
import * as approvalsModule from "../../src/governance/approvals.js";
import { resolveApproval } from "../../src/governance/approvals.js";
import { compileContext } from "../../src/context/compiler.js";
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
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_PERMISSION: CapabilityPermission = "WRITE";

async function seedToolRunFixture(
  tx: DrizzleTransaction,
  opts: {
    autonomyState?: "ALWAYS_APPROVE" | "CONDITIONAL" | "AUTONOMOUS";
    grantPermissions?: CapabilityPermission[];
    staticRiskTag?: string;
    trustLevel?: number;
    maxTrustLevelRequired?: number;
    limitAmount?: string;
    withGrant?: boolean;
  } = {}
): Promise<{ runId: string; taskInstanceId: string; capabilityId: string; toolBindingId: string; permission: CapabilityPermission }> {
  const permission = DEFAULT_PERMISSION;

  const [capability] = await tx
    .insert(schema.capabilities)
    .values({ name: "cap-" + randomUUID(), staticRiskTag: opts.staticRiskTag ?? "low" })
    .returning();

  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: opts.trustLevel ?? 2, version: 1 })
    .returning();

  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "tester", objective: "test", instructions: "n/a" })
    .returning();

  if (opts.withGrant !== false) {
    await tx.insert(schema.capabilityGrants).values({
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      capabilityId: capability!.id,
      permissions: opts.grantPermissions ?? [permission],
      maxTrustLevelRequired: opts.maxTrustLevelRequired ?? 1,
      autonomyState: opts.autonomyState ?? "AUTONOMOUS",
    });
  }

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
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    limitAmount: opts.limitAmount ?? "1000.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  // Mirrors production provisioning (`provisionRunBudgets` creates one counter per
  // unit): an independent subscription_tokens counter alongside the USD one, now
  // that Claude Max is the primary candidate. NOT a conversion of the dollar
  // limit — a separate ceiling in a separate unit.
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
    permission,
  };
}

async function seedGenericRunFixture(
  tx: DrizzleTransaction,
  opts: { limitAmount?: string } = {}
): Promise<{ runId: string; taskInstanceId: string }> {
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
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active" }).returning();
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    limitAmount: opts.limitAmount ?? "1000.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  // Mirrors production provisioning (`provisionRunBudgets` creates one counter per
  // unit): an independent subscription_tokens counter alongside the USD one, now
  // that Claude Max is the primary candidate. NOT a conversion of the dollar
  // limit — a separate ceiling in a separate unit.
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: "200000",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  return { runId: run!.id, taskInstanceId: taskInstance!.id };
}

function buildToolSpec(
  overrides: Partial<ToolInvocationSpec> & Pick<ToolInvocationSpec, "capabilityId" | "toolBindingId" | "permission">
): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "metered_api",
    proposedActionSnapshot: { action: "do-thing" },
    estimatedCost: 5,
    execute: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function buildDeterministicSpec(execute?: () => Promise<Record<string, unknown>>): DeterministicInvocationSpec {
  return { kind: "deterministic", costClass: "deterministic", execute: execute ?? vi.fn(async () => ({})) };
}

function buildRetrievalSpec(execute?: () => Promise<Record<string, unknown>>): RetrievalInvocationSpec {
  return { kind: "retrieval", costClass: "local_retrieval", execute: execute ?? vi.fn(async () => ({ items: [] })) };
}

function buildLlmSpec(overrides: Partial<LlmInvocationSpec> = {}): LlmInvocationSpec {
  return {
    kind: "llm",
    costClass: "llm",
    intent: "synthesize",
    candidateArtifactIds: [],
    candidateToolCapabilityIds: [],
    contextBudget: {
      maxInputTokens: 10_000,
      maxArtifactTokens: 2_000,
      maxRetrievedItems: 50,
      maxToolSchemaTokens: 2_000,
      compressionThreshold: 2_000,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 100,
    },
    taskDifficulty: "simple",
    riskTier: "low",
    expectedOutputShape: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Deterministic-only specs never touch Policy
// ---------------------------------------------------------------------------

describe("executeRun on all-deterministic specs", () => {
  it("never invokes evaluatePolicy (spy-based)", async () => {
    const spy = vi.spyOn(policyModule, "evaluatePolicy");
    try {
      await withRollback(async (tx) => {
        const { runId } = await seedGenericRunFixture(tx);
        const outcome = await executeRun(tx, runId, [buildDeterministicSpec(), buildRetrievalSpec()]);
        expect(outcome).toEqual({ status: "completed", runId });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("emits invocation_started/invocation_completed itself and persists a non-empty result as an artifact", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      const spec = buildDeterministicSpec(async () => ({ answer: 42 }));
      await executeRun(tx, runId, [spec]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("completed");
      expect(invocation?.kind).toBe("deterministic");

      const events = await tx.query.events.findMany({ where: eq(schema.events.invocationId, invocation!.id) });
      expect(events.map((e) => e.eventType).sort()).toEqual(["invocation_completed", "invocation_started"]);
      expect(events.every((e) => e.producer === "executor")).toBe(true);

      const artifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.producingInvocationId, invocation!.id),
      });
      expect(artifact).toBeDefined();
      expect(artifact?.inlineContent).toBe(JSON.stringify({ answer: 42 }));
    });
  });

  it("does not create an artifact when the result is an empty object", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      await executeRun(tx, runId, [buildDeterministicSpec(async () => ({}))]);
      const artifact = await tx.query.artifacts.findFirst();
      expect(artifact).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. REQUIRE_APPROVAL halts, and resumes from that exact point
// ---------------------------------------------------------------------------

describe("tool invocation REQUIRE_APPROVAL", () => {
  it("halts at awaiting_approval; re-invoking executeRun after approval resumes from that exact point, not from the start", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const toolExecute = vi.fn(async () => ({ done: true }));
      const secondExecute = vi.fn(async () => ({ second: true }));
      const specs = [
        buildToolSpec({ capabilityId, toolBindingId, permission, execute: toolExecute }),
        buildDeterministicSpec(secondExecute),
      ];

      const first = await executeRun(tx, runId, specs);
      expect(first).toEqual({ status: "awaiting_approval", runId });
      expect(toolExecute).not.toHaveBeenCalled();
      expect(secondExecute).not.toHaveBeenCalled(); // proves it stopped at spec 0, never reached spec 1

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("awaiting_approval");
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      expect(approval).toBeDefined();

      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      const second = await executeRun(tx, runId, specs);
      expect(second).toEqual({ status: "completed", runId });
      // Resumed exactly once — never restarted from index 0 and re-ran spec 0's tool call twice.
      expect(toolExecute).toHaveBeenCalledTimes(1);
      // Continued the loop to spec 1 within the same resuming call.
      expect(secondExecute).toHaveBeenCalledTimes(1);

      const finalRun = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(finalRun?.status).toBe("completed");
    });
  });

  it("rejected approval releases the reservation and fails the invocation + Run", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
        limitAmount: "10.00",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission, estimatedCost: 5 });
      await executeRun(tx, runId, [spec]);

      const counterAfterReserve = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counterAfterReserve!.reservedAmount)).toBe(5);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "rejected", "reviewer");

      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(spec.execute).not.toHaveBeenCalled();

      const counterAfterRelease = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counterAfterRelease!.reservedAmount)).toBe(0);
      expect(Number(counterAfterRelease!.consumedAmount)).toBe(0);

      const finalRun = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(finalRun?.status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // Final-review Finding 1: Phase 9.5's Approval lifecycle must be VISIBLE in
  // the Activity feed (Phase 18.1a, "a direct tail of Events"). Before this
  // fix the Executor created the Approval row and halted without emitting
  // anything at all, so the whole REQUIRE_APPROVAL moment — the MVP's
  // flagship governance behaviour — left no trace in the event stream.
  // -------------------------------------------------------------------------

  it("emits approval_required in the same transaction that creates the Approval row, correlated like the other executor events", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
        staticRiskTag: "high",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });

      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "awaiting_approval", runId });

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      expect(approval).toBeDefined();

      const required = await tx.query.events.findMany({ where: eq(schema.events.eventType, "approval_required") });
      expect(required).toHaveLength(1);

      // Same correlation shape as the invocation_* events this executor
      // already emits: goalId/workflowRunId null, the rest populated.
      expect(required[0]!.goalId).toBeNull();
      expect(required[0]!.workflowRunId).toBeNull();
      expect(required[0]!.taskInstanceId).toBe(taskInstanceId);
      expect(required[0]!.runId).toBe(runId);
      expect(required[0]!.invocationId).toBe(invocation!.id);
      expect(required[0]!.causationId).toBeNull();
      expect(required[0]!.actor).toBe("system");
      expect(required[0]!.producer).toBe("executor");
      expect(required[0]!.eventVersion).toBe(1);

      // Identifies WHAT is gated, per Phase 9.5 — and the risk tier the
      // Policy engine actually computed, so the feed can show it without
      // re-deriving anything.
      expect(required[0]!.payload).toEqual({
        approvalId: approval!.id,
        riskTier: approval!.riskTier,
        capabilityId,
        permission,
      });
    });
  });

  it("the ALLOW path never emits approval_required", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
      });
      await executeRun(tx, runId, [buildToolSpec({ capabilityId, toolBindingId, permission })]);

      const required = await tx.query.events.findMany({ where: eq(schema.events.eventType, "approval_required") });
      expect(required).toHaveLength(0);
    });
  });

  it("orders approval_required / approval_granted / invocation_* correctly by sequenceNo across a full approve-then-resume flow", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });

      await executeRun(tx, runId, [spec]);
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "human:reviewer");
      await executeRun(tx, runId, [spec]);

      // `sequenceNo` is monotonic per runId and authoritative for ordering
      // (Phase 8.1) — this is exactly the order the Activity feed renders.
      const runEvents = await tx.query.events.findMany({
        where: eq(schema.events.runId, runId),
        orderBy: (e, { asc }) => asc(e.sequenceNo),
      });
      expect(runEvents.map((e) => e.eventType)).toEqual([
        "invocation_started",
        "approval_required",
        "approval_granted",
        "invocation_completed",
      ]);
      expect(runEvents.map((e) => e.sequenceNo)).toEqual([1, 2, 3, 4]);

      // The resolution event really is interleaved into the SAME per-run
      // counter as the invocation events — not a separate, unordered stream.
      const granted = runEvents.find((e) => e.eventType === "approval_granted");
      expect(granted!.runId).toBe(runId);
      expect(granted!.actor).toBe("human:reviewer");
    });
  });

  it("orders approval_required / approval_rejected / invocation_failed correctly on the reject path", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });

      await executeRun(tx, runId, [spec]);
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "rejected", "human:reviewer");
      await executeRun(tx, runId, [spec]);

      const runEvents = await tx.query.events.findMany({
        where: eq(schema.events.runId, runId),
        orderBy: (e, { asc }) => asc(e.sequenceNo),
      });
      expect(runEvents.map((e) => e.eventType)).toEqual([
        "invocation_started",
        "approval_required",
        "approval_rejected",
        "invocation_failed",
      ]);
      expect(runEvents.map((e) => e.sequenceNo)).toEqual([1, 2, 3, 4]);
    });
  });

  it("still-pending approval is a no-op on re-invocation (returns awaiting_approval again)", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
      await executeRun(tx, runId, [spec]);
      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "awaiting_approval", runId });
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  // Fix-round-1 (Important #3): reauthorize only deep-equals the invocation's
  // stored proposedActionSnapshot against ITSELF (both written from the
  // ORIGINAL propose-time spec) — it can never fire on a caller simply
  // passing a materially different spec object on the resuming executeRun
  // call, which is the one mutation vector this unit's own design actually
  // exposes (a fresh invocationSpecs array is supplied on every call).
  // resumeToolSpec must independently validate the resuming spec's
  // capabilityId/permission/proposedActionSnapshot against what was actually
  // proposed and approved, BEFORE reauthorize/execution.
  it("resuming with a spec whose proposedActionSnapshot differs from what was originally proposed fails the run rather than executing the mutated action", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const originalSpec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        proposedActionSnapshot: { action: "safe-thing" },
      });
      await executeRun(tx, runId, [originalSpec]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      const mutatedExecute = vi.fn(async () => ({ done: true }));
      const mutatedSpec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        proposedActionSnapshot: { action: "mutated-dangerous-thing" },
        execute: mutatedExecute,
      });

      const outcome = await executeRun(tx, runId, [mutatedSpec]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(mutatedExecute).not.toHaveBeenCalled(); // never executed the mutated action

      const finalInvocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocation!.id) });
      expect(finalInvocation?.status).toBe("failed");
      const finalRun = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(finalRun?.status).toBe("failed");

      // The reservation held while awaiting approval must still be released,
      // not stranded, on this rejection path.
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });

  // NEXT_PHASE_PLAN Appendix A #4 (trust-level drift, Phase 20 risk #7): the
  // binding is persisted at propose time, and Policy is re-run against its
  // CURRENT trust on resume — an Approval granted under one trust state must not
  // execute under a lower one.
  it("a binding whose trust drops below the Grant's bar while its Approval is pending never executes after approval", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
      expect(await executeRun(tx, runId, [spec])).toEqual({ status: "awaiting_approval", runId });

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.toolBindingId).toBe(toolBindingId);
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });

      // Drift while pending: the binding is downgraded AND the Grant's bar raised.
      await tx.update(schema.toolBindings).set({ trustLevel: 0 }).where(eq(schema.toolBindings.id, toolBindingId));
      await tx
        .update(schema.capabilityGrants)
        .set({ maxTrustLevelRequired: 99 })
        .where(eq(schema.capabilityGrants.capabilityId, capabilityId));
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      expect(await executeRun(tx, runId, [spec])).toEqual({ status: "failed", runId });
      expect(spec.execute).not.toHaveBeenCalled();

      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed?.payload).toMatchObject({ reason: "reauthorization_policy_denied" });
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "usd")),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(0);
    });
  });

  it("resuming with a different toolBindingId than the one authorized fails as a spec mismatch", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      await executeRun(tx, runId, [buildToolSpec({ capabilityId, toolBindingId, permission })]);
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      const [otherBinding] = await tx
        .insert(schema.toolBindings)
        .values({ capabilityId, kind: "internal", config: {}, trustLevel: 2, version: 2 })
        .returning();
      const swapped = buildToolSpec({ capabilityId, toolBindingId: otherBinding!.id, permission });

      expect(await executeRun(tx, runId, [swapped])).toEqual({ status: "failed", runId });
      expect(swapped.execute).not.toHaveBeenCalled();
      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed?.payload).toMatchObject({ reason: "resume_spec_mismatch" });
    });
  });

  // Fix-round-2 (New Important, found by the round-1 re-review):
  // `invocations.costClass` is a real, persisted column. A resuming spec that
  // claims `costClass: "deterministic"` against an invocation actually
  // proposed with a real cost class (e.g. "metered_api") makes
  // `reserveBudget` short-circuit to `NOOP_RESERVATION_ID` — budget
  // enforcement completely bypassed, not just mis-sized. This is the same
  // threat model as the proposedActionSnapshot-mismatch test above, via a
  // different field.
  it("resuming with a spec whose costClass differs from the originally-proposed invocation's stored costClass fails the run without ever taking the no-op budget path", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
        limitAmount: "1000.00",
      });
      const originalSpec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        costClass: "metered_api",
        estimatedCost: 6,
      });
      await executeRun(tx, runId, [originalSpec]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.costClass).toBe("metered_api");
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      const bypassExecute = vi.fn(async () => ({ done: true }));
      const bypassSpec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        costClass: "deterministic", // mismatched vs. the stored "metered_api" — would force reserveBudget's NOOP short-circuit
        estimatedCost: 6,
        execute: bypassExecute,
      });

      const outcome = await executeRun(tx, runId, [bypassSpec]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(bypassExecute).not.toHaveBeenCalled(); // never executed with budget enforcement bypassed

      const finalInvocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocation!.id) });
      expect(finalInvocation?.status).toBe("failed");
      const finalRun = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(finalRun?.status).toBe("failed");

      // The original real reservation (6 units, held while awaiting approval)
      // was released properly — no no-op path was ever taken for this
      // resumption, and nothing was left stranded or double-counted.
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Explicit order-of-operations test
// ---------------------------------------------------------------------------

describe("explicit order-of-operations (Grant-check -> Policy -> Budget -> Approval)", () => {
  it("calls resolveCapabilityGrant, evaluatePolicy, reserveBudget, createApproval in exactly that sequence for a REQUIRE_APPROVAL spec", async () => {
    const callOrder: string[] = [];

    const originalResolveGrant = invocationLifecycleModule.resolveCapabilityGrant;
    const originalEvaluatePolicy = policyModule.evaluatePolicy;
    const originalReserveBudget = budgetModule.reserveBudget;
    const originalCreateApproval = approvalsModule.createApproval;

    const grantSpy = vi
      .spyOn(invocationLifecycleModule, "resolveCapabilityGrant")
      .mockImplementation(async (...args: Parameters<typeof originalResolveGrant>) => {
        callOrder.push("grant");
        return originalResolveGrant(...args);
      });
    const policySpy = vi
      .spyOn(policyModule, "evaluatePolicy")
      .mockImplementation(async (...args: Parameters<typeof originalEvaluatePolicy>) => {
        callOrder.push("policy");
        return originalEvaluatePolicy(...args);
      });
    const budgetSpy = vi
      .spyOn(budgetModule, "reserveBudget")
      .mockImplementation(async (...args: Parameters<typeof originalReserveBudget>) => {
        callOrder.push("budget");
        return originalReserveBudget(...args);
      });
    const approvalSpy = vi
      .spyOn(approvalsModule, "createApproval")
      .mockImplementation(async (...args: Parameters<typeof originalCreateApproval>) => {
        callOrder.push("approval");
        return originalCreateApproval(...args);
      });

    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
          autonomyState: "ALWAYS_APPROVE",
        });
        const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
        const outcome = await executeRun(tx, runId, [spec]);
        expect(outcome).toEqual({ status: "awaiting_approval", runId });
      });

      expect(callOrder).toEqual(["grant", "policy", "budget", "approval"]);
    } finally {
      grantSpy.mockRestore();
      policySpy.mockRestore();
      budgetSpy.mockRestore();
      approvalSpy.mockRestore();
    }
  });

  it("ALLOW path (AUTONOMOUS grant) never calls createApproval", async () => {
    const approvalSpy = vi.spyOn(approvalsModule, "createApproval");
    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
          autonomyState: "AUTONOMOUS",
        });
        const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
        const outcome = await executeRun(tx, runId, [spec]);
        expect(outcome).toEqual({ status: "completed", runId });
      });
      expect(approvalSpy).not.toHaveBeenCalled();
    } finally {
      approvalSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. reauthorize + fresh reserveBudget are two separate calls on resume
// ---------------------------------------------------------------------------

describe("immediately-before-execution re-check on resume", () => {
  it("calls reauthorize and a fresh reserveBudget as two independent calls (not fused)", async () => {
    const callOrder: string[] = [];
    const originalReauthorize = approvalsModule.reauthorize;
    const originalReserveBudget = budgetModule.reserveBudget;

    const reauthorizeSpy = vi
      .spyOn(approvalsModule, "reauthorize")
      .mockImplementation(async (...args: Parameters<typeof originalReauthorize>) => {
        callOrder.push("reauthorize");
        return originalReauthorize(...args);
      });
    const reserveBudgetSpy = vi
      .spyOn(budgetModule, "reserveBudget")
      .mockImplementation(async (...args: Parameters<typeof originalReserveBudget>) => {
        // args[4] is the resourceUnit, args[5] the estimated amount — the unit
        // was inserted ahead of the amount when counters became per-unit.
        callOrder.push(`reserveBudget:${args[5]}`);
        return originalReserveBudget(...args);
      });

    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
          autonomyState: "ALWAYS_APPROVE",
        });
        const spec = buildToolSpec({ capabilityId, toolBindingId, permission, estimatedCost: 7 });

        await executeRun(tx, runId, [spec]);
        const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
        const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
        await resolveApproval(tx, approval!.id, "approved", "reviewer");

        reauthorizeSpy.mockClear();
        reserveBudgetSpy.mockClear();
        callOrder.length = 0;

        const outcome = await executeRun(tx, runId, [spec]);
        expect(outcome).toEqual({ status: "completed", runId });
      });

      // Exactly one reauthorize call and exactly one fresh reserveBudget call
      // during resumption — two distinct, independently-invoked functions,
      // not a single fused check.
      expect(reauthorizeSpy).toHaveBeenCalledTimes(1);
      expect(reserveBudgetSpy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["reauthorize", "reserveBudget:7"]);
    } finally {
      reauthorizeSpy.mockRestore();
      reserveBudgetSpy.mockRestore();
    }
  });

  it("reauthorization failure (Grant revoked after approval) releases the reservation and fails the Run", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "ALWAYS_APPROVE",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
      await executeRun(tx, runId, [spec]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      // Revoke the Grant after approval but before resumption.
      await tx
        .update(schema.capabilityGrants)
        .set({ revokedAt: new Date() })
        .where(eq(schema.capabilityGrants.capabilityId, capabilityId));

      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(spec.execute).not.toHaveBeenCalled();

      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. DENY and insufficient-budget paths fail the invocation AND the Run
// ---------------------------------------------------------------------------

describe("tool invocation DENY / insufficient budget", () => {
  it("DENY (no Grant) fails the invocation and the Run, without ever reserving budget", async () => {
    const budgetSpy = vi.spyOn(budgetModule, "reserveBudget");
    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, { withGrant: false });
        const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
        const outcome = await executeRun(tx, runId, [spec]);
        expect(outcome).toEqual({ status: "failed", runId });
        expect(spec.execute).not.toHaveBeenCalled();

        const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
        expect(invocation?.status).toBe("failed");
        const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
        expect(run?.status).toBe("failed");

        const failedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
        });
        expect(failedEvent).toBeDefined();
      });
      expect(budgetSpy).not.toHaveBeenCalled();
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it("insufficient budget on the ALLOW path fails the invocation and the Run without executing", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
        limitAmount: "1.00",
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission, estimatedCost: 100 });
      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  it("a thrown execute() releases the reservation and fails the invocation + Run", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
        limitAmount: "10.00",
      });
      const spec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        estimatedCost: 5,
        execute: vi.fn(async () => {
          throw new Error("tool blew up");
        }),
      });
      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "failed", runId });

      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 5b. Final-review Finding 2: the Grant's trust bar, enforced end-to-end
// through the real executor path (no mocked Policy).
// ---------------------------------------------------------------------------

describe("tool invocation trust-level enforcement (Finding 2)", () => {
  it("a binding BELOW the Grant's maxTrustLevelRequired fails the invocation and Run, without reserving budget", async () => {
    const budgetSpy = vi.spyOn(budgetModule, "reserveBudget");
    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
          autonomyState: "AUTONOMOUS",
          trustLevel: 0, // unverified_third_party
          maxTrustLevelRequired: 1, // Grant demands at least verified
        });
        const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
        const outcome = await executeRun(tx, runId, [spec]);

        expect(outcome).toEqual({ status: "failed", runId });
        expect(spec.execute).not.toHaveBeenCalled();

        const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
        expect(invocation?.status).toBe("failed");
        const failedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
        });
        expect(failedEvent?.payload).toMatchObject({ reason: "policy_denied" });
      });
      expect(budgetSpy).not.toHaveBeenCalled();
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it("an unverified binding whose bar IS met halts for approval instead of executing autonomously", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
        trustLevel: 0,
        maxTrustLevelRequired: 0, // bar met, so the DENY rule cannot be what fires
      });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
      const outcome = await executeRun(tx, runId, [spec]);

      expect(outcome).toEqual({ status: "awaiting_approval", runId });
      expect(spec.execute).not.toHaveBeenCalled();

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      expect(approval?.status).toBe("pending");
    });
  });

  it("the trust values Policy receives come from the tool_bindings/capability_grants rows, never from the proposed action snapshot", async () => {
    const policySpy = vi.spyOn(policyModule, "evaluatePolicy");
    try {
      await withRollback(async (tx) => {
        const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
          autonomyState: "AUTONOMOUS",
          trustLevel: 0,
          maxTrustLevelRequired: 1,
        });
        // The snapshot is the only evaluatePolicy input a model's output can
        // reach. Here it lies in every direction at once: maximal binding
        // trust, a zero bar, and a first_party classification.
        const spec = buildToolSpec({
          capabilityId,
          toolBindingId,
          permission,
          proposedActionSnapshot: {
            action: "do-thing",
            trustLevel: "first_party",
            bindingTrustLevel: 9_000,
            maxTrustLevelRequired: 0,
          },
        });
        const outcome = await executeRun(tx, runId, [spec]);
        expect(outcome).toEqual({ status: "failed", runId });

        expect(policySpy).toHaveBeenCalledTimes(1);
        const received = policySpy.mock.calls[0]![1];
        // Server-resolved row values won, verbatim — not the snapshot's claims.
        expect(received.bindingTrustLevel).toBe(0);
        expect(received.trustLevel).toBe("unverified_third_party");
        expect(received.grant?.maxTrustLevelRequired).toBe(1);
        expect(await policySpy.mock.results[0]!.value).toMatchObject({ decision: "DENY" });
      });
    } finally {
      policySpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ALLOW path: reconcile + persist artifact + complete, no re-check
// ---------------------------------------------------------------------------

describe("tool invocation ALLOW path", () => {
  it("executes, reconciles budget with the estimated cost, persists the result as an artifact, and completes", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
        limitAmount: "10.00",
      });
      const spec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        estimatedCost: 4,
        execute: vi.fn(async () => ({ result: "ok" })),
      });

      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "completed", runId });

      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(4);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("completed");

      const artifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.producingInvocationId, invocation!.id),
      });
      expect(artifact?.inlineContent).toBe(JSON.stringify({ result: "ok" }));
      expect(artifact?.type).toBe("invocation_result");
    });
  });

  // Fix-round-1 (Important #2): reconcileBudget runs inside the try block,
  // and (before this fix) the catch unconditionally called releaseReservation
  // on the SAME reservation id. reconcileBudget/releaseReservation are NOT
  // idempotent (budget.ts's own header) — calling both double-decrements
  // reserved_amount with nothing to detect it. Reachable via
  // persistInvocationResultAsArtifact's JSON.stringify throwing a plain
  // TypeError (not a DB error, so the transaction survives) on a tool result
  // containing a BigInt, which happens AFTER reconcileBudget already
  // succeeded.
  it("a tool result that JSON.stringify can't serialize fails cleanly WITHOUT double-releasing the already-reconciled reservation", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, {
        autonomyState: "AUTONOMOUS",
        limitAmount: "10.00",
      });
      const spec = buildToolSpec({
        capabilityId,
        toolBindingId,
        permission,
        estimatedCost: 4,
        execute: vi.fn(async () => ({ bad: 10n })),
      });

      const outcome = await executeRun(tx, runId, [spec]);
      expect(outcome).toEqual({ status: "failed", runId });

      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
      // reconcileBudget already ran (released the 4-unit estimate, added 4 to
      // consumed) before persistInvocationResultAsArtifact's throw. A double
      // release would drive reservedAmount NEGATIVE (-4) instead of 0.
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(4);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. "llm" kind: no Policy, Unit 5 owns started/completed, Executor owns failed
// ---------------------------------------------------------------------------

describe('"llm" kind orchestration', () => {
  it("never calls evaluatePolicy/computeRiskTier's grant-based path (no Grant/Policy step at all for llm)", async () => {
    const policySpy = vi.spyOn(policyModule, "evaluatePolicy");
    try {
      await withRollback(async (tx) => {
        const { runId } = await seedGenericRunFixture(tx);
        vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
          result: { text: "hi" },
          usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
        });
        const outcome = await executeRun(tx, runId, [buildLlmSpec()]);
        expect(outcome).toEqual({ status: "completed", runId });
      });
      expect(policySpy).not.toHaveBeenCalled();
    } finally {
      policySpy.mockRestore();
    }
  });

  it("does not duplicate invocation_started/invocation_completed (Unit 5 already emits them)", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { text: "hi" },
        usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
      });
      await executeRun(tx, runId, [buildLlmSpec()]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const startedEvents = await tx.query.events.findMany({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_started")),
      });
      const completedEvents = await tx.query.events.findMany({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_completed")),
      });
      expect(startedEvents.length).toBe(1);
      expect(startedEvents[0]!.producer).toBe("model-router");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.producer).toBe("model-router");

      expect(invocation?.status).toBe("completed");
      const artifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.producingInvocationId, invocation!.id),
      });
      expect(artifact).toBeDefined();
      expect(artifact?.inlineContent).toBe(JSON.stringify({ text: "hi" }));
    });
  });

  it("authorizeRoute {authorized:false} (insufficient budget) fails the invocation + Run; Executor emits invocation_failed itself", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx, { limitAmount: "0.00" });
      // Max is the routed primary, so the reservation is in tokens: exhaust
      // that counter too, or the invocation would be authorized.
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "0" })
        .where(eq(schema.budgetCounters.scopeRefId, runId));
      const outcome = await executeRun(tx, runId, [buildLlmSpec()]);
      expect(outcome).toEqual({ status: "failed", runId });

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("failed");
      const failedEvent = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.producer).toBe("executor");

      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(run?.status).toBe("failed");
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    });
  });

  it("a thrown callModel error fails the invocation + Run; Executor emits invocation_failed itself", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(new Error("provider boom"));
      const outcome = await executeRun(tx, runId, [buildLlmSpec()]);
      expect(outcome).toEqual({ status: "failed", runId });

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("failed");
      const failedEvent = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.payload).toMatchObject({ reason: expect.stringContaining("provider boom") });
    });
  });

  // Fix-round-1 (Important #1): the existing "thrown callModel error" test
  // above only checked invocation status/event — it never asserted the
  // budget_counters state, which is exactly why the reservation leak wasn't
  // caught by the original green suite. `authorizeRoute` reserves budget and
  // returns the handle on `route.reservationId`; before this fix, a thrown
  // compileContext/provider error never released it, permanently inflating
  // `reserved_amount` on the run's budget_counters row.
  // Phase 9 corrected two things here. The counter asserted is the one the LLM
  // leg actually reserves in (subscription_tokens — this test previously read
  // the untouched usd counter and passed vacuously). And a failed dispatch no
  // longer always releases: it releases only when the provider declares it
  // consumed nothing, and otherwise charges the estimate.
  async function llmTokenCounter(tx: DrizzleTransaction, runId: string) {
    const row = await tx.query.budgetCounters.findFirst({
      where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "subscription_tokens")),
    });
    return { reserved: Number(row!.reservedAmount), consumed: Number(row!.consumedAmount) };
  }

  async function failedPayload(tx: DrizzleTransaction, runId: string) {
    const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
    const event = await tx.query.events.findFirst({
      where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
    });
    return event!.payload as Record<string, unknown>;
  }

  it("a provider failure that consumed nothing releases the reservation authorizeRoute made (no leak)", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx, { limitAmount: "10.00" });
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(
        Object.assign(new Error("login expired"), { consumption: "none" as const })
      );

      expect(await executeRun(tx, runId, [buildLlmSpec()])).toEqual({ status: "failed", runId });
      // Returned to the pre-call baseline — not left inflated by a leaked reservation.
      expect(await llmTokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: 0 });
      expect(await failedPayload(tx, runId)).toMatchObject({ reservationSettlement: "released" });
    });
  });

  it("a provider failure of unknown consumption (e.g. a timeout) charges the reservation at its estimate", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx, { limitAmount: "10.00" });
      vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(new Error("provider boom"));

      expect(await executeRun(tx, runId, [buildLlmSpec()])).toEqual({ status: "failed", runId });
      const payload = await failedPayload(tx, runId);
      expect(payload).toMatchObject({ reservationSettlement: "charged_at_estimate", resourceUnit: "subscription_tokens" });
      const counter = await llmTokenCounter(tx, runId);
      expect(counter.reserved).toBe(0);
      expect(counter.consumed).toBe(Number(payload.chargedAmount));
      expect(counter.consumed).toBeGreaterThan(0);
    });
  });

  // Same failure class as Important #2 (tool path), found while fixing
  // Important #1 for consistency: once callModel returns successfully it has
  // ALREADY reconciled route.reservationId (Unit 5's own success path).
  // persistInvocationResultAsArtifact's JSON.stringify throws a plain
  // TypeError (not a DB error — does not abort the transaction) on a result
  // containing a BigInt, which happens AFTER that reconcile. Without the
  // `reconciled` flag guard, the catch would call releaseReservation on an
  // already-reconciled id, double-decrementing reserved_amount.
  it("a post-reconcile failure (BigInt result, not JSON-serializable) does not double-release the already-reconciled reservation", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx, { limitAmount: "10.00" });

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { bad: 10n },
        usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
      });

      const outcome = await executeRun(tx, runId, [buildLlmSpec()]);
      expect(outcome).toEqual({ status: "failed", runId });

      // The LLM leg reconciles in TOKENS now that Claude Max is the routed
      // primary, so the assertion follows the unit the reservation was made in.
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, runId),
          eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
        ),
      });
      // callModel's own reconcile already ran (released the estimate, recorded
      // actual usage as consumed) before our JSON.stringify throw. reservedAmount
      // must land at exactly 0 — a double release would drive it NEGATIVE.
      expect(Number(counter!.reservedAmount)).toBe(0);
      expect(Number(counter!.consumedAmount)).toBe(15);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("failed");

      // Exactly ONE terminal event: completion is only recorded once the result
      // is persisted, so a persistence failure cannot leave both in the log.
      const terminal = await tx.query.events.findMany({
        where: and(eq(schema.events.invocationId, invocation!.id)),
      });
      expect(terminal.map((e) => e.eventType).filter((t) => t === "invocation_completed" || t === "invocation_failed")).toEqual([
        "invocation_failed",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Resumability / idempotency on re-entry after full completion
// ---------------------------------------------------------------------------

describe("executeRun resumability", () => {
  it("re-invoking after full completion is a no-op (never re-executes a completed invocation)", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      const execute = vi.fn(async () => ({ once: true }));
      const spec = buildDeterministicSpec(execute);

      const first = await executeRun(tx, runId, [spec]);
      expect(first).toEqual({ status: "completed", runId });
      expect(execute).toHaveBeenCalledTimes(1);

      const second = await executeRun(tx, runId, [spec]);
      expect(second).toEqual({ status: "completed", runId });
      expect(execute).toHaveBeenCalledTimes(1); // not called again
    });
  });

  it("re-invoking after the Run has failed short-circuits to {status:'failed'} without re-processing specs", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId, permission } = await seedToolRunFixture(tx, { withGrant: false });
      const spec = buildToolSpec({ capabilityId, toolBindingId, permission });
      await executeRun(tx, runId, [spec]);

      const secondSpecExecute = vi.fn(async () => ({}));
      const outcome = await executeRun(tx, runId, [spec, buildDeterministicSpec(secondSpecExecute)]);
      expect(outcome).toEqual({ status: "failed", runId });
      expect(secondSpecExecute).not.toHaveBeenCalled();
    });
  });

  it("skips an invocation already marked completed for its seqNo, without re-executing it, and proceeds to the next spec", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedGenericRunFixture(tx);
      const firstExecute = vi.fn(async () => ({ first: true }));
      const secondExecute = vi.fn(async () => ({ second: true }));

      // Pre-insert a completed invocation row for seqNo 1, simulating a prior
      // successful executeRun call for spec 0 that already committed in an
      // earlier transaction — Unit 6's actual resumability contract: a LATER
      // call with the SAME specs array resumes from that exact point rather
      // than restarting from index 0.
      await tx.insert(schema.invocations).values({
        runId,
        seqNo: 1,
        kind: "deterministic",
        costClass: "deterministic",
        status: "completed",
        idempotencyKey: `run:${runId}:seq:1`,
      });

      const outcome = await executeRun(tx, runId, [
        buildDeterministicSpec(firstExecute),
        buildDeterministicSpec(secondExecute),
      ]);

      expect(outcome).toEqual({ status: "completed", runId });
      expect(firstExecute).not.toHaveBeenCalled(); // already completed — never re-executed
      expect(secondExecute).toHaveBeenCalledTimes(1); // processed fresh, continuing the loop
    });
  });
});

// ---------------------------------------------------------------------------
// 9. persistInvocationResultAsArtifact <-> compileContext integration
// ---------------------------------------------------------------------------

describe("persistInvocationResultAsArtifact integration with compileContext (Units 4 + 6)", () => {
  it("creates a real artifacts row with producing_invocation_id set, and the returned artifactId resolves as a ContextCandidate.id", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId } = await seedGenericRunFixture(tx);
      const spec = buildDeterministicSpec(async () => ({ hello: "world" }));
      await executeRun(tx, runId, [spec]);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      const artifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.producingInvocationId, invocation!.id),
      });
      expect(artifact).toBeDefined();
      expect(artifact?.producingInvocationId).toBe(invocation!.id);

      const compiled = await compileContext(tx, {
        intent: "summarize",
        taskInstanceId,
        candidateArtifactIds: [artifact!.id],
        candidateToolCapabilityIds: [],
        budget: {
          maxInputTokens: 10_000,
          maxArtifactTokens: 2_000,
          maxRetrievedItems: 50,
          maxToolSchemaTokens: 2_000,
          compressionThreshold: 2_000,
          freshnessRequirementSeconds: 0,
          expectedOutputTokens: 100,
        },
      });

      expect(compiled.provenance.included).toContainEqual({ id: artifact!.id, tier: 2 });
      expect(compiled.layers.artifacts).toContain(JSON.stringify({ hello: "world" }));
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Structural checks
// ---------------------------------------------------------------------------

describe("structural checks", () => {
  it("no file under src/execution imports a provider SDK directly", () => {
    const executionDir = fileURLToPath(new URL("../../src/execution", import.meta.url));
    for (const entry of readdirSync(executionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(path.join(executionDir, entry.name), "utf8");
      expect(source).not.toMatch(/from\s+["'](@anthropic-ai\/sdk|openai)["']/);
    }
  });

  it("executor.ts never references createWorkflowTaskInstance (standalone-vs-workflow path separation)", () => {
    const executorPath = fileURLToPath(new URL("../../src/execution/executor.ts", import.meta.url));
    const source = readFileSync(executorPath, "utf8");
    expect(source).not.toMatch(/createWorkflowTaskInstance/);
  });
});

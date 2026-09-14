/**
 * Emergency stop — frozen spec Phase 9.7.
 *
 * Four properties, each written so the implementation cannot pass while
 * violating it:
 *
 *  1. EVERY SCOPE BLOCKS. global, agent_definition, capability_grant,
 *     workflow_run and run each prevent dispatch — through the REAL Executor,
 *     not a unit call to the check.
 *  2. EVERY KIND IS COVERED. Including the deterministic path, which has no
 *     other governance at all.
 *  3. IT FAILS CLOSED. A broken lookup refuses; it never degrades to allow.
 *  4. A STOP COMMITTED ELSEWHERE IS SEEN MID-RUN. Proven with two real
 *     connections — the property that silently breaks if anyone raises the
 *     isolation level above READ COMMITTED.
 *
 * Provider adapters are mocked: this file drives `executeRun`, which can reach
 * dispatch, so it must never be able to spawn the real Claude CLI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb, deleteEventsForTest } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CapabilityPermission } from "../../src/governance/policy.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  callClaudeSubscriptionModel: vi.fn(),
}));

import { executeRun } from "../../src/execution/executor.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";
import { emitEvent } from "../../src/events/emit.js";
import {
  resolveApproval,
  revokeCapabilityGrant,
  GRANT_REVOCATION_ACTOR,
} from "../../src/governance/approvals.js";
import { createPool } from "../../src/db/client.js";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  assertCapabilityGrantsNotStopped,
  assertNotStopped,
  engageStop,
  liftStop,
  listActiveStops,
  findActiveStops,
  recordStopEvent,
  stopScopeKeys,
  ExecutionStoppedError,
  GLOBAL_STOP_REF,
  V1_STOP_ACTOR,
  EXECUTION_STOP_ENGAGED,
  EXECUTION_STOP_LIFTED,
} from "../../src/governance/executionStop.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const PERMISSION: CapabilityPermission = "READ";

/** A complete, FK-valid chain bound to an agent, inside a workflow run. */
async function seedChain(
  tx: DrizzleTransaction,
  opts: { autonomyState?: "AUTONOMOUS" | "ALWAYS_APPROVE" } = {}
) {
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
    .values({ name: "agent-" + randomUUID(), version: 1, role: "r", objective: "o", instructions: "i" })
    .returning();
  const [grant] = await tx
    .insert(schema.capabilityGrants)
    .values({
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      capabilityId: capability!.id,
      permissions: [PERMISSION],
      maxTrustLevelRequired: 1,
      autonomyState: opts.autonomyState ?? "AUTONOMOUS",
    })
    .returning();

  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [workflowDefinition] = await tx
    .insert(schema.workflowDefinitions)
    .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: {} })
    .returning();
  const [goal] = await tx
    .insert(schema.goals)
    .values({ projectId: project!.id, title: "g", status: "active" })
    .returning();
  const [workflowRun] = await tx
    .insert(schema.workflowRuns)
    .values({
      workflowDefinitionId: workflowDefinition!.id,
      workflowDefinitionVersion: 1,
      goalId: goal!.id,
      status: "in_progress",
    })
    .returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: 1,
      projectId: project!.id,
      workflowRunId: workflowRun!.id,
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

  return {
    runId: run!.id,
    agentDefinitionId: agentDefinition!.id,
    grantId: grant!.id,
    capabilityId: capability!.id,
    toolBindingId: toolBinding!.id,
    workflowRunId: workflowRun!.id,
    goalId: goal!.id,
  };
}

/** A fresh, funded Run bound to the same agent as an existing chain's Run. */
async function seedRunForAgent(
  tx: DrizzleTransaction,
  boundTo: { agentDefinitionId: string | null; agentDefinitionVersion: number | null; taskInstanceId: string }
) {
  const [run] = await tx
    .insert(schema.runs)
    .values({
      taskInstanceId: boundTo.taskInstanceId,
      agentDefinitionId: boundTo.agentDefinitionId,
      agentDefinitionVersion: boundTo.agentDefinitionVersion,
      status: "active",
    })
    .returning();
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

function deterministicSpec(execute = vi.fn(async () => ({}))) {
  return { kind: "deterministic" as const, costClass: "deterministic" as const, execute };
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

function toolSpec(ids: { capabilityId: string; toolBindingId: string }, permission: CapabilityPermission = PERMISSION) {
  return {
    kind: "tool" as const,
    costClass: "metered_api" as const,
    capabilityId: ids.capabilityId,
    toolBindingId: ids.toolBindingId,
    permission,
    proposedActionSnapshot: { action: "read" },
    estimatedCost: 1,
    execute: vi.fn(async () => ({ ok: true })),
  };
}

async function runOutcome(tx: DrizzleTransaction, runId: string) {
  return tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
}

// ---------------------------------------------------------------------------
// 1. Every scope blocks, through the real Executor
// ---------------------------------------------------------------------------

describe("every scope halts execution before dispatch", () => {
  it("global stop blocks an invocation", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "global", reason: "incident" });

      const outcome = await executeRun(tx, ids.runId, [spec]);

      expect(outcome).toEqual({ status: "failed", runId: ids.runId });
      expect(spec.execute).not.toHaveBeenCalled();
      const run = await runOutcome(tx, ids.runId);
      expect(run!.outcome).toMatchObject({ reason: "execution_stopped", stopScope: "global" });
    });
  });

  it("agent_definition stop blocks a run bound to that agent", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "agent_definition", scopeRefId: ids.agentDefinitionId });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await runOutcome(tx, ids.runId))!.outcome).toMatchObject({ stopScope: "agent_definition" });
    });
  });

  it("capability_grant stop blocks a tool invocation using that grant", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = toolSpec(ids);
      await engageStop(tx, { scope: "capability_grant", scopeRefId: ids.grantId });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await runOutcome(tx, ids.runId))!.outcome).toMatchObject({ stopScope: "capability_grant" });

      // The invocation row is left TERMINAL, not dangling in "proposed" — a
      // non-terminal row would make a later executeRun throw on re-entry.
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      expect(invocation!.status).toBe("failed");
    });
  });

  it("workflow_run stop blocks execution within that workflow run", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "workflow_run", scopeRefId: ids.workflowRunId });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await runOutcome(tx, ids.runId))!.outcome).toMatchObject({ stopScope: "workflow_run" });
    });
  });

  it("run stop blocks that run", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "run", scopeRefId: ids.runId });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  it("a stop on a DIFFERENT target does not block this run", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "agent_definition", scopeRefId: randomUUID() });
      await engageStop(tx, { scope: "run", scopeRefId: randomUUID() });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("completed");
      expect(spec.execute).toHaveBeenCalledTimes(1);
    });
  });

  it("respects every one of several simultaneous stops", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      await engageStop(tx, { scope: "agent_definition", scopeRefId: ids.agentDefinitionId });
      await engageStop(tx, { scope: "run", scopeRefId: ids.runId });

      // Lifting ONE of two applicable stops must not release the run.
      await liftStop(tx, { scope: "run", scopeRefId: ids.runId });
      const spec = deterministicSpec();
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Every invocation kind is covered
// ---------------------------------------------------------------------------

describe("the check covers every invocation kind", () => {
  it("blocks an LLM invocation before any budget is reserved or provider called", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      await engageStop(tx, { scope: "global" });

      expect((await executeRun(tx, ids.runId, [llmSpec()])).status).toBe("failed");
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();

      // Checked at the loop top, so no reservation was ever taken to strand.
      const counters = await tx
        .select()
        .from(schema.budgetCounters)
        .where(eq(schema.budgetCounters.scopeRefId, ids.runId));
      for (const c of counters) expect(Number(c.reservedAmount)).toBe(0);
    });
  });

  it("blocks a tool invocation", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = toolSpec(ids);
      await engageStop(tx, { scope: "global" });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  it("blocks a retrieval invocation", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const execute = vi.fn(async () => ({ items: [] }));
      await engageStop(tx, { scope: "global" });

      const outcome = await executeRun(tx, ids.runId, [
        { kind: "retrieval" as const, costClass: "local_retrieval" as const, execute },
      ]);
      expect(outcome.status).toBe("failed");
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("blocks a deterministic/free invocation — the path with no other governance at all", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "global" });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  it("does not even resolve a deferred spec thunk while stopped", async () => {
    // Thunks can read and write the database, so gating only the dispatch
    // statement would leave real work reachable under a stop.
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const thunk = vi.fn(async () => deterministicSpec());
      await engageStop(tx, { scope: "global" });

      await executeRun(tx, ids.runId, [thunk]);
      expect(thunk).not.toHaveBeenCalled();
    });
  });

  it("a stop engaged BETWEEN invocation 1 and 2 prevents invocation 2", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);

      // Invocation 1 engages a stop as its side effect; the Executor must
      // re-check before invocation 2 rather than rely on a check made once.
      const first = vi.fn(async () => {
        await engageStop(tx, { scope: "run", scopeRefId: ids.runId });
        return {};
      });
      const second = deterministicSpec();

      const outcome = await executeRun(tx, ids.runId, [deterministicSpec(first), second]);

      expect(first).toHaveBeenCalledTimes(1);
      expect(second.execute).not.toHaveBeenCalled();
      expect(outcome.status).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Fail closed
// ---------------------------------------------------------------------------

describe("fail closed", () => {
  it("refuses when the stop lookup itself throws", async () => {
    const brokenTx = {
      select: () => {
        throw new Error("connection lost");
      },
    } as unknown as DrizzleTransaction;

    await expect(assertNotStopped(brokenTx, { runId: randomUUID() })).rejects.toBeInstanceOf(
      ExecutionStoppedError
    );
    await expect(assertNotStopped(brokenTx, { runId: randomUUID() })).rejects.toThrow(/fail closed/);
  });

  it("never returns silently when the lookup fails", async () => {
    const brokenTx = {
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("relation does not exist");
          },
        }),
      }),
    } as unknown as DrizzleTransaction;

    let allowed = false;
    try {
      await assertNotStopped(brokenTx, { runId: randomUUID() });
      allowed = true;
    } catch {
      /* refused, as required */
    }
    expect(allowed).toBe(false);
  });

  it("refuses when the capability_grant stop lookup itself throws", async () => {
    const brokenTx = {
      query: {
        runs: {
          findFirst: async () => {
            throw new Error("connection lost");
          },
        },
      },
    } as unknown as DrizzleTransaction;

    const failed = await assertCapabilityGrantsNotStopped(brokenTx, {
      runId: randomUUID(),
      capabilityId: randomUUID(),
      permission: "WRITE",
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ExecutionStoppedError);
    expect((failed as ExecutionStoppedError).lookupFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Lifting, idempotency, and non-widening
// ---------------------------------------------------------------------------

describe("lifting and lifecycle", () => {
  it("clearing a stop permits future execution under normal policy", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      await engageStop(tx, { scope: "global" });
      expect((await executeRun(tx, ids.runId, [deterministicSpec()])).status).toBe("failed");

      await liftStop(tx, { scope: "global" });

      // A FRESH run proceeds. The stopped run stays failed — lifting is
      // forward-only and never retroactively authorizes refused work.
      const fresh = await seedChain(tx);
      const spec = deterministicSpec();
      expect((await executeRun(tx, fresh.runId, [spec])).status).toBe("completed");
      expect(spec.execute).toHaveBeenCalledTimes(1);
      expect((await runOutcome(tx, ids.runId))!.status).toBe("failed");
    });
  });

  it("lifting a stop never bypasses Policy: an ungranted tool is still denied", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      await engageStop(tx, { scope: "global" });
      await liftStop(tx, { scope: "global" });

      // Revoke the grant. With no stop active, Policy must still DENY.
      await tx
        .update(schema.capabilityGrants)
        .set({ revokedAt: new Date() })
        .where(eq(schema.capabilityGrants.id, ids.grantId));

      const spec = toolSpec(ids);
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
    });
  });

  it("lifting a stop never bypasses the budget: an exhausted run is still refused", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      await engageStop(tx, { scope: "global" });
      await liftStop(tx, { scope: "global" });
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "0" })
        .where(eq(schema.budgetCounters.scopeRefId, ids.runId));

      expect((await executeRun(tx, ids.runId, [llmSpec()])).status).toBe("failed");
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      // No stop was involved: the refusal is the budget's, unchanged.
      expect((await runOutcome(tx, ids.runId))!.outcome).not.toMatchObject({ reason: "execution_stopped" });
    });
  });

  it("engaging twice is idempotent: one active row, same stop returned", async () => {
    await withRollback(async (tx) => {
      const a = await engageStop(tx, { scope: "global", reason: "first" });
      const b = await engageStop(tx, { scope: "global", reason: "second" });

      expect(b.id).toBe(a.id);
      const active = (await listActiveStops(tx)).filter((s) => s.scope === "global");
      expect(active).toHaveLength(1);
    });
  });

  it("the database itself forbids two active stops for one scope key", async () => {
    const scopeRefId = randomUUID();
    await testDb.insert(schema.executionStops).values({ scope: "run", scopeRefId, engagedBy: "test" });
    try {
      let caught: unknown;
      try {
        await testDb.insert(schema.executionStops).values({ scope: "run", scopeRefId, engagedBy: "test" });
      } catch (error) {
        caught = error;
      }
      const detail =
        (caught as { cause?: { constraint?: string; message?: string } })?.cause?.constraint ??
        (caught as { cause?: { message?: string } })?.cause?.message ??
        String(caught);
      expect(detail).toMatch(/execution_stops_active_scope_idx/);
    } finally {
      await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, scopeRefId));
    }
  });

  it("lifting nothing returns null rather than throwing", async () => {
    await withRollback(async (tx) => {
      expect(await liftStop(tx, { scope: "run", scopeRefId: randomUUID() })).toBeNull();
    });
  });

  it("requires a target for every non-global scope", async () => {
    await withRollback(async (tx) => {
      await expect(engageStop(tx, { scope: "run", scopeRefId: "  " })).rejects.toThrow(/requires a scopeRefId/);
      await expect(liftStop(tx, { scope: "agent_definition" })).rejects.toThrow(/requires a scopeRefId/);
    });
  });

  it("records engage and lift as immutable events with a server-side actor and no run correlation", async () => {
    await withRollback(async (tx) => {
      const stop = await engageStop(tx, { scope: "global", reason: "audit" });
      await recordStopEvent(tx, stop, "engaged");
      const liftedStop = await liftStop(tx, { scope: "global" });
      await recordStopEvent(tx, liftedStop!, "lifted");

      const engaged = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `${EXECUTION_STOP_ENGAGED}:${stop.id}`),
      });
      const lifted = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `${EXECUTION_STOP_LIFTED}:${stop.id}`),
      });
      expect(engaged!.actor).toBe(V1_STOP_ACTOR);
      expect(lifted!.actor).toBe(V1_STOP_ACTOR);
      expect(engaged!.costUnit).toBeNull();
      // No run correlation, so recording a stop never waits on a live Run's
      // advisory lock. The target is in the payload instead.
      expect(engaged!.runId).toBeNull();
      expect(lifted!.runId).toBeNull();
      expect(engaged!.payload).toMatchObject({ stopId: stop.id, scope: "global" });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Scope matching is exact
// ---------------------------------------------------------------------------

describe("scope matching", () => {
  it("never matches a stop on one scope against the same identifier at another scope", async () => {
    await withRollback(async (tx) => {
      const shared = randomUUID();
      await engageStop(tx, { scope: "agent_definition", scopeRefId: shared });

      // Same identifier, but presented as a RUN — must not match.
      expect(await findActiveStops(tx, [{ scope: "run", scopeRefId: shared }])).toHaveLength(0);
      expect(
        await findActiveStops(tx, [{ scope: "agent_definition", scopeRefId: shared }])
      ).toHaveLength(1);
    });
  });

  it("drops null identifiers instead of matching them", () => {
    const keys = stopScopeKeys({ agentDefinitionId: null, capabilityGrantId: undefined, workflowRunId: null });
    expect(keys).toEqual([{ scope: "global", scopeRefId: GLOBAL_STOP_REF }]);
  });

  it("always includes the global scope", () => {
    expect(stopScopeKeys({}).map((k) => k.scope)).toEqual(["global"]);
  });
});

// ---------------------------------------------------------------------------
// 6. A stop committed on another connection is seen mid-transaction
// ---------------------------------------------------------------------------

describe("synchronous visibility across connections (READ COMMITTED)", () => {
  function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it(
    "an in-flight transaction observes a stop committed by a different connection",
    async () => {
      // Run-scoped on a random id, never global: a committed global stop would
      // halt every other test file sharing this database.
      const runRef = randomUUID();
      const firstChecked = createDeferred();
      const stopCommitted = createDeferred();

      try {
        const inflight = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          const before = await findActiveStops(tx, [{ scope: "run", scopeRefId: runRef }]);
          firstChecked.resolve();
          await stopCommitted.promise;
          const after = await findActiveStops(tx, [{ scope: "run", scopeRefId: runRef }]);
          return { before: before.length, after: after.length };
        });

        await firstChecked.promise;
        await testDb.transaction((tx) => engageStop(tx, { scope: "run", scopeRefId: runRef }));
        stopCommitted.resolve();

        // If this ever reads { before: 0, after: 0 }, the isolation level was
        // raised and the emergency stop no longer reaches in-flight runs.
        expect(await inflight).toEqual({ before: 0, after: 1 });
      } finally {
        await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, runRef));
        await deleteEventsForTest(eq(schema.events.runId, runRef));
        // Stop events carry no run correlation; their target is in the payload.
        await deleteEventsForTest(sql`${schema.events.payload}->>'scopeRefId' = ${runRef}`);
      }
    },
    20000
  );

  it("the pool production builds (src/db/client.ts) opens READ COMMITTED transactions", async () => {
    // The test above uses the test pool; this pins the production pool options and the server default.
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    try {
      const level = await drizzle(pool).transaction(async (tx) => (await tx.execute(sql`show transaction_isolation`)).rows[0]);
      expect(level).toEqual({ transaction_isolation: "read committed" });
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Control-plane API
// ---------------------------------------------------------------------------

describe("control-plane API", () => {
  it("engages, lists and lifts a stop, returning clear results", async () => {
    const app = buildServer({ db: testDb });
    const runRef = randomUUID();
    try {
      const engaged = await app.inject({
        method: "POST",
        url: "/execution-stops",
        payload: { scope: "run", scopeRefId: runRef, reason: "api test" },
      });
      expect(engaged.statusCode).toBe(201);
      expect(engaged.json().stop).toMatchObject({ scope: "run", scopeRefId: runRef });

      const listed = await app.inject({ method: "GET", url: "/execution-stops" });
      expect(listed.json().stops.some((s: { scopeRefId: string }) => s.scopeRefId === runRef)).toBe(true);

      const lifted = await app.inject({
        method: "POST",
        url: "/execution-stops/lift",
        payload: { scope: "run", scopeRefId: runRef },
      });
      expect(lifted.statusCode).toBe(200);

      const liftAgain = await app.inject({
        method: "POST",
        url: "/execution-stops/lift",
        payload: { scope: "run", scopeRefId: runRef },
      });
      expect(liftAgain.statusCode).toBe(404);
    } finally {
      await app.close();
      await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, runRef));
      await deleteEventsForTest(eq(schema.events.runId, runRef));
      // Stop events carry no run correlation; their target is in the payload.
      await deleteEventsForTest(sql`${schema.events.payload}->>'scopeRefId' = ${runRef}`);
    }
  });

  it("rejects an invalid scope or a missing target with 400", async () => {
    const app = buildServer({ db: testDb });
    try {
      const badScope = await app.inject({ method: "POST", url: "/execution-stops", payload: { scope: "planet" } });
      expect(badScope.statusCode).toBe(400);

      const noTarget = await app.inject({ method: "POST", url: "/execution-stops", payload: { scope: "run" } });
      expect(noTarget.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("ignores any caller-supplied actor: the audit identity is server-side", async () => {
    const app = buildServer({ db: testDb });
    const runRef = randomUUID();
    try {
      await app.inject({
        method: "POST",
        url: "/execution-stops",
        payload: { scope: "run", scopeRefId: runRef, engagedBy: "system", actor: "attacker" },
      });
      const row = await testDb.query.executionStops.findFirst({
        where: and(eq(schema.executionStops.scopeRefId, runRef)),
      });
      expect(row!.engagedBy).toBe(V1_STOP_ACTOR);
    } finally {
      await app.close();
      await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, runRef));
      await deleteEventsForTest(eq(schema.events.runId, runRef));
      // Stop events carry no run correlation; their target is in the payload.
      await deleteEventsForTest(sql`${schema.events.payload}->>'scopeRefId' = ${runRef}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Regressions from independent adversarial review
// ---------------------------------------------------------------------------

describe("review regressions", () => {
  function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it(
    "a run-scoped stop commits and is seen by the Run WHILE that Run holds its own event lock",
    async () => {
      // THE CRITICAL FINDING. A live Run holds pg_advisory_xact_lock(hashtext
      // (runId)) from its first event onward. The stop used to be written in
      // the same transaction as an event correlated to that runId, so it could
      // not commit until the Run it was meant to halt had finished.
      //
      // Reproduces the real shape: the in-flight transaction WRITES an event
      // for the run (taking the lock) before the stop is engaged through the
      // real HTTP route on another connection.
      const runRef = randomUUID();
      const app = buildServer({ db: testDb });
      const holdingLock = createDeferred();
      const release = createDeferred();
      let stopId: string | undefined;

      try {
        const inflight = testDb.transaction(async (tx) => {
          await emitEvent(tx, {
            idempotencyKey: `c1-probe:${randomUUID()}`,
            eventType: "c1_probe",
            eventVersion: 1,
            causationId: null,
            correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runRef, invocationId: null },
            actor: "system",
            producer: "test",
            payload: {},
            usage: null,
          });
          holdingLock.resolve();
          await release.promise;
          // Still inside the Run's transaction, which has NOT committed.
          return (await findActiveStops(tx, [{ scope: "run", scopeRefId: runRef }])).length;
        });

        await holdingLock.promise;
        const engage = app.inject({
          method: "POST",
          url: "/execution-stops",
          payload: { scope: "run", scopeRefId: runRef },
        });
        const race = await Promise.race([
          engage.then(() => "committed" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5000)),
        ]);
        release.resolve();

        const seenMidRun = await inflight;
        const response = await engage;
        stopId = response.json().stop?.id;

        expect(race).toBe("committed");
        expect(seenMidRun).toBe(1);
      } finally {
        release.resolve();
        await app.close();
        await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, runRef));
        await deleteEventsForTest(eq(schema.events.runId, runRef));
        // Stop events carry no run correlation; their target is in the payload.
        await deleteEventsForTest(sql`${schema.events.payload}->>'scopeRefId' = ${runRef}`);
        if (stopId) {
          await deleteEventsForTest(eq(schema.events.idempotencyKey, `${EXECUTION_STOP_ENGAGED}:${stopId}`));
        }
      }
    },
    20000
  );

  it("a stop on a Run resuming after approval releases its budget hold and terminates the invocation", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);
      const usdCounter = () =>
        tx.query.budgetCounters.findFirst({
          where: and(eq(schema.budgetCounters.scopeRefId, ids.runId), eq(schema.budgetCounters.resourceUnit, "usd")),
        });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");
      expect(Number((await usdCounter())!.reservedAmount)).toBeGreaterThan(0);

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      await resolveApproval(tx, approval!.id, "approved", "human:operator");
      await engageStop(tx, { scope: "global" });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();

      // The hold taken before the approval halt is released, not stranded.
      const after = await usdCounter();
      expect(Number(after!.reservedAmount)).toBe(0);
      expect(Number(after!.consumedAmount)).toBe(0);

      // The invocation is terminal, and no pending handle is left behind.
      const resumed = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocation!.id) });
      expect(resumed!.status).toBe("failed");
      const run = await runOutcome(tx, ids.runId);
      const envelope = run!.budgetEnvelope as { pendingReservations?: Record<string, string> } | null;
      expect(envelope?.pendingReservations ?? {}).toEqual({});
    });
  });

  it(
    "two genuinely concurrent engages of the same scope both succeed with exactly one active stop",
    async () => {
      const runRef = randomUUID();
      const aStarted = createDeferred();
      const bStarted = createDeferred();

      try {
        const a = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          aStarted.resolve();
          await bStarted.promise;
          return engageStop(tx, { scope: "run", scopeRefId: runRef });
        });
        const b = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          bStarted.resolve();
          await aStarted.promise;
          return engageStop(tx, { scope: "run", scopeRefId: runRef });
        });

        const [stopA, stopB] = await Promise.all([a, b]);
        expect(stopA.id).toBe(stopB.id);

        const active = await testDb
          .select()
          .from(schema.executionStops)
          .where(and(eq(schema.executionStops.scopeRefId, runRef), isNull(schema.executionStops.liftedAt)));
        expect(active).toHaveLength(1);
      } finally {
        await testDb.delete(schema.executionStops).where(eq(schema.executionStops.scopeRefId, runRef));
      }
    },
    20000
  );

  it("rejects a non-global stop whose target is the global sentinel or not a uuid", async () => {
    await withRollback(async (tx) => {
      await expect(engageStop(tx, { scope: "run", scopeRefId: GLOBAL_STOP_REF })).rejects.toThrow(/uuid/);
      await expect(engageStop(tx, { scope: "agent_definition", scopeRefId: "not-a-uuid" })).rejects.toThrow(/uuid/);
    });

    const app = buildServer({ db: testDb });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/execution-stops",
        payload: { scope: "run", scopeRefId: "*" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("marks a lookup failure distinctly from an operator stop, so it is never recorded as one", async () => {
    const brokenTx = {
      select: () => {
        throw new Error("connection lost");
      },
    } as unknown as DrizzleTransaction;
    const failed = await assertNotStopped(brokenTx, { runId: randomUUID() }).catch((e: unknown) => e);
    expect((failed as ExecutionStoppedError).lookupFailed).toBe(true);

    await withRollback(async (tx) => {
      await engageStop(tx, { scope: "global" });
      const stopped = await assertNotStopped(tx, { runId: randomUUID() }).catch((e: unknown) => e);
      expect((stopped as ExecutionStoppedError).lookupFailed).toBe(false);
    });
  });

  it("honours an agent_definition stop for an agent the Run is rebound to mid-Run", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const [other] = await tx
        .insert(schema.agentDefinitions)
        .values({ name: "other-" + randomUUID(), version: 1, role: "r", objective: "o", instructions: "i" })
        .returning();
      await engageStop(tx, { scope: "agent_definition", scopeRefId: other!.id });

      // The first invocation rebinds the Run to the stopped agent.
      const rebind = vi.fn(async () => {
        await tx.update(schema.runs).set({ agentDefinitionId: other!.id }).where(eq(schema.runs.id, ids.runId));
        return {};
      });
      const second = deterministicSpec();

      const outcome = await executeRun(tx, ids.runId, [deterministicSpec(rebind), second]);

      expect(rebind).toHaveBeenCalledTimes(1);
      expect(second.execute).not.toHaveBeenCalled();
      expect(outcome.status).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Spec 9.7 completeness
// ---------------------------------------------------------------------------

describe("spec 9.7 completeness", () => {
  it("a goal stop blocks execution in any workflow run under that goal", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const spec = deterministicSpec();
      await engageStop(tx, { scope: "goal", scopeRefId: ids.goalId });

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
      expect((await runOutcome(tx, ids.runId))!.outcome).toMatchObject({ stopScope: "goal" });
    });
  });

  it("a goal stop does not block a run under a different goal", async () => {
    await withRollback(async (tx) => {
      const stopped = await seedChain(tx);
      const unrelated = await seedChain(tx);
      await engageStop(tx, { scope: "goal", scopeRefId: stopped.goalId });

      const spec = deterministicSpec();
      expect((await executeRun(tx, unrelated.runId, [spec])).status).toBe("completed");
      expect(spec.execute).toHaveBeenCalledTimes(1);
    });
  });

  it("a stop on a run with a still-PENDING approval closes that approval rather than orphaning it", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });

      // Stop BEFORE anyone decides the approval.
      await engageStop(tx, { scope: "global" });
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");

      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      // Terminal, attributed, and out of the pending queue.
      expect(approval!.status).toBe("expired");
      expect(approval!.resolvedBy).toBe("system:execution_stop");
      expect(spec.execute).not.toHaveBeenCalled();

      // Both terminal transitions are evented, not only written to rows.
      const expiredEvent = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `approval_expired:${approval!.id}`),
      });
      expect(expiredEvent!.invocationId).toBe(invocation!.id);
      const halted = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `run_halted:${ids.runId}`),
      });
      expect(halted!.payload).toMatchObject({ reason: "execution_stopped", stopScope: "global" });

      const usd = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scopeRefId, ids.runId), eq(schema.budgetCounters.resourceUnit, "usd")),
      });
      expect(Number(usd!.reservedAmount)).toBe(0);
    });
  });

  it("revoking a Grant auto-cancels ITS still-pending approvals, and only those", async () => {
    await withRollback(async (tx) => {
      const revoked = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const untouched = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });

      expect((await executeRun(tx, revoked.runId, [toolSpec(revoked)])).status).toBe("awaiting_approval");
      expect((await executeRun(tx, untouched.runId, [toolSpec(untouched)])).status).toBe("awaiting_approval");

      const approvalFor = async (runId: string) => {
        const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
        return tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      };

      const result = await revokeCapabilityGrant(tx, revoked.grantId);
      const revokedApproval = await approvalFor(revoked.runId);

      expect(result.revoked).toBe(true);
      expect(result.cancelledApprovalIds).toEqual([revokedApproval!.id]);
      expect(revokedApproval!.status).toBe("expired");
      expect(revokedApproval!.resolvedBy).toBe(GRANT_REVOCATION_ACTOR);

      // A different Grant's approval is not touched.
      expect((await approvalFor(untouched.runId))!.status).toBe("pending");

      const grant = await tx.query.capabilityGrants.findFirst({
        where: eq(schema.capabilityGrants.id, revoked.grantId),
      });
      expect(grant!.revokedAt).not.toBeNull();

      // The revocation and each cancellation are evented.
      expect(result.affectedRunIds).toEqual([revoked.runId]);
      const revokedEvent = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `capability_grant_revoked:${revoked.grantId}`),
      });
      expect(revokedEvent!.payload).toMatchObject({ grantId: revoked.grantId, cancelledApprovalIds: [revokedApproval!.id] });
      const expiredEvent = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `approval_expired:${revokedApproval!.id}`),
      });
      expect(expiredEvent!.runId).toBe(revoked.runId);
    });
  });

  it("a capability_grant stop engaged while an invocation awaits approval blocks it after approval", async () => {
    // CD-1: the resume path must check the Grant scope too. Park, stop the
    // Grant, approve, re-drive — the side effect must NOT run.
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");

      await engageStop(tx, { scope: "capability_grant", scopeRefId: ids.grantId });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      await resolveApproval(tx, approval!.id, "approved", "human:operator");

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();

      const usd = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scopeRefId, ids.runId), eq(schema.budgetCounters.resourceUnit, "usd")),
      });
      expect(Number(usd!.reservedAmount)).toBe(0);
      expect(Number(usd!.consumedAmount)).toBe(0);

      const resumed = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocation!.id) });
      expect(resumed!.status).toBe("failed");
      const halted = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `run_halted:${ids.runId}`),
      });
      expect(halted!.payload).toMatchObject({ stopScope: "capability_grant", stopScopeRefId: ids.grantId });
    });
  });

  it("a capability_grant stop engaged while the approval is still pending expires the approval on re-drive", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");

      await engageStop(tx, { scope: "capability_grant", scopeRefId: ids.grantId });
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      expect(approval!.status).toBe("expired");
      const expiredEvent = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `approval_expired:${approval!.id}`),
      });
      expect(expiredEvent).toBeDefined();
    });
  });

  it("an approved invocation whose only Grant was then revoked fails reauthorization, not the stop lookup", async () => {
    // Zero covering Grants on the resume-path stop check: nothing to stop-check,
    // so reauthorize must be what refuses it.
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      await resolveApproval(tx, approval!.id, "approved", "human:operator");
      await revokeCapabilityGrant(tx, ids.grantId);

      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("failed");
      expect(spec.execute).not.toHaveBeenCalled();
      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed!.payload).toMatchObject({ reason: "reauthorization_failed" });
    });
  });

  it("two parallel revocations of different covering Grants both succeed and expire the approval", async () => {
    // Setup is committed (cross-connection). NOTE: without a barrier inside
    // revokeCapabilityGrant this cannot force the two transactions to interleave
    // at the lock, so it pins the end state (no deadlock, no stranded approval)
    // but does not by itself prove the lock ordering — a weakened FOR SHARE
    // mutant still passed.
    const ids = await testDb.transaction((tx) => seedChain(tx, { autonomyState: "ALWAYS_APPROVE" }));
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.id, ids.runId) });
    const [second] = await testDb
      .insert(schema.capabilityGrants)
      .values({
        agentDefinitionId: run!.agentDefinitionId!,
        agentDefinitionVersion: run!.agentDefinitionVersion!,
        capabilityId: ids.capabilityId,
        permissions: [PERMISSION],
        maxTrustLevelRequired: 1,
        autonomyState: "ALWAYS_APPROVE",
      })
      .returning();
    await testDb.transaction(async (tx) => {
      expect((await executeRun(tx, ids.runId, [toolSpec(ids)])).status).toBe("awaiting_approval");
    });

    const results = await Promise.all([
      testDb.transaction((tx) => revokeCapabilityGrant(tx, ids.grantId)),
      testDb.transaction((tx) => revokeCapabilityGrant(tx, second!.id)),
    ]);
    expect(results.map((r) => r.revoked)).toEqual([true, true]);

    const invocation = await testDb.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
    const approval = await testDb.query.approvals.findFirst({
      where: eq(schema.approvals.invocationId, invocation!.id),
    });
    expect(approval!.status).toBe("expired");
  }, 30000);

  it("a stop on ANY covering Grant blocks — not only the Grant the resolver happened to pick", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, ids.runId) });
      // A second unrevoked Grant covering the very same action.
      const [second] = await tx
        .insert(schema.capabilityGrants)
        .values({
          agentDefinitionId: run!.agentDefinitionId!,
          agentDefinitionVersion: run!.agentDefinitionVersion!,
          capabilityId: ids.capabilityId,
          permissions: [PERMISSION],
          maxTrustLevelRequired: 1,
          autonomyState: "AUTONOMOUS",
        })
        .returning();

      // Stop each covering Grant in turn; either one alone must block.
      for (const grantId of [ids.grantId, second!.id]) {
        await engageStop(tx, { scope: "capability_grant", scopeRefId: grantId });
        const fresh = await seedRunForAgent(tx, run!);
        const spec = toolSpec(ids);
        expect((await executeRun(tx, fresh, [spec])).status).toBe("failed");
        expect(spec.execute).not.toHaveBeenCalled();
        await liftStop(tx, { scope: "capability_grant", scopeRefId: grantId });
      }
    });
  });

  it("revoking an already-revoked Grant is a no-op", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx);
      expect((await revokeCapabilityGrant(tx, ids.grantId)).revoked).toBe(true);
      expect(await revokeCapabilityGrant(tx, ids.grantId)).toEqual({
        revoked: false,
        cancelledApprovalIds: [],
        affectedRunIds: [],
      });
    });
  });

  it("does not cancel an approval that another, still-valid Grant on the same triple authorizes", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, ids.runId) });
      // A second Grant on the SAME (agent, version, capability) covering WRITE.
      await tx.insert(schema.capabilityGrants).values({
        agentDefinitionId: run!.agentDefinitionId!,
        agentDefinitionVersion: run!.agentDefinitionVersion!,
        capabilityId: ids.capabilityId,
        permissions: ["WRITE"],
        maxTrustLevelRequired: 1,
        autonomyState: "ALWAYS_APPROVE",
      });

      expect((await executeRun(tx, ids.runId, [toolSpec(ids, "WRITE")])).status).toBe("awaiting_approval");
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });

      // Revoke the READ Grant. The WRITE approval is governed by the other one.
      const result = await revokeCapabilityGrant(tx, ids.grantId);
      expect(result.cancelledApprovalIds).toEqual([]);
      const approval = await tx.query.approvals.findFirst({
        where: eq(schema.approvals.invocationId, invocation!.id),
      });
      expect(approval!.status).toBe("pending");
    });
  });

  it("re-driving a Run after revocation releases the stranded hold and ends the invocation and Run terminal", async () => {
    await withRollback(async (tx) => {
      const ids = await seedChain(tx, { autonomyState: "ALWAYS_APPROVE" });
      const spec = toolSpec(ids);
      expect((await executeRun(tx, ids.runId, [spec])).status).toBe("awaiting_approval");

      const usd = () =>
        tx.query.budgetCounters.findFirst({
          where: and(eq(schema.budgetCounters.scopeRefId, ids.runId), eq(schema.budgetCounters.resourceUnit, "usd")),
        });
      expect(Number((await usd())!.reservedAmount)).toBeGreaterThan(0);

      const { affectedRunIds } = await revokeCapabilityGrant(tx, ids.grantId);
      // Revocation alone does not touch budget: the hold is still reserved.
      expect(Number((await usd())!.reservedAmount)).toBeGreaterThan(0);

      // The documented contract: the caller re-drives each affected Run.
      for (const runId of affectedRunIds) {
        expect((await executeRun(tx, runId, [spec])).status).toBe("failed");
      }

      expect(Number((await usd())!.reservedAmount)).toBe(0);
      expect(spec.execute).not.toHaveBeenCalled();
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      expect(invocation!.status).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Structural: no dispatch path skips the check
// ---------------------------------------------------------------------------

describe("no execution path bypasses containment", () => {
  const source = readFileSync(path.join(process.cwd(), "src/execution/executor.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("checks containment before EVERY deferred-spec resolution inside executeRun", () => {
    const body = source.slice(source.indexOf("export async function executeRun"));
    const resolutions = [...body.matchAll(/resolvePlannedSpec\(/g)].map((m) => m.index!);
    expect(resolutions.length).toBeGreaterThanOrEqual(2);

    // Each resolution must be preceded by a containment check that sits AFTER
    // the previous resolution — i.e. every branch checks for itself, rather
    // than one check happening to fall within some fixed character window.
    resolutions.forEach((at, i) => {
      const lastCheck = body.lastIndexOf("await assertRunNotStopped();", at);
      const previousResolution = i === 0 ? -1 : resolutions[i - 1]!;
      expect(lastCheck).toBeGreaterThan(previousResolution);
    });
  });

  it("keeps executeRun reachable only through the workflow interpreter, across ALL of src/", () => {
    // Walks every source file rather than counting calls inside the
    // interpreter: a count there proves nothing about callers elsewhere, and a
    // second dispatcher elsewhere would be a way to run work around containment.
    const srcRoot = path.join(process.cwd(), "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });

    const callers = walk(srcRoot)
      .map((file) => ({
        file: path.relative(srcRoot, file).replace(/\\/g, "/"),
        code: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
      }))
      // A call, an import of it under any alias, or a namespace access.
      .filter(({ file, code }) => file !== "execution/executor.ts" && /\bexecuteRun\s*\(|\bexecuteRun\s+as\b|\.executeRun\b/.test(code))
      .map(({ file }) => file);

    expect(callers).toEqual(["workflow/interpreter.ts"]);
  });
});

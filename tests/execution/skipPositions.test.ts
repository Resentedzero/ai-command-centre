/**
 * R1 (V1.1, approved 2026-09-15): early stop of a bounded plan. A DEFERRED position may
 * resolve to `{ kind: "skip" }`: no Invocation is proposed and the next position runs.
 *
 * Pinned here, at the Executor, independent of any task kind:
 * - a skip proposes nothing and leaves later positions to run normally;
 * - a skip is sticky: once a later position has an Invocation, the skipped position's
 *   thunk is never called again, so it can never run out of order;
 * - a position that already has an Invocation can never become a skip (fails closed);
 * - only a deferred position may be missing below a later one;
 * - the plan's length is still the ceiling: nothing past the last position ever runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { DeferredInvocationSpec, DeterministicInvocationSpec, PlannedInvocationSpec, ToolInvocationSpec } from "../../src/execution/types.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function fixture(tx: DrizzleTransaction, autonomyState: "AUTONOMOUS" | "ALWAYS_APPROVE") {
  const [capability] = await tx.insert(schema.capabilities).values({ name: `cap-${randomUUID()}`, staticRiskTag: "low" }).returning();
  const [binding] = await tx.insert(schema.toolBindings).values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 }).returning();
  const [agent] = await tx.insert(schema.agentDefinitions).values({ name: `agent-${randomUUID()}`, version: 1, role: "r", objective: "o", instructions: "i" }).returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agent!.id,
    agentDefinitionVersion: 1,
    capabilityId: capability!.id,
    permissions: ["READ"],
    maxTrustLevelRequired: 1,
    autonomyState,
  });
  const [project] = await tx.insert(schema.projects).values({ name: `p-${randomUUID()}` }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: `t-${randomUUID()}`, kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "pending", input: {} })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId: taskInstance!.id, agentDefinitionId: agent!.id, agentDefinitionVersion: 1, status: "active" })
    .returning();
  await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, limitAmount: "1000.00", reservedAmount: "0", consumedAmount: "0" });
  return { runId: run!.id, capabilityId: capability!.id, toolBindingId: binding!.id };
}

function det(counter: { calls: number }, marker: string): DeterministicInvocationSpec {
  return {
    kind: "deterministic",
    costClass: "deterministic",
    execute: async () => {
      counter.calls += 1;
      return { marker };
    },
  };
}

function toolSpec(f: { capabilityId: string; toolBindingId: string }, counter: { calls: number }): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "local_retrieval",
    capabilityId: f.capabilityId,
    permission: "READ",
    proposedActionSnapshot: { query: "r1" },
    toolBindingId: f.toolBindingId,
    estimatedCost: 0,
    execute: async () => {
      counter.calls += 1;
      return { ok: true };
    },
  };
}

async function seqNos(tx: DrizzleTransaction, runId: string) {
  return (await tx.query.invocations.findMany({ where: eq(schema.invocations.runId, runId), orderBy: asc(schema.invocations.seqNo) })).map((i) => i.seqNo);
}

describe("R1: a deferred position may resolve to skip", () => {
  it("proposes nothing for the skipped position; later positions run normally; nothing past the plan runs", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx, "AUTONOMOUS");
      const a = { calls: 0 };
      const b = { calls: 0 };
      const skipped: DeferredInvocationSpec = async () => ({ kind: "skip", reason: "finished" });
      const outcome = await executeRun(tx, f.runId, [det(a, "a"), skipped, det(b, "b")]);
      expect(outcome.status).toBe("completed");
      expect(await seqNos(tx, f.runId)).toEqual([1, 3]);
      expect([a.calls, b.calls]).toEqual([1, 1]);
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, f.runId) });
      expect(run!.status).toBe("completed");
    });
  });

  it("a skip is sticky: once a later position has an Invocation, the skipped thunk is never called again", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx, "ALWAYS_APPROVE");
      const resolutions = { calls: 0 };
      const effects = { calls: 0 };
      const late = { calls: 0 };
      // Skips the first time; would return a runnable spec afterwards (a nondeterministic plan).
      const flaky: DeferredInvocationSpec = async () => (++resolutions.calls === 1 ? { kind: "skip", reason: "not yet" } : det(late, "late"));
      const plan: PlannedInvocationSpec[] = [det({ calls: 0 }, "first"), flaky, toolSpec(f, effects)];

      expect((await executeRun(tx, f.runId, plan)).status).toBe("awaiting_approval");
      expect(await seqNos(tx, f.runId)).toEqual([1, 3]);
      expect(resolutions.calls).toBe(1);

      // Re-driven (as every advance does): position 2 stays skipped and is not resolved.
      expect((await executeRun(tx, f.runId, plan)).status).toBe("awaiting_approval");
      expect(resolutions.calls).toBe(1);
      expect(late.calls).toBe(0);
      expect(effects.calls).toBe(0);
      expect(await seqNos(tx, f.runId)).toEqual([1, 3]);
    });
  });

  it("a position that already has an Invocation can never become a skip: it fails as a resume mismatch, nothing runs", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx, "ALWAYS_APPROVE");
      let first = true;
      const effects = { calls: 0 };
      const gated: DeferredInvocationSpec = async () => {
        if (first) {
          first = false;
          return toolSpec(f, effects);
        }
        return { kind: "skip", reason: "changed its mind" };
      };
      expect((await executeRun(tx, f.runId, [gated])).status).toBe("awaiting_approval");
      expect((await executeRun(tx, f.runId, [gated])).status).toBe("failed");
      expect(effects.calls).toBe(0);
      const [invocation] = await tx.query.invocations.findMany({ where: eq(schema.invocations.runId, f.runId) });
      expect(invocation!.status).toBe("failed");
      const failed = await tx.query.events.findFirst({ where: eq(schema.events.invocationId, invocation!.id), orderBy: (e, { desc }) => desc(e.sequenceNo) });
      expect(failed).toMatchObject({ eventType: "invocation_failed", payload: expect.objectContaining({ reason: "resume_spec_mismatch" }) });
      expect((await tx.query.runs.findFirst({ where: eq(schema.runs.id, f.runId) }))!.status).toBe("failed");
    });
  });

  it("only a deferred position may be missing below a later one", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx, "ALWAYS_APPROVE");
      const skipped: DeferredInvocationSpec = async () => ({ kind: "skip", reason: "x" });
      const gated = toolSpec(f, { calls: 0 });
      expect((await executeRun(tx, f.runId, [skipped, gated])).status).toBe("awaiting_approval");
      // The same position replaced by a static spec: a broken plan, refused rather than run out of order.
      await expect(executeRun(tx, f.runId, [det({ calls: 0 }, "static"), gated])).rejects.toThrow(/invariant violation/);
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/current transaction is aborted|rollback/i.test(error.message)) throw error;
    });
  });

  it("a static position can never skip: the plan's length stays the ceiling", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx, "AUTONOMOUS");
      const counters = [{ calls: 0 }, { calls: 0 }];
      const allSkip: DeferredInvocationSpec = async () => ({ kind: "skip", reason: "finished" });
      const outcome = await executeRun(tx, f.runId, [det(counters[0]!, "0"), allSkip, allSkip, det(counters[1]!, "1")]);
      expect(outcome.status).toBe("completed");
      expect(await seqNos(tx, f.runId)).toEqual([1, 4]);
      expect(counters.map((c) => c.calls)).toEqual([1, 1]);
    });
  });
});

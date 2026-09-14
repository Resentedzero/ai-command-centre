/**
 * Approval TTL expiry (spec §9.5): a pending Approval past its TTL can no
 * longer be resolved by a human, and the sweep expires it and finishes the
 * work that implies — releasing the hold and failing the Run and Workflow Run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { ApprovalAlreadyResolvedError, resolveApproval } from "../../src/governance/approvals.js";
import { startWorkflowRun } from "../../src/workflow/interpreter.js";
import { transactionRunner } from "../../src/db/transactionRunner.js";
import { advanceWorkflowRunUntilBlocked } from "../../src/workflow/advanceWorkflowRunUntilBlocked.js";
import { APPROVAL_TTL_ACTOR, expireStaleApprovals } from "../../src/workflow/expireStaleApprovals.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

/** A one-step Workflow whose only step is an ALWAYS_APPROVE tool, driven to awaiting_approval. */
async function seedParkedApproval(tx: DrizzleTransaction) {
  const [capability] = await tx.insert(schema.capabilities).values({ name: "cap-" + randomUUID(), staticRiskTag: "low" }).returning();
  const [binding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 })
    .returning();
  const [agent] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "r", objective: "o", instructions: "i" })
    .returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agent!.id,
    agentDefinitionVersion: 1,
    capabilityId: capability!.id,
    permissions: ["READ"],
    maxTrustLevelRequired: 1,
    autonomyState: "ALWAYS_APPROVE",
  });
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "workflow", version: 1 })
    .returning();
  const [definition] = await tx
    .insert(schema.workflowDefinitions)
    .values({
      name: "wf-" + randomUUID(),
      version: 1,
      graphDefinition: { kind: "linear", steps: [{ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1 }] },
    })
    .returning();
  const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "g", status: "active" }).returning();
  const { workflowRunId } = await startWorkflowRun(tx, definition!.id, goal!.id);

  const execute = vi.fn(async () => ({ ok: true }));
  // Mirrors a real builder: bind the agent, provision the Run's budget, return the plan.
  const makeBuilder = (btx: DrizzleTransaction) => async (params: { taskInstanceId: string }) => {
    const run = await btx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, params.taskInstanceId) });
    await btx.update(schema.runs).set({ agentDefinitionId: agent!.id, agentDefinitionVersion: 1 }).where(eq(schema.runs.id, run!.id));
    await btx
      .insert(schema.budgetCounters)
      .values({ scope: "run", scopeRefId: run!.id, resourceUnit: "usd", limitAmount: "10", reservedAmount: "0", consumedAmount: "0" })
      .onConflictDoNothing();
    return [
      {
        kind: "tool" as const,
        costClass: "metered_api" as const,
        capabilityId: capability!.id,
        toolBindingId: binding!.id,
        permission: "READ" as const,
        proposedActionSnapshot: { action: "read" },
        estimatedCost: 1,
        execute,
      },
    ];
  };

  const runInTx = transactionRunner(tx);
  expect(await advanceWorkflowRunUntilBlocked(runInTx, workflowRunId, makeBuilder)).toEqual({ status: "in_progress" });
  const [approval] = await tx.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"));
  const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, approval!.invocationId) });
  return { workflowRunId, approvalId: approval!.id, runId: invocation!.runId, execute, makeBuilder, runInTx };
}

async function backdateTtl(tx: DrizzleTransaction, approvalId: string) {
  await tx.update(schema.approvals).set({ ttl: new Date(Date.now() - 60_000) }).where(eq(schema.approvals.id, approvalId));
}

describe("approval TTL", () => {
  it("a past-TTL Approval refuses a human decision as expired, recording no grant", async () => {
    await withRollback(async (tx) => {
      const { approvalId } = await seedParkedApproval(tx);
      await backdateTtl(tx, approvalId);

      const attempt = tx.transaction((stx) => resolveApproval(stx, approvalId, "approved", "human:operator"));
      await expect(attempt).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
      await expect(attempt).rejects.toMatchObject({ currentStatus: "expired" });

      const granted = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `approval_granted:${approvalId}`) });
      expect(granted).toBeUndefined();
    });
  });

  it("the sweep expires it, releases the hold, never executes, and fails the Run and Workflow Run", async () => {
    await withRollback(async (tx) => {
      const { approvalId, runId, workflowRunId, execute, makeBuilder, runInTx } = await seedParkedApproval(tx);
      const reserved = async () =>
        Number(
          (await tx.query.budgetCounters.findFirst({
            where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "usd")),
          }))!.reservedAmount
        );
      expect(await reserved()).toBe(1);

      // Not yet stale: the sweep leaves it alone.
      expect(await expireStaleApprovals(runInTx, makeBuilder)).toEqual({ expired: [], failed: [], retried: [], retryFailed: [] });

      await backdateTtl(tx, approvalId);
      expect(await expireStaleApprovals(runInTx, makeBuilder)).toEqual({ expired: [approvalId], failed: [], retried: [], retryFailed: [] });

      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
      expect(approval!.status).toBe("expired");
      expect(approval!.resolvedBy).toBe(APPROVAL_TTL_ACTOR);
      expect(execute).not.toHaveBeenCalled();
      expect(await reserved()).toBe(0);

      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.runId, runId), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed!.payload).toMatchObject({ reason: "approval_expired" });
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("failed");

      // Idempotent: nothing stale remains.
      expect(await expireStaleApprovals(runInTx, makeBuilder)).toEqual({ expired: [], failed: [], retried: [], retryFailed: [] });
    });
  });

  it("an expiry whose re-drive did not finish is re-driven by the next sweep, releasing the hold", async () => {
    await withRollback(async (tx) => {
      const { approvalId, runId, workflowRunId, execute, makeBuilder, runInTx } = await seedParkedApproval(tx);
      await backdateTtl(tx, approvalId);

      // The first re-drive fails transiently after the expiry has committed.
      let failOnce = true;
      const flakyBuilder = (btx: DrizzleTransaction) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("connection reset"), { code: "08006" });
        }
        return makeBuilder(btx);
      };
      const first = await expireStaleApprovals(runInTx, flakyBuilder);
      expect(first.expired).toEqual([approvalId]);
      expect(first.failed).toHaveLength(1);
      const usd = async () =>
        (await tx.query.budgetCounters.findFirst({
          where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "usd")),
        }))!;
      expect(Number((await usd()).reservedAmount)).toBe(1); // stranded: expired, still held

      expect(await expireStaleApprovals(runInTx, flakyBuilder)).toEqual({
        expired: [],
        failed: [],
        retried: [workflowRunId],
        retryFailed: [],
      });
      expect(Number((await usd()).reservedAmount)).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("failed");
    });
  });
});

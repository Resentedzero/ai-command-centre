/**
 * Lifecycle and accounting events (spec §8.2, §8.5; §3e: current state is a
 * same-transaction projection over events).
 *
 * Proves that a Workflow Run's whole life is visible in the event log with full
 * correlation, on both the success and failure paths, and that budget counters
 * are reconstructible from `budget_consumed` events alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { advanceWorkflowRun, startWorkflowRun } from "../../src/workflow/interpreter.js";
import { chargeReservationAtEstimate, reconcileBudget, releaseReservation, reserveBudget } from "../../src/governance/budget.js";
import { dayScopeRef } from "../../src/governance/dailyBudgetPolicy.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function seedOneStepWorkflow(tx: DrizzleTransaction) {
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
  return { workflowRunId, goalId: goal!.id };
}

function deterministicBuilder(execute: () => Promise<Record<string, unknown>>) {
  return async () => [{ kind: "deterministic" as const, costClass: "deterministic" as const, execute }];
}

async function workflowEvents(tx: DrizzleTransaction, workflowRunId: string) {
  return tx.select().from(schema.events).where(eq(schema.events.workflowRunId, workflowRunId)).orderBy(asc(schema.events.globalSeq));
}

describe("a Workflow Run's life is in the event log", () => {
  it("success: started -> task instance + run created -> run completed -> task instance completed -> workflow completed", async () => {
    await withRollback(async (tx) => {
      const { workflowRunId, goalId } = await seedOneStepWorkflow(tx);
      expect(await advanceWorkflowRun(tx, workflowRunId, deterministicBuilder(async () => ({ ok: true })))).toEqual({
        status: "completed",
      });

      const events = await workflowEvents(tx, workflowRunId);
      expect(events.map((e) => e.eventType)).toEqual([
        "workflow_run_started",
        "task_instance_created",
        "run_started",
        "invocation_started",
        "artifact_created",
        "invocation_completed",
        "run_completed",
        "task_instance_completed",
        "workflow_run_completed",
      ]);
      // Every one is correlated all the way up to the Goal.
      expect(events.every((e) => e.goalId === goalId && e.workflowRunId === workflowRunId)).toBe(true);
      // Step-scoped events share the step Run's own sequence.
      const runId = events.find((e) => e.eventType === "run_started")!.runId!;
      const runScoped = events.filter((e) => e.runId === runId);
      expect(runScoped.map((e) => e.sequenceNo)).toEqual(runScoped.map((_, i) => i + 1));

      // Projections match the facts.
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("completed");

      // Re-advancing a finished Workflow Run records nothing new.
      await advanceWorkflowRun(tx, workflowRunId, deterministicBuilder(async () => ({ ok: true })));
      expect(await workflowEvents(tx, workflowRunId)).toHaveLength(events.length);
    });
  });

  it("failure: run failed -> task instance failed -> workflow failed", async () => {
    await withRollback(async (tx) => {
      const { workflowRunId } = await seedOneStepWorkflow(tx);
      const failing = deterministicBuilder(async () => {
        throw new Error("boom");
      });
      expect(await advanceWorkflowRun(tx, workflowRunId, failing)).toEqual({ status: "failed" });

      const types = (await workflowEvents(tx, workflowRunId)).map((e) => e.eventType);
      expect(types).toEqual([
        "workflow_run_started",
        "task_instance_created",
        "run_started",
        "invocation_started",
        "invocation_failed",
        "run_failed",
        "task_instance_failed",
        "workflow_run_failed",
      ]);
    });
  });
});

describe("budget counters are reconstructible from budget_consumed events", () => {
  it("the sum of budget_consumed amounts equals consumed_amount, across reported, estimated and released reservations", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await tx.insert(schema.budgetCounters).values({
        scope: "run",
        scopeRefId: runId,
        resourceUnit: "subscription_tokens",
        limitAmount: "100000",
        reservedAmount: "0",
        consumedAmount: "0",
      });
      const reserve = async (amount: number) => {
        const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", amount);
        if (!r.authorized) throw new Error("unexpected refusal");
        return r.reservationId;
      };

      await reconcileBudget(tx, await reserve(1_000), 640); // reported actual
      await chargeReservationAtEstimate(tx, await reserve(500)); // unknown consumption
      await releaseReservation(tx, await reserve(300)); // nothing consumed: no event

      const consumed = await tx
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.eventType, "budget_consumed")));
      expect(consumed.map((e) => (e.payload as { basis: string }).basis).sort()).toEqual(["estimate", "reported"]);

      const fromEvents = consumed.reduce((sum, e) => sum + Number((e.payload as { amount: string }).amount), 0);
      const counter = await tx.query.budgetCounters.findFirst({ where: eq(schema.budgetCounters.scopeRefId, runId) });
      expect(fromEvents).toBe(Number(counter!.consumedAmount));
      expect(fromEvents).toBe(1_140);
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });

  it("a multi-hold reservation (run + day) is ONE event naming both counters, and each counter still sums from the log", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      const now = new Date("2026-09-14T12:00:00Z");
      const dayRef = dayScopeRef(now);
      await tx.insert(schema.budgetCounters).values({
        scope: "run",
        scopeRefId: runId,
        resourceUnit: "subscription_tokens",
        limitAmount: "100000",
        reservedAmount: "0",
        consumedAmount: "0",
      });
      const options = { dailyCeilings: { subscription_tokens: "500000" }, now };
      const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 800, options);
      if (!r.authorized) throw new Error("unexpected refusal");
      await reconcileBudget(tx, r.reservationId, 300);

      const consumed = await tx
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.eventType, "budget_consumed")));
      expect(consumed).toHaveLength(1);
      const holds = (consumed[0]!.payload as { holds: { scope: string; scopeRefId: string }[] }).holds;
      expect(holds).toEqual([
        { scope: "day", scopeRefId: dayRef },
        { scope: "run", scopeRefId: runId },
      ]);

      const sumFor = (scope: string, scopeRefId: string) =>
        consumed
          .filter((e) => (e.payload as { holds: { scope: string; scopeRefId: string }[] }).holds.some((h) => h.scope === scope && h.scopeRefId === scopeRefId))
          .reduce((s, e) => s + Number((e.payload as { amount: string }).amount), 0);
      for (const [scope, scopeRefId] of [
        ["run", runId],
        ["day", dayRef],
      ] as const) {
        const counter = await tx.query.budgetCounters.findFirst({
          where: and(
            eq(schema.budgetCounters.scope, scope),
            eq(schema.budgetCounters.scopeRefId, scopeRefId),
            eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
          ),
        });
        expect(sumFor(scope, scopeRefId), scope).toBe(Number(counter!.consumedAmount));
      }
    });
  });

  it("a reservation cannot be consumed twice: the second attempt is refused before any counter moves", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await tx.insert(schema.budgetCounters).values({
        scope: "run",
        scopeRefId: runId,
        resourceUnit: "subscription_tokens",
        limitAmount: "100000",
        reservedAmount: "0",
        consumedAmount: "0",
      });
      const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 1_000);
      if (!r.authorized) throw new Error("unexpected refusal");
      await reconcileBudget(tx, r.reservationId, 400);

      await expect(chargeReservationAtEstimate(tx, r.reservationId)).rejects.toThrow(/already consumed/);
      await expect(reconcileBudget(tx, r.reservationId, 400)).rejects.toThrow(/already consumed/);

      const counter = await tx.query.budgetCounters.findFirst({ where: eq(schema.budgetCounters.scopeRefId, runId) });
      expect(Number(counter!.consumedAmount)).toBe(400);
      expect(Number(counter!.reservedAmount)).toBe(0);
    });
  });
});

/**
 * Task Instance budget counters (operator decision D20, 2026-09-15).
 *
 * Properties under test, each written so a regression fails it:
 *
 *  1. SHIPPED VALUES. usd 1.00 and subscription_tokens 50000 per Task Instance, frozen.
 *  2. SHARED BY EVERY ATTEMPT. The Runs of one Task Instance (the retry policy's
 *     attempts) hold ONE counter, so together they cannot pass the Task's ceiling even
 *     when each Run has room of its own.
 *  3. ADDITIVE. The Run counter and the day counter still apply; the Task Instance
 *     counter never widens either.
 *  4. UNITS STAY SEPARATE. One counter per unit; usd and subscription_tokens never share
 *     an allowance.
 *  5. FAIL CLOSED. A Run with no row has no Task Instance to charge and is refused,
 *     recorded as `budget_denied`, with nothing written.
 *  6. ACCOUNTED. Reconcile and release move the Task Instance counter with the others,
 *     and `budget_consumed` names it.
 *
 * The real Task Instance ceilings are used throughout; the day ceiling is injected
 * empty where a test is not about it, so this file's counters stay independent of the
 * shared day.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { reconcileBudget, releaseReservation, reserveBudget } from "../../src/governance/budget.js";
import { dayScopeRef } from "../../src/governance/dailyBudgetPolicy.js";
import type { ResourceUnit } from "../../src/governance/resourceUnit.js";
import { TASK_INSTANCE_BUDGET_CEILINGS } from "../../src/governance/runBudgetPolicy.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const NO_DAY = { dailyCeilings: {} } as const;

/** One Task Instance with `attempts` Runs, each funded well above the Task's ceiling. */
async function seedTask(tx: DrizzleTransaction, attempts: number) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "active", input: {} })
    .returning();
  const runIds: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active", attempt }).returning();
    for (const [resourceUnit, limitAmount] of [
      ["usd", "10.00"],
      ["subscription_tokens", "200000"],
    ] as const) {
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, resourceUnit, limitAmount, reservedAmount: "0", consumedAmount: "0" });
    }
    runIds.push(run!.id);
  }
  return { taskInstanceId: taskInstance!.id, runIds };
}

async function counter(tx: DrizzleTransaction, scope: "run" | "task_instance" | "day", scopeRefId: string, resourceUnit: ResourceUnit) {
  return tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scope, scope), eq(schema.budgetCounters.scopeRefId, scopeRefId), eq(schema.budgetCounters.resourceUnit, resourceUnit)),
  });
}

function decode(reservationId: string): { holds: { scope: string; scopeRefId: string }[] } {
  return JSON.parse(Buffer.from(reservationId.slice("res_".length), "base64url").toString("utf8"));
}

describe("shipped configuration (D20)", () => {
  it("ships exactly usd 1.00 and subscription_tokens 50000 per Task Instance, as separate units, frozen", () => {
    expect(TASK_INSTANCE_BUDGET_CEILINGS).toEqual({ usd: "1.00", subscription_tokens: "50000" });
    expect(Object.isFrozen(TASK_INSTANCE_BUDGET_CEILINGS)).toBe(true);
  });
});

describe("the Runs of one Task Instance share its counter", () => {
  it("refuses a later attempt that would pass the Task's ceiling although its own Run has room", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, runIds } = await seedTask(tx, 3);
      const [first, second, third] = runIds as [string, string, string];

      expect((await reserveBudget(tx, "run", first, "llm", "subscription_tokens", 30000, NO_DAY)).authorized).toBe(true);
      // 30000 + 30000 > 50000: refused by the Task Instance, not by the second Run's 200000.
      expect(await reserveBudget(tx, "run", second, "llm", "subscription_tokens", 30000, NO_DAY)).toEqual({ authorized: false, reason: "insufficient_budget" });
      expect((await reserveBudget(tx, "run", third, "llm", "subscription_tokens", 20000, NO_DAY)).authorized).toBe(true);

      const task = await counter(tx, "task_instance", taskInstanceId, "subscription_tokens");
      expect(task).toMatchObject({ limitAmount: "50000", reservedAmount: "50000", consumedAmount: "0" });
      // The refused attempt wrote to nothing.
      expect((await counter(tx, "run", second, "subscription_tokens"))!.reservedAmount).toBe("0");

      const [denied] = await tx.query.events.findMany({ where: and(eq(schema.events.eventType, "budget_denied"), eq(schema.events.runId, second)) });
      expect((denied!.payload as { deniedCounter: unknown }).deniedCounter).toEqual({
        scope: "task_instance",
        scopeRefId: taskInstanceId,
        missing: false,
        limitAmount: "50000",
        reservedAmount: "30000",
        consumedAmount: "0",
      });
    });
  });

  it("the Run counter still refuses on its own: the Task Instance never widens a Run", async () => {
    await withRollback(async (tx) => {
      const { runIds } = await seedTask(tx, 1);
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "100" })
        .where(and(eq(schema.budgetCounters.scopeRefId, runIds[0]!), eq(schema.budgetCounters.resourceUnit, "subscription_tokens")));
      expect((await reserveBudget(tx, "run", runIds[0]!, "llm", "subscription_tokens", 101, NO_DAY)).authorized).toBe(false);
    });
  });

  it("keeps usd and subscription_tokens as separate counters", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, runIds } = await seedTask(tx, 2);
      expect((await reserveBudget(tx, "run", runIds[0]!, "metered_api", "usd", 0.9, NO_DAY)).authorized).toBe(true);
      // Exhausting usd leaves the token allowance whole, and vice versa.
      expect((await reserveBudget(tx, "run", runIds[1]!, "llm", "subscription_tokens", 50000, NO_DAY)).authorized).toBe(true);
      expect((await reserveBudget(tx, "run", runIds[1]!, "metered_api", "usd", 0.2, NO_DAY)).authorized).toBe(false);

      expect(await counter(tx, "task_instance", taskInstanceId, "usd")).toMatchObject({ limitAmount: "1.00", reservedAmount: "0.9" });
      expect(await counter(tx, "task_instance", taskInstanceId, "subscription_tokens")).toMatchObject({ limitAmount: "50000", reservedAmount: "50000" });
    });
  });

  it("creates the counter at the governance limit and never raises an existing one", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, runIds } = await seedTask(tx, 1);
      await tx.insert(schema.budgetCounters).values({ scope: "task_instance", scopeRefId: taskInstanceId, resourceUnit: "usd", limitAmount: "0.10", reservedAmount: "0", consumedAmount: "0" });
      expect((await reserveBudget(tx, "run", runIds[0]!, "metered_api", "usd", 0.5, NO_DAY)).authorized).toBe(false);
      expect((await counter(tx, "task_instance", taskInstanceId, "usd"))!.limitAmount).toBe("0.10");
    });
  });
});

describe("fails closed", () => {
  it("refuses a Run with no row, names the Task Instance counter, and writes no counter", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: runId, resourceUnit: "usd", limitAmount: "10.00", reservedAmount: "0", consumedAmount: "0" });
      expect(await reserveBudget(tx, "run", runId, "metered_api", "usd", 0.1, NO_DAY)).toEqual({ authorized: false, reason: "insufficient_budget" });

      const [denied] = await tx.query.events.findMany({ where: and(eq(schema.events.eventType, "budget_denied"), eq(schema.events.runId, runId)) });
      expect((denied!.payload as { deniedCounter: { scope: string; missing: boolean } }).deniedCounter).toMatchObject({ scope: "task_instance", missing: true });
      expect((await counter(tx, "run", runId, "usd"))!.reservedAmount).toBe("0");
      expect(await tx.select().from(schema.budgetCounters).where(eq(schema.budgetCounters.scope, "task_instance"))).toEqual([]);
    });
  });

  it("refuses a Run with no row before creating a day counter, so a refusal leaves no side effect", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      const now = new Date(2031, 0, 2, 12);
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: runId, resourceUnit: "usd", limitAmount: "10.00", reservedAmount: "0", consumedAmount: "0" });
      expect(await reserveBudget(tx, "run", runId, "metered_api", "usd", 0.1, { dailyCeilings: { usd: "5.00" }, now })).toEqual({
        authorized: false,
        reason: "insufficient_budget",
      });
      expect(await counter(tx, "day", dayScopeRef(now), "usd")).toBeUndefined();
    });
  });
});

describe("accounting", () => {
  it("holds day, run and task_instance in lock order, and reconcile and release move all three", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, runIds } = await seedTask(tx, 1);
      const runId = runIds[0]!;
      const now = new Date(2031, 2, 10, 12, 0, 0);
      const dayRef = dayScopeRef(now);
      const options = { dailyCeilings: { subscription_tokens: "500000" }, now };

      const kept = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 8000, options);
      if (!kept.authorized) throw new Error("expected authorization");
      expect(decode(kept.reservationId).holds).toEqual([
        { scope: "day", scopeRefId: dayRef },
        { scope: "run", scopeRefId: runId },
        { scope: "task_instance", scopeRefId: taskInstanceId },
      ]);
      await reconcileBudget(tx, kept.reservationId, 3000);

      const dropped = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 5000, options);
      if (!dropped.authorized) throw new Error("expected authorization");
      await releaseReservation(tx, dropped.reservationId);

      for (const [scope, ref] of [["day", dayRef], ["run", runId], ["task_instance", taskInstanceId]] as const) {
        expect(await counter(tx, scope, ref, "subscription_tokens"), scope).toMatchObject({ reservedAmount: "0", consumedAmount: "3000" });
      }
      const [consumed] = await tx.query.events.findMany({ where: and(eq(schema.events.eventType, "budget_consumed"), eq(schema.events.runId, runId)) });
      expect((consumed!.payload as { holds: { scope: string }[] }).holds.map((h) => h.scope)).toEqual(["day", "run", "task_instance"]);
    });
  });

  it("with the shipped configuration a reservation holds today's local day, the Run and its Task Instance", async () => {
    await withRollback(async (tx) => {
      const { taskInstanceId, runIds } = await seedTask(tx, 1);
      const before = dayScopeRef(new Date());
      const result = await reserveBudget(tx, "run", runIds[0]!, "metered_api", "usd", 0.25);
      if (!result.authorized) throw new Error("expected authorization");
      const holds = decode(result.reservationId).holds;
      expect(holds.map((h) => h.scope)).toEqual(["day", "run", "task_instance"]);
      expect([before, dayScopeRef(new Date())]).toContain(holds[0]!.scopeRefId);
      expect(holds[2]!.scopeRefId).toBe(taskInstanceId);
      expect(await counter(tx, "day", holds[0]!.scopeRefId, "usd")).toMatchObject({ limitAmount: "5.00", reservedAmount: "0.25" });
    });
  });
});

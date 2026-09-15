/**
 * `budget_denied` (spec §8.2): every reservation refusal is recorded, naming the
 * counter that refused and what it held; an authorized reservation records none.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Run-counter refusals against bare counter rows; day and Task Instance ceilings are
// injected per test where a test is about them.
vi.mock("../../src/governance/dailyBudgetPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/governance/dailyBudgetPolicy.js")>()),
  DAILY_BUDGET_CEILINGS: Object.freeze({}),
}));
vi.mock("../../src/governance/runBudgetPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/governance/runBudgetPolicy.js")>()),
  TASK_INSTANCE_BUDGET_CEILINGS: Object.freeze({}),
}));
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { reserveBudget } from "../../src/governance/budget.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function denials(tx: DrizzleTransaction, runId: string) {
  return tx.query.events.findMany({ where: and(eq(schema.events.eventType, "budget_denied"), eq(schema.events.runId, runId)) });
}

async function counter(tx: DrizzleTransaction, runId: string, values: { limitAmount: string; reservedAmount?: string; consumedAmount?: string }) {
  await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: runId, resourceUnit: "usd", reservedAmount: "0", consumedAmount: "0", ...values });
}

describe("budget_denied", () => {
  it("records a refusal against a missing counter", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      expect(await reserveBudget(tx, "run", runId, "metered_api", "usd", 1)).toEqual({ authorized: false, reason: "insufficient_budget" });
      const [event] = await denials(tx, runId);
      expect(event).toMatchObject({ producer: "budget-governor", runId });
      expect(event!.payload).toEqual({
        requestedScope: "run",
        requestedScopeRefId: runId,
        resourceUnit: "usd",
        costClass: "metered_api",
        requestedAmount: "1",
        deniedCounter: { scope: "run", scopeRefId: runId, missing: true, limitAmount: null, reservedAmount: null, consumedAmount: null },
      });
      expect(event!.costUnit).toBeNull();
    });
  });

  it("records the exact amounts of the counter that had too little room", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await counter(tx, runId, { limitAmount: "10.00", reservedAmount: "4", consumedAmount: "5.50" });
      expect((await reserveBudget(tx, "run", runId, "external_side_effect", "usd", 0.75)).authorized).toBe(false);
      const [event] = await denials(tx, runId);
      expect(event!.payload).toMatchObject({
        requestedAmount: "0.75",
        deniedCounter: { scope: "run", missing: false, limitAmount: "10.00", reservedAmount: "4", consumedAmount: "5.50" },
      });
    });
  });

  it("names the day counter when it, not the Run, refuses", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await counter(tx, runId, { limitAmount: "100" });
      const now = new Date("2026-09-14T12:00:00Z");
      const result = await reserveBudget(tx, "run", runId, "metered_api", "usd", 5, { dailyCeilings: { usd: "2" }, now });
      expect(result.authorized).toBe(false);
      const [event] = await denials(tx, runId);
      expect((event!.payload as { deniedCounter: { scope: string; missing: boolean; limitAmount: string } }).deniedCounter).toMatchObject({
        scope: "day",
        missing: false,
        limitAmount: "2",
      });
    });
  });

  it("an authorized reservation and a deterministic short-circuit record nothing", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await counter(tx, runId, { limitAmount: "10.00" });
      expect((await reserveBudget(tx, "run", runId, "metered_api", "usd", 1)).authorized).toBe(true);
      expect((await reserveBudget(tx, "run", randomUUID(), "deterministic", "usd", 1)).authorized).toBe(true);
      expect(await denials(tx, runId)).toEqual([]);
    });
  });
});

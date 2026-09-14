import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "../testDb.js";
import { budgetCounters } from "../../src/db/schema.js";
import { reserveBudget, reconcileBudget, releaseReservation } from "../../src/governance/budget.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

/** Seeds one budget_counters row inside the given transaction and returns its scopeRefId. */
async function seedCounter(
  tx: DrizzleTransaction,
  overrides: { limitAmount?: string; reservedAmount?: string; consumedAmount?: string } = {}
): Promise<string> {
  const scopeRefId = randomUUID();
  await tx.insert(budgetCounters).values({
    scope: "run",
    scopeRefId,
    limitAmount: overrides.limitAmount ?? "10.00",
    reservedAmount: overrides.reservedAmount ?? "0",
    consumedAmount: overrides.consumedAmount ?? "0",
  });
  return scopeRefId;
}

/** A resolvable promise pair, used to force genuine overlap between two transactions. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("budget_counters schema constraint (pre-dispatch ruling 1)", () => {
  it("enforces at most one budget_counters row per (scope, scopeRefId, resourceUnit) via the unique index", async () => {
    const scopeRefId = randomUUID();
    // A duplicate-key insert aborts the transaction outright, so it rolls
    // back on its own — no withRollback/cleanup needed, and running
    // tx.rollback() on an already-aborted transaction would misbehave.
    let caught: unknown;
    try {
      await testDb.transaction(async (tx) => {
        await tx.insert(budgetCounters).values({ scope: "run", scopeRefId, limitAmount: "1.00" });
        await tx.insert(budgetCounters).values({ scope: "run", scopeRefId, limitAmount: "2.00" });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // node-postgres wraps the underlying Postgres error as `.cause`, where
    // the constraint name that actually fired is reported (pg error code
    // 23505 unique_violation). Asserting the specific index name — not just
    // "duplicate"/"unique" — proves it's THIS constraint, not the primary
    // key or some other index.
    const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
    // `resource_unit` joined this index when counters became per-unit; both
    // inserts above omit it, so both default to 'usd' and still collide.
    expect(cause?.constraint ?? cause?.message).toMatch(/budget_counters_scope_scope_ref_id_resource_unit_idx/);
  });
});

describe("reserveBudget input validation", () => {
  it("rejects a negative estimatedAmount, before touching the database", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID(); // deliberately no row seeded
      await expect(reserveBudget(tx, "run", scopeRefId, "llm", "usd", -1)).rejects.toThrow(/estimatedAmount/);
    });
  });

  it("rejects NaN, before touching the database", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID();
      await expect(reserveBudget(tx, "run", scopeRefId, "llm", "usd", NaN)).rejects.toThrow(/estimatedAmount/);
    });
  });

  it("rejects Infinity, before touching the database", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID();
      await expect(reserveBudget(tx, "run", scopeRefId, "llm", "usd", Infinity)).rejects.toThrow(/estimatedAmount/);
    });
  });

  it("rejects -Infinity, before touching the database", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID();
      await expect(reserveBudget(tx, "run", scopeRefId, "llm", "usd", -Infinity)).rejects.toThrow(/estimatedAmount/);
    });
  });

  it("does not affect a structurally valid reservation (no regression)", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00" });
      const result = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 5);
      expect(result).toEqual({ authorized: true, reservationId: expect.any(String) });
    });
  });
});

describe("reserveBudget", () => {
  it("authorizes a reservation within the available amount (limit - reserved - consumed)", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00" });

      const result = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 6);

      expect(result.authorized).toBe(true);
      if (!result.authorized) throw new Error("unreachable");
      expect(result.reservationId).not.toBe("res_noop");

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      expect(row?.reservedAmount).toBe("6");
      expect(row?.consumedAmount).toBe("0");
    });
  });

  it("rejects a reservation that would exceed limit_amount - reserved_amount - consumed_amount", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, {
        limitAmount: "10.00",
        reservedAmount: "3",
        consumedAmount: "4",
      });
      // available = 10 - 3 - 4 = 3; requesting 3.01 must be rejected.
      const result = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 3.01);

      expect(result).toEqual({ authorized: false, reason: "insufficient_budget" });

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      // Rejected reservation must not mutate the row.
      expect(row?.reservedAmount).toBe("3");
      expect(row?.consumedAmount).toBe("4");
    });
  });

  it("authorizes a reservation exactly equal to the available amount", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00", reservedAmount: "4" });
      const result = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 6);
      expect(result.authorized).toBe(true);
    });
  });

  it("returns insufficient_budget when no budget_counters row exists for the scope key (no auto-create)", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID();
      const result = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 1);
      expect(result).toEqual({ authorized: false, reason: "insufficient_budget" });

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      expect(row).toBeUndefined();
    });
  });

  it('costClass "deterministic" short-circuits to authorized:true without touching budget_counters, even when no row exists', async () => {
    await withRollback(async (tx) => {
      const scopeRefId = randomUUID(); // deliberately never seeded

      const result = await reserveBudget(tx, "run", scopeRefId, "deterministic", "usd", 999999);

      expect(result).toEqual({ authorized: true, reservationId: "res_noop" });

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      expect(row).toBeUndefined();
    });
  });

  it('costClass "deterministic" leaves an existing row for the same scope key completely unchanged', async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "1.00" });
      const before = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });

      const result = await reserveBudget(tx, "run", scopeRefId, "deterministic", "usd", 999999);

      expect(result).toEqual({ authorized: true, reservationId: "res_noop" });

      const after = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      expect(after?.reservedAmount).toBe(before?.reservedAmount);
      expect(after?.consumedAmount).toBe(before?.consumedAmount);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
    });
  });

  it(
    "never authorizes both of two genuinely concurrent, overlapping-transaction reservations against the same scope key when together they exceed the limit",
    async () => {
      // Seeded for real (committed) so it is visible to two independent
      // transactions/connections, not just to one withRollback-scoped tx.
      const scopeRefId = randomUUID();
      await testDb.insert(budgetCounters).values({
        scope: "run",
        scopeRefId,
        limitAmount: "10.00",
        reservedAmount: "0",
        consumedAmount: "0",
      });

      try {
        // Barrier: each side proves its OWN transaction is open (by running a
        // statement on it) and signals that, then waits for the other side's
        // signal before calling reserveBudget. This forces both transactions
        // to be genuinely open concurrently before either takes the row
        // lock — not just two sequentially-awaited calls that happen to be
        // wrapped in Promise.all.
        const aStarted = createDeferred();
        const bStarted = createDeferred();

        const runA = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          aStarted.resolve();
          await bStarted.promise;
          return reserveBudget(tx, "run", scopeRefId, "llm", "usd", 6);
        });

        const runB = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          bStarted.resolve();
          await aStarted.promise;
          return reserveBudget(tx, "run", scopeRefId, "llm", "usd", 6);
        });

        const [a, b] = await Promise.all([runA, runB]);

        const authorizedResults = [a, b].filter((r) => r.authorized);
        // 6 + 6 = 12 > limit of 10: at most one may be authorized.
        expect(authorizedResults.length).toBe(1);
        const rejected = [a, b].find((r) => !r.authorized);
        expect(rejected).toEqual({ authorized: false, reason: "insufficient_budget" });

        const finalRow = await testDb.query.budgetCounters.findFirst({
          where: eq(budgetCounters.scopeRefId, scopeRefId),
        });
        expect(finalRow?.reservedAmount).toBe("6");
      } finally {
        await testDb.delete(budgetCounters).where(eq(budgetCounters.scopeRefId, scopeRefId));
      }
    },
    20000
  );
});

describe("reconcileBudget", () => {
  it("releases the reservation and adds actual consumption atomically", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00" });

      const reservation = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 7);
      if (!reservation.authorized) throw new Error("expected authorization");

      await reconcileBudget(tx, reservation.reservationId, 5.5);

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      // reserved_amount released by the ORIGINAL estimate (7), not the actual.
      expect(row?.reservedAmount).toBe("0");
      // consumed_amount increased by the actual amount.
      expect(row?.consumedAmount).toBe("5.5");
    });
  });

  it("leaves other reservations against the same row untouched", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "20.00" });

      const r1 = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 4);
      const r2 = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 3);
      if (!r1.authorized || !r2.authorized) throw new Error("expected both authorized");

      await reconcileBudget(tx, r1.reservationId, 4);

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      // r1's 4 released from reserved, r2's 3 still outstanding.
      expect(row?.reservedAmount).toBe("3");
      expect(row?.consumedAmount).toBe("4");
    });
  });

  it("records actual consumption past the limit as it happened, and refuses every reservation after it", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00" });
      const reservation = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 8);
      if (!reservation.authorized) throw new Error("expected authorization");

      // A provider may report more than the estimate: no adapter caps output at it.
      await reconcileBudget(tx, reservation.reservationId, 12);

      const row = await tx.query.budgetCounters.findFirst({ where: eq(budgetCounters.scopeRefId, scopeRefId) });
      expect(row).toMatchObject({ reservedAmount: "0", consumedAmount: "12" });
      expect(await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 0.01)).toEqual({ authorized: false, reason: "insufficient_budget" });
    });
  });

  it("throws for the deterministic no-op reservationId", async () => {
    await withRollback(async (tx) => {
      await expect(reconcileBudget(tx, "res_noop", 1)).rejects.toThrow();
    });
  });

  it("throws for a malformed reservationId", async () => {
    await withRollback(async (tx) => {
      await expect(reconcileBudget(tx, "not-a-real-id", 1)).rejects.toThrow();
    });
  });
});

describe("releaseReservation", () => {
  it("decrements reserved_amount by the original estimate and leaves consumed_amount unchanged", async () => {
    await withRollback(async (tx) => {
      const scopeRefId = await seedCounter(tx, { limitAmount: "10.00" });

      const reservation = await reserveBudget(tx, "run", scopeRefId, "llm", "usd", 4);
      if (!reservation.authorized) throw new Error("expected authorization");

      await releaseReservation(tx, reservation.reservationId);

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(budgetCounters.scopeRefId, scopeRefId),
      });
      expect(row?.reservedAmount).toBe("0");
      expect(row?.consumedAmount).toBe("0");
    });
  });

  it("throws for the deterministic no-op reservationId", async () => {
    await withRollback(async (tx) => {
      await expect(releaseReservation(tx, "res_noop")).rejects.toThrow();
    });
  });
});

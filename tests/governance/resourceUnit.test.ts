/**
 * Resource-unit accounting (amended Phase 12, 2026-09-13).
 *
 * The property under test is that `usd`, `subscription_tokens` and
 * `local_tokens` are INDEPENDENT accounting dimensions: a scope holds one
 * counter per unit, they never sum, and neither can be spent through the
 * other's budget. Every test here is written so that collapsing the dimension
 * back to a single counter — or silently defaulting a missing unit to `usd` —
 * fails it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { emitEvent } from "../../src/events/emit.js";
import { reserveBudget, reconcileBudget, releaseReservation } from "../../src/governance/budget.js";
import type { ResourceUnit } from "../../src/governance/resourceUnit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function seedCounter(
  tx: DrizzleTransaction,
  scopeRefId: string,
  resourceUnit: ResourceUnit,
  limitAmount: string
): Promise<void> {
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId,
    resourceUnit,
    limitAmount,
    reservedAmount: "0",
    consumedAmount: "0",
  });
}

async function readCounter(tx: DrizzleTransaction, scopeRefId: string, resourceUnit: ResourceUnit) {
  return await tx.query.budgetCounters.findFirst({
    where: and(
      eq(schema.budgetCounters.scope, "run"),
      eq(schema.budgetCounters.scopeRefId, scopeRefId),
      eq(schema.budgetCounters.resourceUnit, resourceUnit)
    ),
  });
}

// ---------------------------------------------------------------------------
// 1-2. Unit isolation
// ---------------------------------------------------------------------------

describe("resource-unit isolation", () => {
  it("holds independent counters per unit on the SAME scope key", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "10.00");
      await seedCounter(tx, runId, "subscription_tokens", "50000");

      const usd = await reserveBudget(tx, "run", runId, "llm", "usd", 4);
      const subs = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 20000);

      expect(usd.authorized).toBe(true);
      expect(subs.authorized).toBe(true);

      // Each reservation moved ONLY its own counter. If the dimension
      // collapsed, one of these would carry the other's amount.
      expect(Number((await readCounter(tx, runId, "usd"))!.reservedAmount)).toBeCloseTo(4, 10);
      expect(Number((await readCounter(tx, runId, "subscription_tokens"))!.reservedAmount)).toBeCloseTo(20000, 10);
    });
  });

  it("an EXHAUSTED usd counter does not block subscription_tokens on the same run (and vice versa)", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "1.00");
      await seedCounter(tx, runId, "subscription_tokens", "50000");

      // Spend the entire usd budget.
      const exhaust = await reserveBudget(tx, "run", runId, "llm", "usd", 1);
      expect(exhaust.authorized).toBe(true);
      const refused = await reserveBudget(tx, "run", runId, "llm", "usd", 0.01);
      expect(refused).toEqual({ authorized: false, reason: "insufficient_budget" });

      // The token budget is untouched and still authorizes. A single shared
      // `consumed_amount` would refuse this too.
      const stillFine = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 20000);
      expect(stillFine.authorized).toBe(true);
    });
  });

  it("refuses a unit that has NO counter even when another unit on the same scope is funded", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "1000.00");

      // No `subscription_tokens` row exists. "No row for this unit" must behave
      // as a zero-limit budget for that unit — never fall back to the funded
      // usd counter. This is what stops a subscription call being paid for out
      // of a monetary budget.
      const result = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 1);
      expect(result).toEqual({ authorized: false, reason: "insufficient_budget" });
    });
  });

  it("reconcile and release act on the reserving unit's counter only", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "10.00");
      await seedCounter(tx, runId, "subscription_tokens", "50000");

      const subs = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 20000);
      if (!subs.authorized) throw new Error("expected authorization");
      await reconcileBudget(tx, subs.reservationId, 17345);

      const tokenCounter = await readCounter(tx, runId, "subscription_tokens");
      expect(Number(tokenCounter!.reservedAmount)).toBeCloseTo(0, 10);
      expect(Number(tokenCounter!.consumedAmount)).toBeCloseTo(17345, 10);

      // The monetary counter never moved — subscription usage never enters USD
      // accounting (requirement 8).
      const usdCounter = await readCounter(tx, runId, "usd");
      expect(Number(usdCounter!.reservedAmount)).toBe(0);
      expect(Number(usdCounter!.consumedAmount)).toBe(0);
    });
  });

  it("releases against the reserving unit only", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "10.00");
      await seedCounter(tx, runId, "subscription_tokens", "50000");

      const subs = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 20000);
      if (!subs.authorized) throw new Error("expected authorization");
      await releaseReservation(tx, subs.reservationId);

      expect(Number((await readCounter(tx, runId, "subscription_tokens"))!.reservedAmount)).toBeCloseTo(0, 10);
      expect(Number((await readCounter(tx, runId, "subscription_tokens"))!.consumedAmount)).toBe(0);
      expect(Number((await readCounter(tx, runId, "usd"))!.reservedAmount)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3-4. Reservation-id unit handling
// ---------------------------------------------------------------------------

describe("reservation id carries its unit", () => {
  it("rejects a reservation whose unit has no counter (mismatch), rather than reconciling against another unit", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "subscription_tokens", "50000");

      const subs = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 100);
      if (!subs.authorized) throw new Error("expected authorization");

      // Remove the token counter and provision a usd one instead: the
      // reservation's own unit no longer resolves. It must throw rather than
      // silently find the usd row and decrement THAT.
      await tx
        .delete(schema.budgetCounters)
        .where(
          and(
            eq(schema.budgetCounters.scopeRefId, runId),
            eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
          )
        );
      await seedCounter(tx, runId, "usd", "10.00");

      await expect(reconcileBudget(tx, subs.reservationId, 50)).rejects.toThrow(/resourceUnit="subscription_tokens"/);

      const usdCounter = await readCounter(tx, runId, "usd");
      expect(Number(usdCounter!.reservedAmount)).toBe(0);
      expect(Number(usdCounter!.consumedAmount)).toBe(0);
    });
  });

  it("REJECTS a reservation id with no resourceUnit — never defaults it to usd", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await seedCounter(tx, runId, "usd", "10.00");

      // A legacy-shaped id: valid in every other respect, but minted before the
      // unit existed. Defaulting it to "usd" would silently reconcile an
      // unknown-unit reservation against the monetary ledger.
      const legacyPayload = {
        scope: "run",
        scopeRefId: runId,
        estimatedAmount: "5",
        nonce: randomUUID(),
      };
      const legacyId = "res_" + Buffer.from(JSON.stringify(legacyPayload), "utf8").toString("base64url");

      await expect(reconcileBudget(tx, legacyId, 5)).rejects.toThrow(/no recognized resourceUnit/);
      await expect(releaseReservation(tx, legacyId)).rejects.toThrow(/no recognized resourceUnit/);

      // Nothing was written on either refusal.
      const usdCounter = await readCounter(tx, runId, "usd");
      expect(Number(usdCounter!.reservedAmount)).toBe(0);
      expect(Number(usdCounter!.consumedAmount)).toBe(0);
    });
  });

  it("rejects a reservation id naming an unrecognized unit", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      const bogus = {
        scope: "run",
        scopeRefId: runId,
        resourceUnit: "bitcoin",
        estimatedAmount: "5",
        nonce: randomUUID(),
      };
      const bogusId = "res_" + Buffer.from(JSON.stringify(bogus), "utf8").toString("base64url");

      await expect(reconcileBudget(tx, bogusId, 5)).rejects.toThrow(/no recognized resourceUnit/);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Migration backfill
// ---------------------------------------------------------------------------

describe("migration 0006 backfill", () => {
  it("defaults a counter inserted without an explicit unit to usd (the budget_counters backfill mechanism)", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: runId, limitAmount: "3.00" });

      const row = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
      });
      expect(row?.resourceUnit).toBe("usd");
    });
  });

  it("the migration's OWN events backfill statement sets usage-bearing rows to usd and leaves non-usage rows null", async () => {
    // Read the real statement out of the migration file rather than retyping
    // it, so this test exercises what actually ships.
    const migrationsDir = path.resolve("drizzle");
    const file = readdirSync(migrationsDir).find((f) => f.startsWith("0006_"));
    expect(file, "migration 0006 must exist").toBeDefined();
    const sqlText = readFileSync(path.join(migrationsDir, file!), "utf8");
    const backfill = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => /UPDATE "events" SET "cost_unit"/.test(s));
    expect(backfill, "migration 0006 must contain the events cost_unit backfill").toBeDefined();

    await withRollback(async (tx) => {
      // A usage-bearing row with a NULL unit — exactly what a pre-migration row
      // looked like. Inserted raw, bypassing emitEvent (which now refuses it).
      const withUsage = randomUUID();
      const withoutUsage = randomUUID();
      // `id` is generated application-side (`$defaultFn`), not by a DB default,
      // so a raw insert must supply it.
      await tx.execute(
        sql`insert into events (id, idempotency_key, event_type, event_version, sequence_no, actor, producer, payload,
                                tokens_in, tokens_out, cost_amount, model_id, cost_unit)
            values (${randomUUID()}, ${withUsage}, 'invocation_completed', 1, 9001, 'system', 'test', '{}'::jsonb,
                    10, 5, '0.01', 'm', NULL)`
      );
      await tx.execute(
        sql`insert into events (id, idempotency_key, event_type, event_version, sequence_no, actor, producer, payload, cost_unit)
            values (${randomUUID()}, ${withoutUsage}, 'run_started', 1, 9002, 'system', 'test', '{}'::jsonb, NULL)`
      );

      // 0006 ran before 0016 made events immutable; replay it as it ran (rolled back with the test).
      await tx.execute(sql.raw('ALTER TABLE "events" DISABLE TRIGGER "events_immutable"'));
      await tx.execute(sql.raw(backfill!.replace(/;\s*$/, "")));

      const usageRow = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, withUsage) });
      const plainRow = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, withoutUsage) });

      expect(usageRow?.costUnit).toBe("usd");
      // A non-usage event legitimately has no unit — the backfill must not
      // invent one, or `hasUsage` would start reconstructing empty usage objects.
      expect(plainRow?.costUnit).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 6-7. Event usage requires a unit
// ---------------------------------------------------------------------------

describe("event usage carries its resource unit", () => {
  it("round-trips subscription_tokens usage distinguishably from usd", async () => {
    await withRollback(async (tx) => {
      const emitted = await emitEvent(tx, {
        idempotencyKey: `sub-usage-${randomUUID()}`,
        eventType: "invocation_completed",
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
        actor: "system",
        producer: "test",
        payload: {},
        usage: {
          tokensIn: 2,
          tokensOut: 80,
          cacheHit: false,
          costAmount: 11_741,
          costUnit: "subscription_tokens",
          modelId: "claude-opus-5",
          secondaryUsage: [{ modelId: "claude-haiku-4-5-20251001", tokensIn: 899, tokensOut: 9 }],
        },
      });

      expect(emitted.usage?.costUnit).toBe("subscription_tokens");
      // The amount is a token count, NOT dollars, and not zero.
      expect(emitted.usage?.costAmount).toBe(11_741);

      const row = await tx.query.events.findFirst({ where: eq(schema.events.id, emitted.eventId) });
      expect(row?.costUnit).toBe("subscription_tokens");
    });
  });

  it("REFUSES to record usage with no recognized costUnit", async () => {
    await withRollback(async (tx) => {
      await expect(
        emitEvent(tx, {
          idempotencyKey: `no-unit-${randomUUID()}`,
          eventType: "invocation_completed",
          eventVersion: 1,
          causationId: null,
          correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
          actor: "system",
          producer: "test",
          payload: {},
          // Deliberately bypassing the compile-time requirement: the runtime
          // guard must hold independently, because a cost amount recorded
          // without its unit is permanently ambiguous on an immutable event.
          usage: { tokensIn: 1, tokensOut: 1, cacheHit: false, costAmount: 5, modelId: "m" } as never,
        })
      ).rejects.toThrow(/never be recorded without the unit/);
    });
  });

  it("fails closed when reading a usage-bearing row whose unit was lost", async () => {
    await withRollback(async (tx) => {
      const key = `lost-unit-${randomUUID()}`;
      await tx.execute(
        sql`insert into events (id, idempotency_key, event_type, event_version, sequence_no, actor, producer, payload,
                                tokens_in, tokens_out, cost_amount, model_id, cost_unit)
            values (${randomUUID()}, ${key}, 'invocation_completed', 1, 9100, 'system', 'test', '{}'::jsonb,
                    10, 5, '0.01', 'm', NULL)`
      );

      // emitEvent's idempotent re-read path maps this row; it must throw rather
      // than silently reporting the amount as dollars.
      await expect(
        emitEvent(tx, {
          idempotencyKey: key,
          eventType: "invocation_completed",
          eventVersion: 1,
          causationId: null,
          correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
          actor: "system",
          producer: "test",
          payload: {},
          usage: { tokensIn: 10, tokensOut: 5, cacheHit: false, costAmount: 0.01, costUnit: "usd", modelId: "m" },
        })
      ).rejects.toThrow(/not a recognized ResourceUnit/);
    });
  });
});

// ---------------------------------------------------------------------------
// Structural: the unique index really is three columns
// ---------------------------------------------------------------------------

describe("budget_counters uniqueness is per (scope, scopeRefId, resourceUnit)", () => {
  it("permits two units on one scope key but still refuses a duplicate within one unit", async () => {
    const scopeRefId = randomUUID();
    let caught: unknown;
    try {
      await testDb.transaction(async (tx) => {
        await tx.insert(schema.budgetCounters).values({
          scope: "run",
          scopeRefId,
          resourceUnit: "usd",
          limitAmount: "1.00",
        });
        // Different unit, same scope key — must be allowed.
        await tx.insert(schema.budgetCounters).values({
          scope: "run",
          scopeRefId,
          resourceUnit: "subscription_tokens",
          limitAmount: "100",
        });
        // Same unit again — must collide.
        await tx.insert(schema.budgetCounters).values({
          scope: "run",
          scopeRefId,
          resourceUnit: "usd",
          limitAmount: "2.00",
        });
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
    expect(cause?.constraint ?? cause?.message).toMatch(/budget_counters_scope_scope_ref_id_resource_unit_idx/);
  });
});

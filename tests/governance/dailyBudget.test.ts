/**
 * Aggregate DAY budget (Phase 8).
 *
 * Properties under test, each written so a regression fails it:
 *
 *  1. INERT BY DEFAULT. With no daily ceiling configured, no day counter exists
 *     and the reservation id is byte-for-byte the pre-Phase-8 shape.
 *  2. ADDITIVE. With a ceiling, BOTH the run and the day counter must have
 *     room; exhausting either refuses. The day scope never weakens the run.
 *  3. N RUNS CANNOT BYPASS IT. Independent runs share one day counter.
 *  4. UNITS STAY SEPARATE. One day counter per unit; usd and
 *     subscription_tokens never share or substitute an allowance.
 *  5. ATOMIC AND LEAK-FREE. Reserve / reconcile / release move both counters
 *     together; a refusal writes to neither; concurrent reservations cannot
 *     jointly overspend and cannot deadlock.
 *
 * Ceilings are injected: the shipped configuration is empty by design, and no
 * production limit value is invented here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { and, eq, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "../testDb.js";
import { budgetCounters } from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

// These tests reserve against bare Run counters (no `runs` row), so the Task Instance
// hold (D20), which resolves the Run's Task Instance, is off here; it has its own file.
vi.mock("../../src/governance/runBudgetPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/governance/runBudgetPolicy.js")>()),
  TASK_INSTANCE_BUDGET_CEILINGS: Object.freeze({}),
}));

import { reserveBudget, reconcileBudget, releaseReservation } from "../../src/governance/budget.js";
import { DAILY_BUDGET_CEILINGS, dayScopeRef } from "../../src/governance/dailyBudgetPolicy.js";
import type { ResourceUnit } from "../../src/governance/resourceUnit.js";

/** No day and no Task Instance ceiling: the pre-Phase-8 single-counter path. */
const NO_CEILINGS = { dailyCeilings: {}, taskInstanceCeilings: {} } as const;

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const DAY1 = new Date("2031-03-10T12:00:00.000Z");
const DAY2 = new Date("2031-03-11T12:00:00.000Z");

async function seedRun(tx: DrizzleTransaction, resourceUnit: ResourceUnit, limitAmount: string) {
  const runId = randomUUID();
  await tx.insert(budgetCounters).values({
    scope: "run",
    scopeRefId: runId,
    resourceUnit,
    limitAmount,
    reservedAmount: "0",
    consumedAmount: "0",
  });
  return runId;
}

async function read(tx: DrizzleTransaction, scope: "run" | "day", scopeRefId: string, resourceUnit: ResourceUnit) {
  return tx.query.budgetCounters.findFirst({
    where: and(
      eq(budgetCounters.scope, scope),
      eq(budgetCounters.scopeRefId, scopeRefId),
      eq(budgetCounters.resourceUnit, resourceUnit)
    ),
  });
}

function decode(reservationId: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(reservationId.slice("res_".length), "base64url").toString("utf8"));
}

// ---------------------------------------------------------------------------

describe("shipped configuration (operator decision D3, 2026-09-15)", () => {
  it("ships exactly usd 5.00 and subscription_tokens 200000 per day, as separate units, and cannot be raised at runtime", () => {
    expect(DAILY_BUDGET_CEILINGS).toEqual({ usd: "5.00", subscription_tokens: "200000" });
    expect(Object.isFrozen(DAILY_BUDGET_CEILINGS)).toBe(true);
  });

  it("with no ceiling for a unit, creates no day counter and returns the unchanged single-counter id", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const result = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 100, NO_CEILINGS);
      if (!result.authorized) throw new Error("expected authorization");

      const payload = decode(result.reservationId);
      expect(payload.scope).toBe("run");
      expect(payload.holds).toBeUndefined();

      const dayRows = await tx.select().from(budgetCounters).where(eq(budgetCounters.scope, "day"));
      expect(dayRows).toHaveLength(0);
    });
  });

  it("keys days by the LOCAL calendar date, from local midnight to local midnight", () => {
    // Built from local fields, so this holds in whatever zone the process runs in.
    expect(dayScopeRef(new Date(2031, 2, 10, 0, 0, 0, 0))).toBe("2031-03-10");
    expect(dayScopeRef(new Date(2031, 2, 10, 23, 59, 59, 999))).toBe("2031-03-10");
    expect(dayScopeRef(new Date(2031, 2, 11, 0, 0, 0, 0))).toBe("2031-03-11");
  });

  it("is not the UTC date when the local zone is offset from UTC", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland"; // UTC+13 on this date (daylight saving)
      expect(dayScopeRef(new Date("2031-03-10T12:30:00.000Z"))).toBe("2031-03-11");
      process.env.TZ = "America/Los_Angeles"; // UTC-7 on this date
      expect(dayScopeRef(new Date("2031-03-11T03:00:00.000Z"))).toBe("2031-03-10");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("enforcement", () => {
  const ceilings = { subscription_tokens: "100" } as const;

  it("reserves against both the run and the day counter", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const result = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 30, {
        dailyCeilings: ceilings,
        now: DAY1,
      });
      expect(result.authorized).toBe(true);

      expect((await read(tx, "run", runId, "subscription_tokens"))!.reservedAmount).toBe("30");
      const day = await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens");
      expect(day!.reservedAmount).toBe("30");
      // Provisioned at the governance ceiling, not at anything a caller chose.
      expect(day!.limitAmount).toBe("100");
    });
  });

  it("refuses when the DAY is exhausted even though the run still has budget — N runs cannot bypass it", async () => {
    await withRollback(async (tx) => {
      const runA = await seedRun(tx, "subscription_tokens", "1000");
      const runB = await seedRun(tx, "subscription_tokens", "1000");

      const a = await reserveBudget(tx, "run", runA, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now: DAY1 });
      expect(a.authorized).toBe(true);

      // A fresh, fully-funded run: its OWN counter has 1000 available.
      const b = await reserveBudget(tx, "run", runB, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now: DAY1 });
      expect(b).toEqual({ authorized: false, reason: "insufficient_budget" });

      // The refusal wrote to neither counter.
      expect((await read(tx, "run", runB, "subscription_tokens"))!.reservedAmount).toBe("0");
      expect((await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens"))!.reservedAmount).toBe("60");
    });
  });

  it("still refuses when the RUN is exhausted even though the day has budget", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "50");
      const result = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 60, {
        dailyCeilings: { subscription_tokens: "100000" },
        now: DAY1,
      });
      expect(result).toEqual({ authorized: false, reason: "insufficient_budget" });
      expect((await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens"))!.reservedAmount).toBe("0");
    });
  });

  it("refuses when the run has no counter at all, even with a day ceiling", async () => {
    await withRollback(async (tx) => {
      const result = await reserveBudget(tx, "run", randomUUID(), "llm", "subscription_tokens", 1, {
        dailyCeilings: ceilings,
        now: DAY1,
      });
      expect(result).toEqual({ authorized: false, reason: "insufficient_budget" });
    });
  });

  it("deterministic work reserves nothing at either scope", async () => {
    await withRollback(async (tx) => {
      const result = await reserveBudget(tx, "run", randomUUID(), "deterministic", "usd", 0, {
        dailyCeilings: { usd: "1.00" },
        now: DAY1,
      });
      expect(result).toEqual({ authorized: true, reservationId: "res_noop" });
      expect(await tx.select().from(budgetCounters).where(eq(budgetCounters.scope, "day"))).toHaveLength(0);
    });
  });
});

describe("unit isolation", () => {
  it("keeps a separate day counter per unit; exhausting one never blocks or funds the other", async () => {
    await withRollback(async (tx) => {
      const tokensRun = await seedRun(tx, "subscription_tokens", "1000");
      const usdRun = await seedRun(tx, "usd", "10.00");
      const ceilings = { subscription_tokens: "50", usd: "5.00" } as const;

      const tokens = await reserveBudget(tx, "run", tokensRun, "llm", "subscription_tokens", 50, { dailyCeilings: ceilings, now: DAY1 });
      expect(tokens.authorized).toBe(true);

      // The token day is now full; the usd day is untouched and still usable.
      const usd = await reserveBudget(tx, "run", usdRun, "metered_api", "usd", 2, { dailyCeilings: ceilings, now: DAY1 });
      expect(usd.authorized).toBe(true);

      const tokenDay = await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens");
      const usdDay = await read(tx, "day", dayScopeRef(DAY1), "usd");
      expect(tokenDay!.id).not.toBe(usdDay!.id);
      expect(tokenDay!.reservedAmount).toBe("50");
      expect(usdDay!.reservedAmount).toBe("2");
    });
  });

  it("applies no day hold to a unit without a configured ceiling", async () => {
    await withRollback(async (tx) => {
      const usdRun = await seedRun(tx, "usd", "10.00");
      const result = await reserveBudget(tx, "run", usdRun, "metered_api", "usd", 2, {
        dailyCeilings: { subscription_tokens: "50" },
        now: DAY1,
      });
      if (!result.authorized) throw new Error("expected authorization");
      expect(decode(result.reservationId).holds).toBeUndefined();
      expect(await read(tx, "day", dayScopeRef(DAY1), "usd")).toBeUndefined();
    });
  });

  it("encodes one unit per reservation — mixing units is unrepresentable", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const result = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 10, {
        dailyCeilings: { subscription_tokens: "100" },
        now: DAY1,
      });
      if (!result.authorized) throw new Error("expected authorization");
      const payload = decode(result.reservationId);
      expect(payload.resourceUnit).toBe("subscription_tokens");
      expect(payload.holds).toEqual([
        { scope: "day", scopeRefId: dayScopeRef(DAY1) },
        { scope: "run", scopeRefId: runId },
      ]);
    });
  });
});

describe("reconcile and release move every held counter together", () => {
  const ceilings = { subscription_tokens: "500" } as const;

  it("reconciles actual usage onto both counters", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now: DAY1 });
      if (!r.authorized) throw new Error("expected authorization");

      await reconcileBudget(tx, r.reservationId, 40);

      for (const [scope, ref] of [
        ["run", runId],
        ["day", dayScopeRef(DAY1)],
      ] as const) {
        const row = await read(tx, scope, ref, "subscription_tokens");
        expect(row!.reservedAmount).toBe("0");
        expect(row!.consumedAmount).toBe("40");
      }
    });
  });

  it("releases both holds with no consumption", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now: DAY1 });
      if (!r.authorized) throw new Error("expected authorization");

      await releaseReservation(tx, r.reservationId);

      for (const [scope, ref] of [
        ["run", runId],
        ["day", dayScopeRef(DAY1)],
      ] as const) {
        const row = await read(tx, scope, ref, "subscription_tokens");
        expect(row!.reservedAmount).toBe("0");
        expect(row!.consumedAmount).toBe("0");
      }
    });
  });

  it("reconciles against the day the reservation was MADE, across midnight", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const late = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 30, { dailyCeilings: ceilings, now: DAY1 });
      if (!late.authorized) throw new Error("expected authorization");

      // A reservation on the next day opens that day's own counter.
      const early = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 20, { dailyCeilings: ceilings, now: DAY2 });
      expect(early.authorized).toBe(true);

      await reconcileBudget(tx, late.reservationId, 25);

      const day1 = await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens");
      const day2 = await read(tx, "day", dayScopeRef(DAY2), "subscription_tokens");
      expect(day1!.consumedAmount).toBe("25");
      expect(day1!.reservedAmount).toBe("0");
      expect(day2!.consumedAmount).toBe("0");
      expect(day2!.reservedAmount).toBe("20");
    });
  });

  it("throws before writing anything if a held counter has disappeared", async () => {
    await withRollback(async (tx) => {
      const runId = await seedRun(tx, "subscription_tokens", "1000");
      const r = await reserveBudget(tx, "run", runId, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now: DAY1 });
      if (!r.authorized) throw new Error("expected authorization");

      await tx.delete(budgetCounters).where(and(eq(budgetCounters.scope, "run"), eq(budgetCounters.scopeRefId, runId)));

      await expect(reconcileBudget(tx, r.reservationId, 40)).rejects.toThrow(/scope="run"/);
      // The day counter was not half-reconciled.
      const day = await read(tx, "day", dayScopeRef(DAY1), "subscription_tokens");
      expect(day!.reservedAmount).toBe("60");
      expect(day!.consumedAmount).toBe("0");
    });
  });

  it("rejects a malformed multi-counter reservation id", async () => {
    await withRollback(async (tx) => {
      const bad = (payload: Record<string, unknown>) =>
        "res_" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

      const base = { resourceUnit: "subscription_tokens", estimatedAmount: "5", nonce: randomUUID() };
      await expect(reconcileBudget(tx, bad({ ...base, holds: [] }), 1)).rejects.toThrow(/malformed/);
      await expect(
        reconcileBudget(tx, bad({ ...base, holds: [{ scope: "galaxy", scopeRefId: "x" }] }), 1)
      ).rejects.toThrow(/malformed/);
      await expect(
        reconcileBudget(
          tx,
          bad({ ...base, holds: [{ scope: "run", scopeRefId: "x" }, { scope: "run", scopeRefId: "x" }] }),
          1
        )
      ).rejects.toThrow(/malformed/);
      await expect(
        reconcileBudget(tx, bad({ holds: [{ scope: "run", scopeRefId: "x" }], estimatedAmount: "5", nonce: "n" }), 1)
      ).rejects.toThrow(/no recognized resourceUnit/);
    });
  });
});

describe("no production caller can override the ceilings", () => {
  it("only budget.ts itself references the dailyCeilings or taskInstanceCeilings injection options", () => {
    // `reserveBudget`'s options exist for tests. A production caller passing
    // them could replace or empty the governance ceilings — reopening the
    // self-authorization hole Phase 8 closed for run budgets.
    const srcRoot = path.join(process.cwd(), "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });

    const offenders = walk(srcRoot)
      .map((file) => ({
        file: path.relative(srcRoot, file).replace(/\\/g, "/"),
        code: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
      }))
      .filter(({ file, code }) => file !== "governance/budget.ts" && /\b(dailyCeilings|taskInstanceCeilings)\b/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("no production call passes reserveBudget an options object — neither dailyCeilings nor now", () => {
    // `now` is as dangerous as `dailyCeilings`: a future date lands on a fresh,
    // unspent day counter and dodges today's ceiling. Production calls pass
    // exactly the six positional arguments, so a seventh (a literal or a variable),
    // a spread, or an aliased import outside budget.ts is an override. Parsed, not
    // pattern-matched.
    const srcRoot = path.join(process.cwd(), "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const rel = path.relative(srcRoot, file).replace(/\\/g, "/");
      if (rel === "governance/budget.ts") continue;
      const visit = (node: ts.Node): void => {
        if (ts.isImportSpecifier(node) && node.propertyName?.text === "reserveBudget") offenders.push(`${rel} (aliased import)`);
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
          if (name === "reserveBudget" && (node.arguments.length !== 6 || node.arguments.some(ts.isSpreadElement))) offenders.push(rel);
        }
        node.forEachChild(visit);
      };
      visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
    }
    expect(offenders).toEqual([]);
  });
});

describe("concurrency", () => {
  function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it(
    "two genuinely concurrent runs cannot jointly overspend the shared day, and do not deadlock",
    async () => {
      // A far-future day so no other test's committed rows can collide.
      const now = new Date("2099-06-15T12:00:00.000Z");
      const dayRef = dayScopeRef(now);
      const ceilings = { subscription_tokens: "100" } as const;
      const runA = randomUUID();
      const runB = randomUUID();

      for (const runId of [runA, runB]) {
        await testDb.insert(budgetCounters).values({
          scope: "run",
          scopeRefId: runId,
          resourceUnit: "subscription_tokens",
          limitAmount: "1000",
          reservedAmount: "0",
          consumedAmount: "0",
        });
      }

      try {
        const aStarted = createDeferred();
        const bStarted = createDeferred();

        const a = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          aStarted.resolve();
          await bStarted.promise;
          return reserveBudget(tx, "run", runA, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now });
        });
        const b = testDb.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          bStarted.resolve();
          await aStarted.promise;
          return reserveBudget(tx, "run", runB, "llm", "subscription_tokens", 60, { dailyCeilings: ceilings, now });
        });

        const results = await Promise.all([a, b]);

        // 60 + 60 > 100: exactly one may be authorized.
        expect(results.filter((r) => r.authorized)).toHaveLength(1);

        const day = await testDb.query.budgetCounters.findFirst({
          where: and(eq(budgetCounters.scope, "day"), eq(budgetCounters.scopeRefId, dayRef)),
        });
        expect(day!.reservedAmount).toBe("60");
      } finally {
        await testDb.delete(budgetCounters).where(eq(budgetCounters.scopeRefId, runA));
        await testDb.delete(budgetCounters).where(eq(budgetCounters.scopeRefId, runB));
        await testDb.delete(budgetCounters).where(eq(budgetCounters.scopeRefId, dayRef));
      }
    },
    20000
  );
});

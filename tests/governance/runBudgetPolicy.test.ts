/**
 * Run budget authority (Phase 8).
 *
 * The property under test: capability code cannot choose, raise, or pass the
 * ceiling that governs it. Before Phase 8 a builder supplied its own
 * `limitAmount` and even exposed a `runBudgetLimit` knob with a fallback.
 *
 * Written so the fix cannot be quietly undone:
 *   - the production builder is driven for real and must yield EXACTLY the
 *     governance ceilings;
 *   - structural checks fail if any file under `src/capabilities/` writes
 *     `budget_counters`, re-imports an arbitrary-limit helper, or regrows a
 *     `runBudgetLimit` option;
 *   - re-provisioning can neither raise a ceiling nor reset in-flight amounts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import * as runBudgetPolicy from "../../src/governance/runBudgetPolicy.js";
import { provisionRunBudgets, RUN_BUDGET_CEILINGS } from "../../src/governance/runBudgetPolicy.js";
import { seedResearchWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import { createStandaloneTaskInstance } from "../../src/execution/taskInstance.js";
import { buildResearchReportInvocationSpecs } from "../../src/capabilities/researchRetrieve/buildInvocationSpecs.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function counters(tx: DrizzleTransaction, runId: string) {
  const rows = await tx
    .select()
    .from(schema.budgetCounters)
    .where(and(eq(schema.budgetCounters.scope, "run"), eq(schema.budgetCounters.scopeRefId, runId)));
  return Object.fromEntries(rows.map((r) => [r.resourceUnit, r]));
}

async function seedRun(tx: DrizzleTransaction) {
  const seed = await seedResearchWorkflow(tx);
  const { taskInstanceId } = await createStandaloneTaskInstance(tx, seed.taskDefinitionId, seed.goalId, {
    query: "q",
  });
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId, status: "active" }).returning();
  return { seed, taskInstanceId, runId: run!.id };
}

describe("governance owns the ceilings", () => {
  it("keeps the production values unchanged: $1.00 and 200,000 subscription_tokens per Run", () => {
    expect(RUN_BUDGET_CEILINGS).toEqual({ usd: "1.00", subscription_tokens: "200000" });
  });

  it("cannot be raised at runtime", () => {
    expect(Object.isFrozen(RUN_BUDGET_CEILINGS)).toBe(true);
    expect(() => {
      (RUN_BUDGET_CEILINGS as Record<string, string>).subscription_tokens = "999999999";
    }).toThrow(TypeError);
    expect(RUN_BUDGET_CEILINGS.subscription_tokens).toBe("200000");
  });

  it("exposes no function that accepts an arbitrary limit", () => {
    // The only exports: the frozen ceilings and a provisioner taking (tx, runId).
    expect(Object.keys(runBudgetPolicy).sort()).toEqual(["RUN_BUDGET_CEILINGS", "provisionRunBudgets"]);
    expect(provisionRunBudgets.length).toBe(2);
  });

  it("provisions one independent counter per unit at exactly the governance ceilings", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRun(tx);
      await provisionRunBudgets(tx, runId);

      const rows = await counters(tx, runId);
      expect(Object.keys(rows).sort()).toEqual(["subscription_tokens", "usd"]);
      expect(rows.usd!.limitAmount).toBe("1.00");
      expect(rows.subscription_tokens!.limitAmount).toBe("200000");
      for (const row of Object.values(rows)) {
        expect(row!.reservedAmount).toBe("0");
        expect(row!.consumedAmount).toBe("0");
      }
    });
  });

  it("re-provisioning never raises a ceiling and never resets in-flight amounts", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRun(tx);
      await provisionRunBudgets(tx, runId);

      // Simulate a run mid-flight with a lowered ceiling.
      await tx
        .update(schema.budgetCounters)
        .set({ limitAmount: "500", reservedAmount: "120", consumedAmount: "80" })
        .where(
          and(
            eq(schema.budgetCounters.scopeRefId, runId),
            eq(schema.budgetCounters.resourceUnit, "subscription_tokens")
          )
        );

      // A resume of an awaiting_approval step re-runs the builder, and with it
      // provisioning. That must be a strict no-op on the existing row.
      await provisionRunBudgets(tx, runId);

      const row = (await counters(tx, runId)).subscription_tokens!;
      expect(row.limitAmount).toBe("500");
      expect(row.reservedAmount).toBe("120");
      expect(row.consumedAmount).toBe("80");
    });
  });
});

describe("the real production builder cannot self-authorize", () => {
  it("provisions exactly the governance ceilings, with no way to pass a different one", async () => {
    await withRollback(async (tx) => {
      const { seed, taskInstanceId, runId } = await seedRun(tx);

      await buildResearchReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.agentDefinitionId,
          agentDefinitionVersion: seed.agentDefinitionVersion,
          query: "q",
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
          // A capability trying to grant itself more. The option no longer
          // exists, so it is ignored at runtime and rejected by the compiler.
          // @ts-expect-error — runBudgetLimit was removed from the builder config.
          runBudgetLimit: "999999",
        },
        { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: 1, taskInstanceId, input: {} }
      );

      const rows = await counters(tx, runId);
      expect(rows.usd!.limitAmount).toBe(RUN_BUDGET_CEILINGS.usd);
      expect(rows.subscription_tokens!.limitAmount).toBe(RUN_BUDGET_CEILINGS.subscription_tokens);
    });
  });
});

describe("structural: capability code holds no budget authority", () => {
  const capabilitiesRoot = path.join(process.cwd(), "src", "capabilities");

  function capabilityFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return capabilityFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  const sources = capabilityFiles(capabilitiesRoot).map((file) => ({
    file: path.relative(process.cwd(), file),
    // Comments may legitimately DESCRIBE the old design; only code counts.
    code: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  }));

  it("no file under src/capabilities/ writes budget_counters", () => {
    const offenders = sources.filter((s) => /budgetCounters|budget_counters/.test(s.code)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("no capability config regrows a runBudgetLimit option or an arbitrary-limit helper", () => {
    const offenders = sources
      .filter((s) => /runBudgetLimit|ensureRunBudgetCounter|ensureRunCounter|limitAmount/.test(s.code))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

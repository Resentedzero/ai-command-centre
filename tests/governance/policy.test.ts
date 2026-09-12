import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import { capabilities, agentDefinitions } from "../../src/db/schema.js";
import { evaluatePolicy, validateCapabilityGrant, type CapabilityGrant } from "../../src/governance/policy.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

/** A tx proxy that throws on any property access — proves a code path never touches the DB. */
function poisonedTx(): DrizzleTransaction {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("evaluatePolicy touched `tx` when it should not have for this input");
      },
    }
  ) as unknown as DrizzleTransaction;
}

async function seedCapabilityAndAgent(
  tx: DrizzleTransaction,
  staticRiskTag: string
): Promise<{ capabilityId: string; agentDefinitionId: string; agentDefinitionVersion: number }> {
  const [capability] = await tx
    .insert(capabilities)
    .values({ name: "test.capability", description: "fixture", staticRiskTag })
    .returning();

  const [agentDefinition] = await tx
    .insert(agentDefinitions)
    .values({
      name: "test-agent",
      version: 1,
      role: "tester",
      objective: "exercise policy",
      instructions: "n/a",
    })
    .returning();

  return {
    capabilityId: capability!.id,
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
  };
}

describe("evaluatePolicy", () => {
  it("returns DENY when grant is null — never touches tx, never reaches risk computation", async () => {
    const result = await evaluatePolicy(poisonedTx(), {
      grant: null,
      permission: "READ",
      proposedActionSnapshot: {},
      trustLevel: "first_party",
    });
    expect(result.decision).toBe("DENY");
  });

  it("returns DENY when the requested permission is not in the grant's permissions (generic check, no permission-type branch)", async () => {
    const grant: CapabilityGrant = {
      agentDefinitionId: "00000000-0000-0000-0000-000000000000",
      agentDefinitionVersion: 1,
      capabilityId: "00000000-0000-0000-0000-000000000000",
      permissions: ["READ"],
      autonomyState: "AUTONOMOUS",
    };
    const result = await evaluatePolicy(poisonedTx(), {
      grant,
      permission: "WRITE",
      proposedActionSnapshot: {},
      trustLevel: "first_party",
    });
    expect(result.decision).toBe("DENY");
  });

  it("returns ALLOW for an AUTONOMOUS grant with a covered permission", async () => {
    await withRollback(async (tx) => {
      const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
      const grant: CapabilityGrant = {
        agentDefinitionId,
        agentDefinitionVersion,
        capabilityId,
        permissions: ["READ"],
        autonomyState: "AUTONOMOUS",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "READ",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
      });
      expect(result.decision).toBe("ALLOW");
      expect(result.riskTier).toBe("low");
    });
  });

  it("returns REQUIRE_APPROVAL for an ALWAYS_APPROVE grant", async () => {
    await withRollback(async (tx) => {
      const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
      const grant: CapabilityGrant = {
        agentDefinitionId,
        agentDefinitionVersion,
        capabilityId,
        permissions: ["SPEND"],
        autonomyState: "ALWAYS_APPROVE",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
      });
      expect(result.decision).toBe("REQUIRE_APPROVAL");
    });
  });

  it("returns REQUIRE_APPROVAL for a CONDITIONAL grant too (V1: no performance-driven relaxation)", async () => {
    await withRollback(async (tx) => {
      const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
      const grant: CapabilityGrant = {
        agentDefinitionId,
        agentDefinitionVersion,
        capabilityId,
        permissions: ["SPEND"],
        autonomyState: "CONDITIONAL",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
      });
      expect(result.decision).toBe("REQUIRE_APPROVAL");
    });
  });

  it("computes riskTier from the capability's staticRiskTag and the proposedActionSnapshot/trustLevel escalation factors", async () => {
    await withRollback(async (tx) => {
      const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
      const grant: CapabilityGrant = {
        agentDefinitionId,
        agentDefinitionVersion,
        capabilityId,
        permissions: ["SPEND"],
        autonomyState: "ALWAYS_APPROVE",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: { amountOrScope: 1_000_000, isNovelAction: true },
        trustLevel: "unverified_third_party",
      });
      expect(result.riskTier).toBe("highest");
    });
  });

  describe("fix-round-1: malformed proposedActionSnapshot fields fail closed (throw), absent fields default safely", () => {
    it("throws when amountOrScope is present but not a number (e.g. a string)", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["SPEND"],
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { amountOrScope: "a lot" },
            trustLevel: "first_party",
          })
        ).rejects.toThrow(/amountOrScope/);
      });
    });

    it("throws when amountOrScope is present but NaN (would otherwise silently fail every escalation comparison)", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["SPEND"],
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { amountOrScope: NaN },
            trustLevel: "first_party",
          })
        ).rejects.toThrow(/amountOrScope/);
      });
    });

    it("throws when isNovelAction is present but not a boolean (e.g. the string \"yes\")", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["SPEND"],
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { isNovelAction: "yes" },
            trustLevel: "first_party",
          })
        ).rejects.toThrow(/isNovelAction/);
      });
    });

    it("accepts an absent amountOrScope/isNovelAction (defaults to null/false) and an explicit amountOrScope: null (also valid)", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["SPEND"],
          autonomyState: "ALWAYS_APPROVE",
        };
        const resultAbsent = await evaluatePolicy(tx, {
          grant,
          permission: "SPEND",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
        });
        expect(resultAbsent.riskTier).toBe("low");

        const resultExplicitNull = await evaluatePolicy(tx, {
          grant,
          permission: "SPEND",
          proposedActionSnapshot: { amountOrScope: null },
          trustLevel: "first_party",
        });
        expect(resultExplicitNull.riskTier).toBe("low");
      });
    });
  });
});

describe("validateCapabilityGrant — SPEND/TRADE/PUBLISH/DELETE autonomy ceiling", () => {
  const base = {
    agentDefinitionId: "00000000-0000-0000-0000-000000000000",
    agentDefinitionVersion: 1,
    capabilityId: "00000000-0000-0000-0000-000000000000",
  };

  it.each(["SPEND", "TRADE", "PUBLISH", "DELETE"] as const)(
    "rejects a Grant with permissions: [%s] and autonomyState: AUTONOMOUS",
    (permission) => {
      const result = validateCapabilityGrant({
        ...base,
        permissions: [permission],
        autonomyState: "AUTONOMOUS",
      });
      expect(result.valid).toBe(false);
    }
  );

  it.each(["ALWAYS_APPROVE", "CONDITIONAL"] as const)(
    "accepts permissions: [SPEND] at autonomyState %s",
    (autonomyState) => {
      const result = validateCapabilityGrant({
        ...base,
        permissions: ["SPEND"],
        autonomyState,
      });
      expect(result.valid).toBe(true);
    }
  );

  it.each(["READ", "WRITE"] as const)("accepts %s at AUTONOMOUS (ceiling applies only to the four named types)", (permission) => {
    const result = validateCapabilityGrant({
      ...base,
      permissions: [permission],
      autonomyState: "AUTONOMOUS",
    });
    expect(result.valid).toBe(true);
  });
});

describe("Zero budget coupling (Phase 20 risk #2)", () => {
  it("evaluatePolicy's input type has no budget-named field (compile-time enforced below; runtime companion check here)", () => {
    type EvaluatePolicyInput = Parameters<typeof evaluatePolicy>[1];
    type BudgetKeys = Extract<keyof EvaluatePolicyInput, `${string}udget${string}` | `${string}Udget${string}`>;
    // If a budget-named field is ever added to EvaluatePolicyInput, BudgetKeys
    // stops being `never` and this line fails to compile under `npm run
    // build` (tsc --noEmit over tests/**/*.ts per tsconfig's include).
    const _assertNoBudgetField: BudgetKeys extends never ? true : "FAIL: budget field found on evaluatePolicy input" =
      true;
    expect(_assertNoBudgetField).toBe(true);
  });

  it("policy.ts source contains no import of budget.ts/costClass.ts (prose comments explaining the separation may still say the word)", () => {
    const policyPath = fileURLToPath(new URL("../../src/governance/policy.ts", import.meta.url));
    const source = readFileSync(policyPath, "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/from\s+["'].*\/(budget|costClass)\.js["']/);
    expect(code).not.toMatch(/\b(reserveBudget|reconcileBudget|releaseReservation|CostClass)\b/);
    // Broader net: catches any budget-named identifier (e.g. a stray third
    // parameter like `budgetState`) that the specific-symbol check above
    // would miss, not just the known budget.ts exports.
    expect(code).not.toMatch(/\bbudget/i);
  });

  it("policy.ts's evaluatePolicy implementation has no permission-type-specific branch (SPEND/TRADE/PUBLISH/DELETE)", () => {
    const policyPath = fileURLToPath(new URL("../../src/governance/policy.ts", import.meta.url));
    const source = readFileSync(policyPath, "utf8");
    // Isolate evaluatePolicy's body (from its declaration to the next
    // top-level "export" or end of file) and assert none of the four
    // ceiling-only permission literals appear inside it — that logic must
    // live only in validateCapabilityGrant.
    const startIndex = source.indexOf("export async function evaluatePolicy");
    expect(startIndex).toBeGreaterThan(-1);
    const rest = source.slice(startIndex);
    const nextExportIndex = rest.indexOf("\nexport ", 1);
    const body = nextExportIndex === -1 ? rest : rest.slice(0, nextExportIndex);
    for (const permission of ["SPEND", "TRADE", "PUBLISH", "DELETE"]) {
      expect(body).not.toContain(`"${permission}"`);
    }
  });
});

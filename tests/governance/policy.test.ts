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
      bindingTrustLevel: 2,
    });
    expect(result.decision).toBe("DENY");
    expect(result.basis).toBe("no_grant");
  });

  it("returns DENY when the requested permission is not in the grant's permissions (generic check, no permission-type branch)", async () => {
    const grant: CapabilityGrant = {
      agentDefinitionId: "00000000-0000-0000-0000-000000000000",
      agentDefinitionVersion: 1,
      capabilityId: "00000000-0000-0000-0000-000000000000",
      permissions: ["READ"],
      maxTrustLevelRequired: 1,
      autonomyState: "AUTONOMOUS",
    };
    const result = await evaluatePolicy(poisonedTx(), {
      grant,
      permission: "WRITE",
      proposedActionSnapshot: {},
      trustLevel: "first_party",
      bindingTrustLevel: 2,
    });
    expect(result.decision).toBe("DENY");
    expect(result.basis).toBe("permission_not_granted");
  });

  it("returns ALLOW for an AUTONOMOUS grant with a covered permission", async () => {
    await withRollback(async (tx) => {
      const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
      const grant: CapabilityGrant = {
        agentDefinitionId,
        agentDefinitionVersion,
        capabilityId,
        permissions: ["READ"],
        maxTrustLevelRequired: 1,
        autonomyState: "AUTONOMOUS",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "READ",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
        bindingTrustLevel: 2,
      });
      expect(result.decision).toBe("ALLOW");
      expect(result.basis).toBe("autonomy_autonomous");
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
        maxTrustLevelRequired: 1,
        autonomyState: "ALWAYS_APPROVE",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
        bindingTrustLevel: 2,
      });
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.basis).toBe("autonomy_always_approve");
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
        maxTrustLevelRequired: 1,
        autonomyState: "CONDITIONAL",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: {},
        trustLevel: "first_party",
        bindingTrustLevel: 2,
      });
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      // Recorded as undecided, never as an ALWAYS_APPROVE decision or an evaluated threshold.
      expect(result.basis).toBe("autonomy_conditional_rule_undecided");
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
        // 0, not 1: this test is about RISK escalation for an unverified
        // binding, so the Grant's trust bar must be MET (0 >= 0) — otherwise
        // the finding-2 trust DENY short-circuits before risk is computed and
        // the test would silently stop measuring what it names.
        maxTrustLevelRequired: 0,
        autonomyState: "ALWAYS_APPROVE",
      };
      const result = await evaluatePolicy(tx, {
        grant,
        permission: "SPEND",
        proposedActionSnapshot: { amountOrScope: 1_000_000, isNovelAction: true },
        trustLevel: "unverified_third_party",
        bindingTrustLevel: 0,
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
          maxTrustLevelRequired: 1,
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { amountOrScope: "a lot" },
            trustLevel: "first_party",
            bindingTrustLevel: 2,
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
          maxTrustLevelRequired: 1,
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { amountOrScope: NaN },
            trustLevel: "first_party",
            bindingTrustLevel: 2,
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
          maxTrustLevelRequired: 1,
          autonomyState: "ALWAYS_APPROVE",
        };
        await expect(
          evaluatePolicy(tx, {
            grant,
            permission: "SPEND",
            proposedActionSnapshot: { isNovelAction: "yes" },
            trustLevel: "first_party",
            bindingTrustLevel: 2,
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
          maxTrustLevelRequired: 1,
          autonomyState: "ALWAYS_APPROVE",
        };
        const resultAbsent = await evaluatePolicy(tx, {
          grant,
          permission: "SPEND",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel: 2,
        });
        expect(resultAbsent.riskTier).toBe("low");

        const resultExplicitNull = await evaluatePolicy(tx, {
          grant,
          permission: "SPEND",
          proposedActionSnapshot: { amountOrScope: null },
          trustLevel: "first_party",
          bindingTrustLevel: 2,
        });
        expect(resultExplicitNull.riskTier).toBe("low");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Final-review Finding 2: the Grant's declared trust bar
  // (`capability_grants.max_trust_level_required`) vs. the resolved Tool
  // Binding's actual `tool_bindings.trust_level` — Phase 6.
  //
  // Two distinct rules, deliberately producing two different outcomes (see
  // the fix-review report for the full DENY-vs-REQUIRE_APPROVAL reasoning):
  //   Rule 1 — bar NOT met -> DENY. Phase 9.3: DENY "fires when the Grant
  //     doesn't cover the action at all (a configuration fact, not a judgment
  //     call)". Two stored integers disagreeing is exactly a configuration
  //     fact.
  //   Rule 2 — bar met but the binding is `unverified_third_party` -> never
  //     ALLOW; escalate to REQUIRE_APPROVAL. Phase 6: "never eligible for
  //     autonomous EXECUTE-class permissions until explicitly upgraded".
  //     One-directional: it can only tighten ALLOW, never relax an existing
  //     REQUIRE_APPROVAL.
  // -------------------------------------------------------------------------
  describe("Finding 2: Grant trust bar vs. Tool Binding trust level (Phase 6)", () => {
    it("rule 1 (no regression): a binding that MEETS the bar is decided exactly as before", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["READ"],
          maxTrustLevelRequired: 1,
          autonomyState: "AUTONOMOUS",
        };

        // Exceeds the bar (2 > 1) — the seeded V1 shape.
        const exceeds = await evaluatePolicy(tx, {
          grant,
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel: 2,
        });
        expect(exceeds.decision).toBe("ALLOW");
        expect(exceeds.riskTier).toBe("low");

        // Exactly meets the bar (1 === 1) — a minimum, not a strict "above".
        const meets = await evaluatePolicy(tx, {
          grant,
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "verified_third_party",
          bindingTrustLevel: 1,
        });
        expect(meets.decision).toBe("ALLOW");
      });
    });

    it("rule 1: a binding BELOW the bar is DENY — and, like the other DENY paths, never touches tx", async () => {
      const grant: CapabilityGrant = {
        agentDefinitionId: "00000000-0000-0000-0000-000000000000",
        agentDefinitionVersion: 1,
        capabilityId: "00000000-0000-0000-0000-000000000000",
        permissions: ["READ"],
        maxTrustLevelRequired: 1,
        autonomyState: "AUTONOMOUS",
      };
      // poisonedTx proves the insufficient-trust DENY is settled as a
      // configuration fact, before any risk computation — the same structural
      // property the null-grant and uncovered-permission DENYs already have.
      const result = await evaluatePolicy(poisonedTx(), {
        grant,
        permission: "READ",
        proposedActionSnapshot: {},
        trustLevel: "unverified_third_party",
        bindingTrustLevel: 0,
      });
      expect(result.decision).toBe("DENY");
      expect(result.basis).toBe("binding_below_grant_trust_bar");
    });

    it("rule 1 fails closed: a non-finite/absent binding trust level is DENY, never read as 'trusted enough'", async () => {
      const grant: CapabilityGrant = {
        agentDefinitionId: "00000000-0000-0000-0000-000000000000",
        agentDefinitionVersion: 1,
        capabilityId: "00000000-0000-0000-0000-000000000000",
        permissions: ["READ"],
        maxTrustLevelRequired: 1,
        autonomyState: "AUTONOMOUS",
      };
      for (const bindingTrustLevel of [NaN, Infinity, undefined as unknown as number]) {
        const result = await evaluatePolicy(poisonedTx(), {
          grant,
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel,
        });
        expect(result.decision).toBe("DENY");
        expect(result.basis).toBe("binding_below_grant_trust_bar");
      }
    });

    it("rule 2: an unverified_third_party binding is never ALLOW, even with an AUTONOMOUS Grant whose bar it meets", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["EXECUTE"],
          maxTrustLevelRequired: 0, // bar deliberately met, so rule 1 cannot be what fires
          autonomyState: "AUTONOMOUS",
        };
        const result = await evaluatePolicy(tx, {
          grant,
          permission: "EXECUTE",
          proposedActionSnapshot: {},
          trustLevel: "unverified_third_party",
          bindingTrustLevel: 0,
        });
        expect(result.decision).toBe("REQUIRE_APPROVAL");
        expect(result.basis).toBe("unverified_binding_requires_approval");
      });
    });

    it("rule 2 applies to every permission type generically, not just EXECUTE (no permission-type branch)", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["READ", "WRITE", "CREATE", "SEND"],
          maxTrustLevelRequired: 0,
          autonomyState: "AUTONOMOUS",
        };
        for (const permission of ["READ", "WRITE", "CREATE", "SEND"] as const) {
          const result = await evaluatePolicy(tx, {
            grant,
            permission,
            proposedActionSnapshot: {},
            trustLevel: "unverified_third_party",
            bindingTrustLevel: 0,
          });
          expect(result.decision).toBe("REQUIRE_APPROVAL");
          expect(result.basis).toBe("unverified_binding_requires_approval");
        }
      });
    });

    it("rule 2 is one-directional: it never relaxes an existing REQUIRE_APPROVAL, and never applies to trusted bindings", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["READ"],
          maxTrustLevelRequired: 0,
          autonomyState: "ALWAYS_APPROVE",
        };
        const unverified = await evaluatePolicy(tx, {
          grant,
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "unverified_third_party",
          bindingTrustLevel: 0,
        });
        expect(unverified.decision).toBe("REQUIRE_APPROVAL");
        // The Grant's own autonomy required approval; rule 2 changed nothing, so it is not the basis.
        expect(unverified.basis).toBe("autonomy_always_approve");

        // verified_third_party / first_party are untouched by rule 2 — an
        // AUTONOMOUS Grant on those still reaches ALLOW.
        const verifiedGrant: CapabilityGrant = { ...grant, autonomyState: "AUTONOMOUS" };
        const verified = await evaluatePolicy(tx, {
          grant: verifiedGrant,
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "verified_third_party",
          bindingTrustLevel: 1,
        });
        expect(verified.decision).toBe("ALLOW");
      });
    });

    it("trust never GRANTS anything: a maximally-trusted binding cannot exceed the Grant's own permissions[]/autonomyState", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");

        // (a) High trust does not add a permission the Grant never carried.
        const readOnlyGrant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["READ"],
          maxTrustLevelRequired: 0,
          autonomyState: "AUTONOMOUS",
        };
        const uncovered = await evaluatePolicy(poisonedTx(), {
          grant: readOnlyGrant,
          permission: "WRITE",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel: 9_000,
        });
        expect(uncovered.decision).toBe("DENY");

        // (b) High trust does not promote autonomy: ALWAYS_APPROVE stays
        // REQUIRE_APPROVAL no matter how trusted the binding is.
        const approveGrant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["SPEND"],
          maxTrustLevelRequired: 0,
          autonomyState: "ALWAYS_APPROVE",
        };
        const stillGated = await evaluatePolicy(tx, {
          grant: approveGrant,
          permission: "SPEND",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel: 9_000,
        });
        expect(stillGated.decision).toBe("REQUIRE_APPROVAL");

        // (c) Unit 3's structural autonomy ceiling is enforced independently
        // of trust — a maximally-trusted Grant is still an invalid Grant.
        expect(
          validateCapabilityGrant({
            agentDefinitionId,
            agentDefinitionVersion,
            capabilityId,
            permissions: ["SPEND"],
            maxTrustLevelRequired: 9_000,
            autonomyState: "AUTONOMOUS",
          }).valid
        ).toBe(false);
      });
    });

    it("neither trust input can be influenced by the proposed action snapshot (i.e. by anything the model produced)", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const grant: CapabilityGrant = {
          agentDefinitionId,
          agentDefinitionVersion,
          capabilityId,
          permissions: ["READ"],
          maxTrustLevelRequired: 1,
          autonomyState: "AUTONOMOUS",
        };
        // The snapshot is the ONLY evaluatePolicy input a model's output can
        // reach (the Executor builds it from the proposed tool call). Here it
        // claims maximal trust and a zero bar; the real, server-resolved
        // values say otherwise, and the real values must win.
        const result = await evaluatePolicy(tx, {
          grant,
          permission: "READ",
          proposedActionSnapshot: {
            trustLevel: "first_party",
            bindingTrustLevel: 9_000,
            maxTrustLevelRequired: 0,
            grant: { autonomyState: "AUTONOMOUS", permissions: ["READ", "WRITE"], maxTrustLevelRequired: 0 },
          },
          trustLevel: "unverified_third_party",
          bindingTrustLevel: 0,
        });
        expect(result.decision).toBe("DENY");
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
        maxTrustLevelRequired: 1,
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
        maxTrustLevelRequired: 1,
        autonomyState,
      });
      expect(result.valid).toBe(true);
    }
  );

  it.each(["READ", "WRITE"] as const)("accepts %s at AUTONOMOUS (ceiling applies only to the four named types)", (permission) => {
    const result = validateCapabilityGrant({
      ...base,
      permissions: [permission],
      maxTrustLevelRequired: 1,
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

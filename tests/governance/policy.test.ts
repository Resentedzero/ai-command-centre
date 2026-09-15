import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import { capabilities, agentDefinitions } from "../../src/db/schema.js";
import {
  CONDITIONAL_AUTONOMY_RULE,
  evaluatePolicy,
  riskTierComputed,
  validateCapabilityGrant,
  type CapabilityGrant,
  type ConditionalPerformanceEvidence,
} from "../../src/governance/policy.js";
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

  describe("CONDITIONAL: the Conditional Autonomy rule (spec §9.4, decided 2026-09-15)", () => {
    const evidence = (overrides: Partial<ConditionalPerformanceEvidence> = {}): ConditionalPerformanceEvidence => ({
      agentDefinitionId: "a",
      agentDefinitionVersion: 1,
      taskDefinitionId: "t",
      effectiveTier: "MID",
      sampleCount: 12,
      successRate: "0.9",
      minSamples: 10,
      eligible: true,
      eligibilityReason: null,
      ...overrides,
    });

    async function conditional(
      opts: { staticRiskTag?: string; permission?: CapabilityGrant["permissions"][number]; trustLevel?: "first_party" | "unverified_third_party"; evidence?: ConditionalPerformanceEvidence | null; snapshot?: Record<string, unknown> }
    ) {
      return withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, opts.staticRiskTag ?? "low");
        const permission = opts.permission ?? "READ";
        return evaluatePolicy(tx, {
          grant: { agentDefinitionId, agentDefinitionVersion, capabilityId, permissions: [permission], maxTrustLevelRequired: 0, autonomyState: "CONDITIONAL" },
          permission,
          proposedActionSnapshot: opts.snapshot ?? {},
          trustLevel: opts.trustLevel ?? "first_party",
          bindingTrustLevel: 2,
          conditionalEvidence: opts.evidence === undefined ? evidence() : opts.evidence,
        });
      });
    }

    it("allows a low-risk READ at success rate >= 0.80, recording the evidence it consulted", async () => {
      for (const successRate of ["0.8", "0.95", "1"]) {
        const result = await conditional({ evidence: evidence({ successRate }) });
        expect(result).toMatchObject({ decision: "ALLOW", basis: "conditional_performance_meets_allow_threshold", riskTier: "low" });
        expect(result.performanceEvidence).toMatchObject({ effectiveTier: "MID", sampleCount: 12, successRate });
      }
    });

    it("requires approval at 0.60 <= success rate < 0.80, and denies below 0.60 (risk tier still recorded)", async () => {
      for (const successRate of ["0.6", "0.7999"]) {
        expect(await conditional({ evidence: evidence({ successRate }) })).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_performance_below_allow_threshold" });
      }
      for (const successRate of ["0.5999", "0"]) {
        const denied = await conditional({ evidence: evidence({ successRate }) });
        expect(denied).toMatchObject({ decision: "DENY", basis: "conditional_performance_below_deny_threshold", riskTier: "low" });
        expect(riskTierComputed(denied.basis)).toBe(true);
      }
    });

    it("requires approval on insufficient evidence: below the sample criterion, no row, no routed tier, absent, or an unreadable rate", async () => {
      const cases: (ConditionalPerformanceEvidence | null)[] = [
        evidence({ sampleCount: 9, eligible: false, eligibilityReason: "insufficient_samples", successRate: "1" }),
        evidence({ sampleCount: null, successRate: null, eligible: false, eligibilityReason: "no_performance_row" }),
        evidence({ effectiveTier: null, sampleCount: null, successRate: null, eligible: false, eligibilityReason: "no_routed_tier" }),
        evidence({ successRate: "not a number" }),
        evidence({ successRate: "1.5" }),
        null,
      ];
      for (const e of cases) {
        expect(await conditional({ evidence: e })).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_insufficient_evidence" });
      }
    });

    it("keeps every gated action human-approved whatever the performance: non-READ permissions and any risk above low", async () => {
      for (const permission of ["SPEND", "PUBLISH", "DELETE", "WRITE", "CREATE", "SEND", "EXECUTE", "TRADE"] as const) {
        const perfect = await conditional({ permission, evidence: evidence({ successRate: "1" }) });
        expect(perfect).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_human_gated_action", performanceEvidence: null });
        // Poor performance does not deny a gated action either: it stays with the human.
        expect(await conditional({ permission, evidence: evidence({ successRate: "0" }) })).toMatchObject({ decision: "REQUIRE_APPROVAL" });
      }
      expect(await conditional({ staticRiskTag: "medium" })).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_human_gated_action" });
      expect(await conditional({ snapshot: { isNovelAction: true } })).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "conditional_human_gated_action" });
    });

    it("never allows an unverified binding (its risk is escalated above low, so the action is gated)", async () => {
      expect(await conditional({ trustLevel: "unverified_third_party" })).toMatchObject({ decision: "REQUIRE_APPROVAL" });
    });

    it("performance never reaches ALWAYS_APPROVE or AUTONOMOUS Grants", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        for (const [autonomyState, decision] of [["ALWAYS_APPROVE", "REQUIRE_APPROVAL"], ["AUTONOMOUS", "ALLOW"]] as const) {
          for (const successRate of ["0", "1"]) {
            const result = await evaluatePolicy(tx, {
              grant: { agentDefinitionId, agentDefinitionVersion, capabilityId, permissions: ["READ"], maxTrustLevelRequired: 0, autonomyState },
              permission: "READ",
              proposedActionSnapshot: {},
              trustLevel: "first_party",
              bindingTrustLevel: 2,
              conditionalEvidence: evidence({ successRate }),
            });
            expect(result).toMatchObject({ decision, performanceEvidence: null });
          }
        }
      });
    });

    it("an autonomy state outside the three requires approval and is recorded as unrecognized, not as ALWAYS_APPROVE", async () => {
      await withRollback(async (tx) => {
        const { capabilityId, agentDefinitionId, agentDefinitionVersion } = await seedCapabilityAndAgent(tx, "low");
        const result = await evaluatePolicy(tx, {
          grant: { agentDefinitionId, agentDefinitionVersion, capabilityId, permissions: ["READ"], maxTrustLevelRequired: 0, autonomyState: "SOMETIMES" as CapabilityGrant["autonomyState"] },
          permission: "READ",
          proposedActionSnapshot: {},
          trustLevel: "first_party",
          bindingTrustLevel: 2,
        });
        expect(result).toMatchObject({ decision: "REQUIRE_APPROVAL", basis: "autonomy_state_unrecognized" });
      });
    });

    it("records the decided values on the rule constant", () => {
      expect(CONDITIONAL_AUTONOMY_RULE).toMatchObject({
        id: "conditional_autonomy_v1",
        allowAtOrAboveSuccessRate: 0.8,
        requireApprovalAtOrAboveSuccessRate: 0.6,
        autoAllowPermissions: ["READ"],
        autoAllowRiskTiers: ["low"],
      });
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
    // Everything from evaluatePolicy to the end of the file: its helpers (the Conditional
    // Autonomy rule's `conditionalDecision`) follow it, and a branch there is the same branch.
    const body = source.slice(startIndex);
    for (const permission of ["SPEND", "TRADE", "PUBLISH", "DELETE"]) {
      expect(body).not.toContain(`"${permission}"`);
    }
  });
});

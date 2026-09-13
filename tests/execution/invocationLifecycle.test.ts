import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mapTrustLevel,
  resolveCapabilityGrant,
  resolveToolBindingTrustLevel,
} from "../../src/execution/invocationLifecycle.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";

// Fix-round-1 (Important #4): mapTrustLevel had zero direct tests — only the
// `>= 2` (first_party) branch was ever exercised indirectly, via fixtures
// that happened to default trustLevel to 2. The fail-closed branch, which is
// the entire point of the design decision documented in
// invocationLifecycle.ts's module header, was completely unexercised.
describe("mapTrustLevel", () => {
  it("maps trustLevel >= 2 to first_party", () => {
    expect(mapTrustLevel(2)).toBe("first_party");
    expect(mapTrustLevel(3)).toBe("first_party");
    expect(mapTrustLevel(1000)).toBe("first_party");
  });

  it("maps trustLevel === 1 to verified_third_party", () => {
    expect(mapTrustLevel(1)).toBe("verified_third_party");
  });

  it("fails closed to unverified_third_party for trustLevel 0", () => {
    expect(mapTrustLevel(0)).toBe("unverified_third_party");
  });

  it("fails closed to unverified_third_party for negative trustLevel", () => {
    expect(mapTrustLevel(-1)).toBe("unverified_third_party");
    expect(mapTrustLevel(-1000)).toBe("unverified_third_party");
  });

  it("fails closed to unverified_third_party for non-finite input (NaN, Infinity, -Infinity)", () => {
    expect(mapTrustLevel(NaN)).toBe("unverified_third_party");
    // Infinity satisfies the ">= 2" comparison mathematically, but the
    // non-finite guard runs FIRST specifically so a malformed/unbounded value
    // never reads as the LEAST cautious category ("first_party") — proving
    // the fail-closed guard genuinely overrides what the numeric comparison
    // would otherwise produce, not just a case the comparison never reaches.
    expect(mapTrustLevel(Infinity)).toBe("unverified_third_party");
    expect(mapTrustLevel(-Infinity)).toBe("unverified_third_party");
  });
});

// ---------------------------------------------------------------------------
// Final-review Finding 2: both halves of the trust comparison must reach
// Policy, and both must come from their own DB rows — server-side, never from
// anything a model produced.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function seedGrantFixture(
  tx: DrizzleTransaction,
  opts: { maxTrustLevelRequired: number; trustLevel: number }
): Promise<{ runId: string; capabilityId: string; toolBindingId: string }> {
  const [capability] = await tx
    .insert(schema.capabilities)
    .values({ name: "cap-" + randomUUID(), staticRiskTag: "low" })
    .returning();
  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: opts.trustLevel, version: 1 })
    .returning();
  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "tester", objective: "test", instructions: "n/a" })
    .returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
    capabilityId: capability!.id,
    permissions: ["READ"],
    maxTrustLevelRequired: opts.maxTrustLevelRequired,
    autonomyState: "AUTONOMOUS",
  });
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: taskDefinition!.version,
      projectId: project!.id,
      status: "pending",
      input: {},
    })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({
      taskInstanceId: taskInstance!.id,
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      status: "active",
    })
    .returning();

  return { runId: run!.id, capabilityId: capability!.id, toolBindingId: toolBinding!.id };
}

describe("resolveCapabilityGrant — surfaces the Grant's declared trust bar", () => {
  it("carries max_trust_level_required through to the CapabilityGrant it returns (previously dropped)", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId } = await seedGrantFixture(tx, { maxTrustLevelRequired: 3, trustLevel: 1 });
      const grant = await resolveCapabilityGrant(tx, { runId, capabilityId, permission: "READ" });
      expect(grant).not.toBeNull();
      // The exact row value, not a default/placeholder: Policy's comparison is
      // only as trustworthy as the bar it is handed.
      expect(grant!.maxTrustLevelRequired).toBe(3);
    });
  });
});

describe("resolveToolBindingTrustLevel — one row read, two consistent projections", () => {
  it("returns the raw tool_bindings.trust_level alongside its category, both from the binding row", async () => {
    await withRollback(async (tx) => {
      const { toolBindingId } = await seedGrantFixture(tx, { maxTrustLevelRequired: 1, trustLevel: 0 });
      const resolved = await resolveToolBindingTrustLevel(tx, toolBindingId);
      expect(resolved).toEqual({ trustLevel: "unverified_third_party", bindingTrustLevel: 0 });
    });
  });

  it("the two projections always agree, because they are derived from a single read", async () => {
    await withRollback(async (tx) => {
      for (const [trustLevel, category] of [
        [0, "unverified_third_party"],
        [1, "verified_third_party"],
        [2, "first_party"],
        [7, "first_party"],
      ] as const) {
        const { toolBindingId } = await seedGrantFixture(tx, { maxTrustLevelRequired: 0, trustLevel });
        const resolved = await resolveToolBindingTrustLevel(tx, toolBindingId);
        expect(resolved.bindingTrustLevel).toBe(trustLevel);
        expect(resolved.trustLevel).toBe(category);
        expect(resolved.trustLevel).toBe(mapTrustLevel(resolved.bindingTrustLevel));
      }
    });
  });
});

/**
 * Tool Adapter registry (`src/capabilities/toolAdapters.ts`): a Tool
 * Invocation's code is selected by the Capability's persisted Tool Binding row,
 * never by the spec builder, and an unexecutable selection fails closed rather
 * than falling back to an older binding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { registerInternalToolFunction, resolveToolInvocation } from "../../src/capabilities/toolAdapters.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";
import { RESEARCH_RETRIEVE_SYNTHETIC } from "../../src/capabilities/researchRetrieve/adapter.js";
import { PUBLISH_REPORT_FILESYSTEM } from "../../src/capabilities/publishReport/adapter.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

registerInternalToolFunction("test.fixture.v1", {
  prepare: async (_tx, { proposedActionSnapshot }) => ({ inputs: { ...proposedActionSnapshot }, costClass: "metered_api", estimatedCost: 1 }),
  execute: async ({ config, inputs }) => ({ which: "v1", config, inputs }),
});
registerInternalToolFunction("test.fixture.v2", {
  prepare: async () => ({ inputs: {}, costClass: "local_retrieval", estimatedCost: 0 }),
  execute: async ({ config }) => ({ which: "v2", config }),
});

async function seedCapability(tx: DrizzleTransaction, name = "test.capability." + randomUUID()) {
  const [capability] = await tx.insert(schema.capabilities).values({ name, description: "fixture", staticRiskTag: "low" }).returning();
  return capability!;
}

async function seedBinding(
  tx: DrizzleTransaction,
  capabilityId: string,
  version: number,
  config: Record<string, unknown>,
  kind: "internal" | "direct_api" = "internal"
) {
  const [binding] = await tx.insert(schema.toolBindings).values({ capabilityId, kind, config, trustLevel: 2, version }).returning();
  return binding!;
}

const request = (capabilityName: string) => ({ capabilityName, permission: "READ" as const, proposedActionSnapshot: { q: "x" } });
const ctx = { invocationId: "inv", idempotencyKey: "run:r:seq:1" };

describe("resolveToolInvocation", () => {
  it("selects the highest-version binding and runs that binding's registered function with its config", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" });
      const newest = await seedBinding(tx, capability.id, 2, { function: "test.fixture.v2", region: "local" });

      const spec = await resolveToolInvocation(tx, request(capability.name));

      expect(spec).toMatchObject({
        kind: "tool",
        capabilityId: capability.id,
        toolBindingId: newest.id,
        costClass: "local_retrieval",
        estimatedCost: 0,
        permission: "READ",
        proposedActionSnapshot: { q: "x" },
      });
      await expect(spec.execute(ctx)).resolves.toEqual({ which: "v2", config: { function: "test.fixture.v2", region: "local" } });
    });
  });

  it("is deterministic: resolving again yields the same binding, cost and snapshot", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" });
      const { execute: _a, ...first } = await resolveToolInvocation(tx, request(capability.name));
      const { execute: _b, ...second } = await resolveToolInvocation(tx, request(capability.name));
      expect(second).toEqual(first);
    });
  });

  it("never falls back: a newest binding with an unregistered function fails closed even when an older one would run", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" });
      await seedBinding(tx, capability.id, 2, { function: "test.fixture.not-registered" });
      await expect(resolveToolInvocation(tx, request(capability.name))).rejects.toThrow(/not registered/);
    });
  });

  it("fails closed for a binding kind that has no adapter, and for a binding with no function", async () => {
    await withRollback(async (tx) => {
      const api = await seedCapability(tx);
      await seedBinding(tx, api.id, 1, { function: "test.fixture.v1" }, "direct_api");
      await expect(resolveToolInvocation(tx, request(api.name))).rejects.toThrow(/has no adapter/);

      const bare = await seedCapability(tx);
      await seedBinding(tx, bare.id, 1, {});
      await expect(resolveToolInvocation(tx, request(bare.name))).rejects.toThrow(/not registered/);
    });
  });

  it("fails closed for a missing capability, an ambiguous name, or a capability with no binding", async () => {
    await withRollback(async (tx) => {
      await expect(resolveToolInvocation(tx, request("test.capability.missing"))).rejects.toThrow(/found 0/);

      const name = "test.capability.dup." + randomUUID();
      const a = await seedCapability(tx, name);
      await seedCapability(tx, name);
      await seedBinding(tx, a.id, 1, { function: "test.fixture.v1" });
      await expect(resolveToolInvocation(tx, request(name))).rejects.toThrow(/found 2/);

      const unbound = await seedCapability(tx);
      await expect(resolveToolInvocation(tx, request(unbound.name))).rejects.toThrow(/no Tool Binding/);
    });
  });

  it("refuses to register a function name twice", () => {
    expect(() =>
      registerInternalToolFunction("test.fixture.v1", {
        prepare: async () => ({ inputs: {}, costClass: "metered_api", estimatedCost: 0 }),
        execute: async () => ({}),
      })
    ).toThrow(/already registered/);
  });

  it("the seeded bindings name their registered functions", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const research = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, seed.toolBindingId) });
      const publish = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, seed.publishToolBindingId) });
      expect(research?.config).toEqual({ function: RESEARCH_RETRIEVE_SYNTHETIC });
      expect(publish?.config).toEqual({ function: PUBLISH_REPORT_FILESYSTEM });

      const spec = await resolveToolInvocation(tx, {
        capabilityName: "research.retrieve",
        permission: "READ",
        proposedActionSnapshot: { query: "q" },
      });
      expect(spec).toMatchObject({ toolBindingId: seed.toolBindingId, costClass: "metered_api", estimatedCost: 0.01 });
    });
  });
});

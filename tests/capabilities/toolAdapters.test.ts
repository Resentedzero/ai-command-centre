/**
 * Tool Adapter registry (`src/capabilities/toolAdapters.ts`): a Tool
 * Invocation's code is selected by the Capability's persisted Tool Binding row,
 * never by the spec builder; an unexecutable selection fails closed rather than
 * falling back to an older binding; and a function only fulfils its own Capability.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const FIXTURE = "test.capability.fixture";

registerInternalToolFunction("test.fixture.v1", {
  capabilityName: FIXTURE,
  prepare: async (_tx, { proposedActionSnapshot }) => ({ inputs: { ...proposedActionSnapshot }, costClass: "metered_api", estimatedCost: 1 }),
  execute: async ({ config, inputs }) => ({ which: "v1", config, inputs }),
});
registerInternalToolFunction("test.fixture.v2", {
  capabilityName: FIXTURE,
  prepare: async () => ({ inputs: {}, costClass: "local_retrieval", estimatedCost: 0 }),
  execute: async ({ config }) => ({ which: "v2", config }),
});
registerInternalToolFunction("test.fixture.other-capability", {
  capabilityName: "test.capability.someone-else",
  prepare: async () => ({ inputs: {}, costClass: "external_side_effect", estimatedCost: 0 }),
  execute: async () => ({ effect: "performed" }),
});

async function seedCapability(tx: DrizzleTransaction, name = FIXTURE) {
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

const request = (capabilityName = FIXTURE) => ({ capabilityName, permission: "READ" as const, proposedActionSnapshot: { q: "x" } });
const ctx = { invocationId: "inv", idempotencyKey: "run:r:seq:1" };

describe("resolveToolInvocation", () => {
  it("selects the highest-version binding and runs that binding's registered function with its config", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" });
      const newest = await seedBinding(tx, capability.id, 2, { function: "test.fixture.v2", region: "local" });

      const spec = await resolveToolInvocation(tx, request());

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
      const { execute: _a, ...first } = await resolveToolInvocation(tx, request());
      const { execute: _b, ...second } = await resolveToolInvocation(tx, request());
      expect(second).toEqual(first);
    });
  });

  it("never falls back: a newest binding with an unregistered function fails closed even when an older one would run", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" });
      await seedBinding(tx, capability.id, 2, { function: "test.fixture.not-registered" });
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/not registered/);
    });
  });

  it("fails closed for a binding kind that has no adapter", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.v1" }, "direct_api");
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/has no adapter/);
    });
  });

  it("fails closed for a binding with no function", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, {});
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/not registered/);
    });
  });

  it("a binding cannot borrow another Capability's function: it fails closed", async () => {
    await withRollback(async (tx) => {
      const capability = await seedCapability(tx);
      await seedBinding(tx, capability.id, 1, { function: "test.fixture.other-capability" });
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/belongs to capability "test\.capability\.someone-else"/);
    });
  });

  it("fails closed for a missing capability, an ambiguous name, or a capability with no binding", async () => {
    await withRollback(async (tx) => {
      await expect(resolveToolInvocation(tx, request("test.capability.missing"))).rejects.toThrow(/found 0/);
    });
    await withRollback(async (tx) => {
      const a = await seedCapability(tx);
      await seedCapability(tx);
      await seedBinding(tx, a.id, 1, { function: "test.fixture.v1" });
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/found 2/);
    });
    await withRollback(async (tx) => {
      await seedCapability(tx);
      await expect(resolveToolInvocation(tx, request())).rejects.toThrow(/no Tool Binding/);
    });
  });

  it("refuses to register a function name twice", () => {
    expect(() =>
      registerInternalToolFunction("test.fixture.v1", {
        capabilityName: FIXTURE,
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

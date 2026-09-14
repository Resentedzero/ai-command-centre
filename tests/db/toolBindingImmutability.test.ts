/**
 * Migration 0013: a Tool Binding row cannot change what it runs or which Capability
 * and version it is (a change is a new, higher version), and a Capability has at
 * most one binding per version. `trust_level` stays updatable: it is re-read before
 * every effect, so lowering it must take effect immediately.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function binding(tx: DrizzleTransaction) {
  const [capability] = await tx.insert(schema.capabilities).values({ name: "immutability", description: "d", staticRiskTag: "low" }).returning();
  const [row] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: { function: "a" }, trustLevel: 2, version: 1 })
    .returning();
  return row!;
}

/** Runs `change` in a savepoint and returns the database error message it raised, if any. */
async function refusal(tx: DrizzleTransaction, change: (sp: DrizzleTransaction) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await change(sp);
    });
    return null;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
}

describe("tool_bindings immutability", () => {
  it("refuses changes to config, kind, version or capability, and allows a trust level change", async () => {
    await withRollback(async (tx) => {
      const row = await binding(tx);
      const [other] = await tx.insert(schema.capabilities).values({ name: "other", description: "d", staticRiskTag: "low" }).returning();
      const where = eq(schema.toolBindings.id, row.id);

      for (const change of [
        { config: { function: "b" } },
        { kind: "direct_api" as const },
        { version: 2 },
        { capabilityId: other!.id },
      ]) {
        expect(await refusal(tx, (sp) => sp.update(schema.toolBindings).set(change).where(where))).toMatch(/tool_bindings rows are immutable/);
      }

      expect(await refusal(tx, (sp) => sp.update(schema.toolBindings).set({ trustLevel: 0 }).where(where))).toBeNull();
      expect((await tx.query.toolBindings.findFirst({ where }))).toMatchObject({ trustLevel: 0, config: { function: "a" }, version: 1 });
    });
  });

  it("refuses a second binding with the same version for one Capability", async () => {
    await withRollback(async (tx) => {
      const row = await binding(tx);
      const duplicate = await refusal(tx, (sp) =>
        sp.insert(schema.toolBindings).values({ capabilityId: row.capabilityId, kind: "internal", config: { function: "c" }, trustLevel: 2, version: 1 })
      );
      expect(duplicate).toMatch(/tool_bindings_capability_version_unique/);
    });
  });
});

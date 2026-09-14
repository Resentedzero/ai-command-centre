/**
 * Migration 0011 names the registered internal function on seeded Tool Bindings
 * that predate the adapter registry (`config = {}`). The test database is
 * migrated empty, so the migration's statements are replayed here against such
 * rows, inside a rolled-back transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const statements = readFileSync(
  fileURLToPath(new URL("../../drizzle/0011_tool_binding_adapter_functions.sql", import.meta.url)),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function bindingFor(tx: DrizzleTransaction, name: string, config: Record<string, unknown> | null, kind: "internal" | "direct_api" = "internal") {
  const [capability] = await tx.insert(schema.capabilities).values({ name, description: "d", staticRiskTag: "low" }).returning();
  const [binding] = await tx.insert(schema.toolBindings).values({ capabilityId: capability!.id, kind, config, trustLevel: 2, version: 1 }).returning();
  return binding!;
}

describe("migration 0011: tool binding adapter functions", () => {
  it("names the function on pre-registry seeded bindings, and leaves configured or non-internal rows alone", async () => {
    await withRollback(async (tx) => {
      // Pre-registry databases predate migration 0014; drop its index inside the rolled-back transaction.
      await tx.execute(sql.raw('DROP INDEX "capabilities_name_unique"'));
      const research = await bindingFor(tx, "research.retrieve", {});
      const publish = await bindingFor(tx, "publish.report", null);
      const configured = await bindingFor(tx, "research.retrieve", { function: "something.else" });
      const external = await bindingFor(tx, "publish.report", {}, "direct_api");

      expect(statements).toHaveLength(2);
      // 0011 ran before 0013 made binding rows immutable; replay it as it ran.
      await tx.execute(sql.raw('ALTER TABLE "tool_bindings" DISABLE TRIGGER "tool_bindings_immutable"'));
      for (const statement of statements) await tx.execute(sql.raw(statement));

      const config = async (id: string) =>
        (await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, id) }))?.config;
      expect(await config(research.id)).toEqual({ function: "research.retrieve.synthetic" });
      expect(await config(publish.id)).toEqual({ function: "publish.report.filesystem" });
      expect(await config(configured.id)).toEqual({ function: "something.else" });
      expect(await config(external.id)).toEqual({});
    });
  });
});

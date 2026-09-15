/**
 * Migration 0019 (operator decision R-ART1): Artifacts are immutable. The database refuses
 * UPDATE, DELETE and TRUNCATE on `artifacts`, so a pinned hash (spec §9.5) and a compiled
 * context's recorded artifact version and hash (§5.13) always describe the bytes stored. A
 * new version is a new row; inserting still works.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, resetTestSchema, rewriteArtifactForTest, testDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function anArtifact(tx: DrizzleTransaction, version = 1) {
  const [row] = await tx
    .insert(schema.artifacts)
    .values({ type: "report", version, hash: `hash-v${version}`, size: 8, inlineContent: `original-v${version}` })
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

describe("artifacts are immutable", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and leaves the row as written", async () => {
    await withRollback(async (tx) => {
      const artifact = await anArtifact(tx);
      const where = eq(schema.artifacts.id, artifact.id);

      expect(await refusal(tx, (sp) => sp.update(schema.artifacts).set({ inlineContent: "rewritten" }).where(where))).toMatch(/artifacts are immutable/);
      expect(await refusal(tx, (sp) => sp.update(schema.artifacts).set({ version: 2 }).where(where))).toMatch(/artifacts are immutable/);
      expect(await refusal(tx, (sp) => sp.update(schema.artifacts).set({ summary: "added later" }).where(where))).toMatch(/artifacts are immutable/);
      expect(await refusal(tx, (sp) => sp.delete(schema.artifacts).where(where))).toMatch(/artifacts are immutable/);
      expect(await refusal(tx, (sp) => sp.execute(sql.raw('TRUNCATE "artifacts" CASCADE')))).toMatch(/artifacts are immutable/);

      expect(await tx.query.artifacts.findFirst({ where })).toMatchObject({ version: 1, hash: "hash-v1", inlineContent: "original-v1", summary: null });
    });
  });

  it("a new version is a new row, and the earlier version is untouched", async () => {
    await withRollback(async (tx) => {
      const v1 = await anArtifact(tx, 1);
      const v2 = await anArtifact(tx, 2);
      expect(v2.id).not.toBe(v1.id);
      expect(await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, v1.id) })).toMatchObject({ version: 1, inlineContent: "original-v1" });
    });
  });

  it("test tampering can still rewrite a committed artifact, and the guard is back afterwards", async () => {
    const artifact = await testDb.transaction((tx) => anArtifact(tx));
    await rewriteArtifactForTest(artifact.id, "tampered");
    expect(await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.id, artifact.id) })).toMatchObject({ inlineContent: "tampered" });

    await withRollback(async (tx) => {
      expect(await refusal(tx, (sp) => sp.update(schema.artifacts).set({ inlineContent: "again" }).where(eq(schema.artifacts.id, artifact.id)))).toMatch(/artifacts are immutable/);
    });
  });
});

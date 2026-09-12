import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "./testDb.js";
import { projects } from "../src/db/schema.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("rollback-per-test isolation", () => {
  it("test A writes a row inside withRollback", async () => {
    await withRollback(async (tx) => {
      await tx.insert(projects).values({ name: "should-not-survive" });
      const rows = await tx.select().from(projects);
      // Visible inside the still-open transaction...
      expect(rows).toHaveLength(1);
    });

    // ...but gone once the transaction has rolled back, checked via a
    // completely separate connection/query outside any transaction.
    const rowsOutside = await testDb.select().from(projects);
    expect(rowsOutside).toHaveLength(0);
  });

  it("test B sees zero rows, proving test A left no residue", async () => {
    const rowsAtStart = await testDb.select().from(projects);
    expect(rowsAtStart).toHaveLength(0);

    await withRollback(async (tx) => {
      const rows = await tx.select().from(projects);
      expect(rows).toHaveLength(0);
    });
  });
});

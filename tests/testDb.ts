/**
 * Deterministic local test-database strategy (no Docker/Redis — a second
 * database on the same native Postgres instance).
 *
 * - `resetTestSchema()` drops and recreates the `public` schema on
 *   `TEST_DATABASE_URL`, then applies all Drizzle migrations. Intended to run
 *   once per test file (Vitest `beforeAll`), not per test.
 * - `withRollback()` runs a callback inside a transaction that is always
 *   rolled back afterwards, giving each test full isolation without the cost
 *   of truncating tables between tests.
 */
import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { TransactionRollbackError, sql, type SQL } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { DrizzleTransaction } from "../src/events/emit.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const connectionString = requireEnv("TEST_DATABASE_URL");

// Sanity guard: this strategy runs DROP SCHEMA against whatever
// TEST_DATABASE_URL points at, so refuse to run against anything that looks
// like the dev database.
if (/ai_command_centre$/i.test(connectionString.split("?")[0]!.trim())) {
  throw new Error(
    "TEST_DATABASE_URL appears to point at the development database. Refusing to run (resetTestSchema drops the public schema)."
  );
}

export const testPool = new Pool({ connectionString });
export const testDb = drizzle(testPool, { schema });

/**
 * Drops and recreates the `public` schema, then applies every migration in
 * `drizzle/`. Run once per test file, in `beforeAll`.
 */
export async function resetTestSchema(): Promise<void> {
  // Drizzle's own migration-tracking table lives in a separate `drizzle`
  // schema, so it must be dropped alongside `public` — otherwise a fresh
  // `public` schema still has old migration hashes recorded as "already
  // applied" and migrate() silently no-ops, leaving no tables at all.
  await testPool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await testPool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await testPool.query("CREATE SCHEMA public");
  await migrate(testDb, { migrationsFolder: "./drizzle" });
}

/**
 * Deletes events a real-transaction test COMMITTED, so they do not leak into later
 * tests. The events table refuses UPDATE, DELETE and TRUNCATE (migration 0016, spec
 * §3e/§8.7); only test cleanup lifts that, inside one transaction, so the guard is
 * back before anything else can write.
 */
export async function deleteEventsForTest(where: SQL | undefined): Promise<void> {
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw('ALTER TABLE "events" DISABLE TRIGGER "events_immutable"'));
    await tx.delete(schema.events).where(where);
    await tx.execute(sql.raw('ALTER TABLE "events" ENABLE TRIGGER "events_immutable"'));
  });
}

/**
 * Rewrites a committed Artifact's inline content, for tests that simulate tampering.
 * Artifacts refuse UPDATE (migration 0019); only test code lifts that, inside one
 * transaction, so the guard is back before anything else can write.
 */
export async function rewriteArtifactForTest(id: string, inlineContent: string | null): Promise<void> {
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw('ALTER TABLE "artifacts" DISABLE TRIGGER "artifacts_immutable"'));
    await tx.update(schema.artifacts).set({ inlineContent }).where(sql`${schema.artifacts.id} = ${id}`);
    await tx.execute(sql.raw('ALTER TABLE "artifacts" ENABLE TRIGGER "artifacts_immutable"'));
  });
}

export async function closeTestDb(): Promise<void> {
  await testPool.end();
}

/**
 * Runs `fn` inside a transaction against the test database, then always
 * rolls the transaction back via Drizzle's `tx.rollback()` — regardless of
 * whether `fn` succeeds — so no row it wrote is ever visible outside the
 * call, including to later tests.
 */
export async function withRollback<T>(
  fn: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  let result: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      result = await fn(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
  return result as T;
}

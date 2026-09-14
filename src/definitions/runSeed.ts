/**
 * `npm run seed` — Unit 10, Ruling 1 (task-10-brief.md): a real, idempotent
 * seed-runner entrypoint against the REAL app database (`../db/client.js`,
 * `DATABASE_URL` — never the test database), committing a real transaction.
 * Mirrors `../db/migrate.ts`'s own script-entrypoint shape (plain top-level
 * `main().catch(...)`, `tsx`-run, never imported elsewhere).
 *
 * Idempotency: `seedPublishWorkflow`/`seedResearchWorkflow` have no "already
 * exists" check of their own; they create through the Registry, so calling
 * either twice fails with a 409 `RegistryWriteError` (names and versions are
 * unique). This script adds that check itself, wrapping the call: before seeding, it looks
 * up whether the "Research-and-Publish" Workflow Definition (a known, stable
 * name) already exists via `findSeededPublishWorkflow` (`./lookupSeed.js`) —
 * the SAME lookup the API routes use at request time to find the seeded ids.
 * If found, this script is a no-op; otherwise it calls `seedPublishWorkflow`
 * inside a transaction that actually commits (unlike the test suite's
 * `withRollback`, which only ever ROLLS BACK).
 */
import "dotenv/config";
import { db, pool } from "../db/client.js";
import { seedPublishWorkflow } from "./seed.js";
import { findSeededPublishWorkflow } from "./lookupSeed.js";

export async function runSeed(): Promise<{ seeded: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await findSeededPublishWorkflow(tx);
    if (existing) {
      return { seeded: false };
    }
    await seedPublishWorkflow(tx);
    return { seeded: true };
  });
}

async function main() {
  const result = await runSeed();
  // eslint-disable-next-line no-console
  console.log(result.seeded ? "Seed data created." : "Seed data already present — no changes made (idempotent).");
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

/**
 * `npm run seed` — Unit 10, Ruling 1 (task-10-brief.md): a real, idempotent
 * seed-runner entrypoint against the REAL app database (`../db/client.js`,
 * `DATABASE_URL` — never the test database), committing a real transaction.
 * Mirrors `../db/migrate.ts`'s own script-entrypoint shape (plain top-level
 * `main().catch(...)`, `tsx`-run, never imported elsewhere).
 *
 * Idempotency: `seedPublishWorkflow`/`seedResearchReportWorkflow` have no "already
 * exists" check of their own; they create through the Registry, so calling
 * either twice fails with a 409 `RegistryWriteError` (names and versions are
 * unique). `seedMissingWorkflows` (`./seed.ts`) checks each workflow by its own
 * lookup and seeds only what is missing, inside a transaction that actually
 * commits (unlike the test suite's `withRollback`, which only ever ROLLS BACK).
 * Research-and-Publish is found by `findSeededPublishWorkflow` — the SAME lookup
 * the API routes use — and a database seeded before Workflow 1
 * ("Research-Report") existed gains it on the next run.
 */
import "dotenv/config";
import { db, pool } from "../db/client.js";
import { seedMissingWorkflows } from "./seed.js";

export async function runSeed(): Promise<{ seeded: boolean }> {
  return db.transaction(async (tx) => {
    const { seededPublish, seededResearchReport } = await seedMissingWorkflows(tx);
    return { seeded: seededPublish || seededResearchReport };
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

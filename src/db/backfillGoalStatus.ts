/**
 * One-time Goal status backfill (R-GOAL1, CLI2 QA finding M1) against the database
 * identified by `DATABASE_URL`. Run via `npm run db:backfill-goal-status`. Safe to
 * re-run: a second run changes nothing. See `backfillGoalStatuses` in
 * `../workflow/interpreter.ts`.
 */
import { db, pool } from "./client.js";
import { backfillGoalStatuses } from "../workflow/interpreter.js";

async function main() {
  const changed = await db.transaction((tx) => backfillGoalStatuses(tx));
  await pool.end();
  // eslint-disable-next-line no-console
  console.log(`Goal status backfill: ${changed.length} Goal(s) updated${changed.length > 0 ? `: ${changed.join(", ")}` : ""}.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

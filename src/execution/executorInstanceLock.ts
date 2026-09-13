/**
 * `acquireExecutorInstanceLock` — guarantees ONE executing process per database
 * (Phase 9).
 *
 * The spec already runs the backend as a single process (§13.2). Durable
 * execution turns that from an assumption into a load-bearing invariant:
 * `executeRun` decides that an `executing` Invocation is interrupted (and
 * settles it) when THIS process is not dispatching it. With two processes
 * against one database, the second would wrongly settle the first's live
 * dispatches. This lock makes that configuration fail at startup instead.
 *
 * A session-level advisory lock on a dedicated connection held for the life of
 * the process: Postgres releases it automatically if the process dies, so a
 * crash never leaves a stale lock behind to block the restart.
 *
 * Two-integer key form, deliberately: `emitEvent` takes single-bigint
 * `pg_advisory_xact_lock(hashtext(runId))` locks, and the two forms occupy
 * separate key spaces, so this can never collide with a Run's event lock.
 */
import type { Pool, PoolClient } from "pg";

const LOCK_CLASS_ID = 20260912; // the spec's date: a namespace for this application's locks
const EXECUTOR_INSTANCE_OBJECT_ID = 1;

export async function acquireExecutorInstanceLock(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::int, $2::int) as acquired",
      [LOCK_CLASS_ID, EXECUTOR_INSTANCE_OBJECT_ID]
    );
    if (!rows[0]?.acquired) {
      throw new Error(
        "Another AI Command Centre process already holds the executor instance lock for this database. " +
          "Only one process may execute Runs at a time (durable execution depends on it); refusing to start."
      );
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

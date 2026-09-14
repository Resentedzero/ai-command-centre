/**
 * Live-event relay — the ONLY caller of `./eventBus.js`'s `publishLiveEvent`.
 * See `eventBus.ts`'s header for why delivery is in-process and relay-driven
 * rather than LISTEN/NOTIFY or a poller.
 *
 * ---------------------------------------------------------------------------
 * Relay AFTER EVERY COMMIT (Phase 9 follow-up, 2026-09-14)
 * ---------------------------------------------------------------------------
 * A workflow request commits in many short transactions, and the gap between
 * two of them can be a multi-minute provider call. Relaying only when the whole
 * request finished meant the Activity feed showed nothing for exactly the time
 * an operator is watching. `createWorkflowRelay` returns a `TransactionRunner`
 * that commits and THEN relays whatever that commit added for the tracked
 * Workflow Runs, so each event reaches live subscribers as soon as it is durable.
 *
 * Correctness/ordering: publishing happens only after `db.transaction` has
 * resolved, so a subscriber never sees an event Postgres does not durably hold.
 * A failure in the relay itself is logged, never thrown — the mutation already
 * committed — and ends every open stream (`signalLiveDeliveryGap`), so each
 * client reconnects and replays from the highest cursor it received. That
 * recovers the unpublished events unless the client already holds a higher
 * cursor from a concurrent commit; then a page reload (cursor 0) or a projection
 * query shows them (ROADMAP_STATUS §5a, the SSE cursor residual).
 *
 * ---------------------------------------------------------------------------
 * Why per-run watermarks (and why they cannot skip an event)
 * ---------------------------------------------------------------------------
 * `sequenceNo` is monotonic per `runId` (Phase 8.1) and allocated under that
 * Run's transaction-scoped advisory lock (`emitEvent`), which is held until
 * COMMIT. Two transactions writing the same Run's events therefore commit in
 * sequence order: once a watermark has passed sequence N for a Run, no
 * uncommitted event with a lower number for that Run can appear later. A
 * single global cursor has no such guarantee (`global_seq` is assigned at
 * insert, not commit), which is why it is used only for client replay.
 *
 * Events with no Run (`goal_created`, `workflow_run_started`) share the
 * null-run sequence, serialized by the same lock mechanism, and are matched to
 * the tracked Workflow Run by its id or its Goal.
 *
 * Every Run under a tracked Workflow Run is re-enumerated on each flush, so a
 * step's Run created mid-request is picked up with no special case.
 * Concurrent requests on one Workflow Run may relay the same event twice; the
 * SSE route deduplicates by event id per connection.
 */
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { events, runs, taskInstances, workflowRuns } from "../db/schema.js";
import type { Database } from "../db/client.js";
import type { TransactionRunner } from "../db/transactionRunner.js";
import { publishLiveEvent, signalLiveDeliveryGap } from "./eventBus.js";
import { rowToEventEnvelope } from "./eventEnvelopeRow.js";

type Tracked = { goalId: string | null; runSeq: Map<string, number>; nullSeq: number };

async function maxSeq(db: Database, runId: string): Promise<number> {
  const [top] = await db
    .select({ seq: events.sequenceNo })
    .from(events)
    .where(eq(events.runId, runId))
    .orderBy(desc(events.sequenceNo))
    .limit(1);
  return top?.seq ?? 0;
}

function nullRunEventsFor(workflowRunId: string, goalId: string | null) {
  const matchesWorkflow = eq(events.workflowRunId, workflowRunId);
  return and(
    isNull(events.runId),
    goalId ? or(matchesWorkflow, and(isNull(events.workflowRunId), eq(events.goalId, goalId))) : matchesWorkflow
  );
}

async function runsUnder(db: Database, workflowRunId: string): Promise<string[]> {
  const rows = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(taskInstances, eq(runs.taskInstanceId, taskInstances.id))
    .where(eq(taskInstances.workflowRunId, workflowRunId));
  return rows.map((r) => r.runId);
}

export type WorkflowRelay = {
  /** Commits `fn`, then relays every event that commit added for the tracked Workflow Runs. */
  runInTx: TransactionRunner;
  /**
   * Starts relaying a Workflow Run. `fresh: true` for one this request just
   * created — nothing of it can have been seen yet, so everything is new.
   * Otherwise current positions are recorded, and only later events relay.
   */
  track(workflowRunId: string, opts?: { fresh?: boolean }): Promise<void>;
  /** Relays anything committed since the last flush. Never throws. */
  flush(): Promise<void>;
};

export function createWorkflowRelay(db: Database): WorkflowRelay {
  const tracked = new Map<string, Tracked>();

  async function track(workflowRunId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    // Never throws, like `flush`: it can run AFTER a mutation committed (e.g.
    // POST /goals tracks the Workflow Run it just created), and a relay problem
    // must never turn a committed mutation into a failed request. On failure it
    // falls back to relaying from the start — subscribers already holding those
    // events are protected by the SSE route's per-connection de-dup.
    try {
      const workflowRun = await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
      const goalId = workflowRun?.goalId ?? null;
      const state: Tracked = { goalId, runSeq: new Map(), nullSeq: 0 };
      if (!opts.fresh) {
        for (const runId of await runsUnder(db, workflowRunId)) {
          state.runSeq.set(runId, await maxSeq(db, runId));
        }
        const [top] = await db
          .select({ seq: events.sequenceNo })
          .from(events)
          .where(nullRunEventsFor(workflowRunId, goalId))
          .orderBy(desc(events.sequenceNo))
          .limit(1);
        state.nullSeq = top?.seq ?? 0;
      }
      tracked.set(workflowRunId, state);
    } catch (err) {
      tracked.set(workflowRunId, { goalId: null, runSeq: new Map(), nullSeq: 0 });
      // eslint-disable-next-line no-console
      console.error("liveEventRelay: could not record relay positions; relaying this Workflow Run from its start.", err);
    }
  }

  async function flush(): Promise<void> {
    try {
      for (const [workflowRunId, state] of tracked) {
        const nullRows = await db.query.events.findMany({
          where: and(nullRunEventsFor(workflowRunId, state.goalId), gt(events.sequenceNo, state.nullSeq)),
          orderBy: asc(events.sequenceNo),
        });
        for (const row of nullRows) {
          publishLiveEvent(rowToEventEnvelope(row));
          state.nullSeq = row.sequenceNo;
        }

        for (const runId of await runsUnder(db, workflowRunId)) {
          const since = state.runSeq.get(runId) ?? 0;
          const rows = await db.query.events.findMany({
            where: and(eq(events.runId, runId), gt(events.sequenceNo, since)),
            orderBy: asc(events.sequenceNo),
          });
          for (const row of rows) {
            publishLiveEvent(rowToEventEnvelope(row));
            state.runSeq.set(runId, row.sequenceNo);
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "liveEventRelay: post-commit relay failed. The mutation itself committed and its events are in Postgres; " +
          "open event streams are ended so their clients replay them.",
        err
      );
      signalLiveDeliveryGap();
    }
  }

  const runInTx: TransactionRunner = async (fn) => {
    const result = await db.transaction(fn);
    await flush();
    return result;
  };

  return { runInTx, track, flush };
}

/**
 * Publishes one already-committed event, looked up by its idempotency key —
 * for control-plane routes (emergency stops) whose audit events belong to no
 * Workflow Run. Never throws, for the same reason as `flush`.
 */
export async function relayCommittedEvent(db: Database, idempotencyKey: string): Promise<void> {
  try {
    const row = await db.query.events.findFirst({ where: eq(events.idempotencyKey, idempotencyKey) });
    if (row) publishLiveEvent(rowToEventEnvelope(row));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("liveEventRelay: failed to relay a committed event; ending open streams so clients replay it.", err);
    signalLiveDeliveryGap();
  }
}

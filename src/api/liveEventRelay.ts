/**
 * `runWorkflowMutationAndRelay` — the ONLY caller of `./eventBus.js`'s
 * `publishLiveEvent` in the whole codebase. See `eventBus.ts`'s header for
 * the full design writeup of WHY this is the right place; this header
 * covers HOW.
 *
 * Why scoped by `runId`, never by `workflowRunId` or a global counter:
 *   - Every `emitEvent` call site reachable from `advanceWorkflowRun`
 *     (`../execution/invocationLifecycle.ts`'s `proposeInvocation` /
 *     `completeInvocation` / `failInvocation`, and
 *     `../router/modelRouter.ts`'s two call sites) hard-codes
 *     `correlation.workflowRunId: null` and always passes a real, non-null
 *     `correlation.runId` — verified directly against their current source.
 *     So `workflowRunId` cannot be used as an `events` query key at all, and
 *     `runId` always can be.
 *   - `sequenceNo` (`../events/types.ts`) is documented as "monotonic,
 *     scoped per runId" — `../events/emit.ts`'s own `emitEvent` computes it
 *     via `max(sequenceNo) where runId = X`. Two different Runs' events can
 *     therefore legitimately share the same `sequenceNo` (both start at 1).
 *     A single global watermark ("have any events past sequenceNo N been
 *     created since I looked?") would silently miss an entire new Run's
 *     events whenever its `sequenceNo`s happen to be <= the last global
 *     value observed — scoping per-`runId` is the only sound choice.
 *
 * Scoped per-WORKFLOW-RUN (enumerate every `runs` row under it), NOT per a
 * single known `runs` row — deliberately, and this is load-bearing, not
 * incidental. A single `advanceWorkflowRun` call (Unit 7, frozen) does
 * touch exactly one `runs` row per call ("do NOT create the next step's Task
 * Instance within this same call — a subsequent advanceWorkflowRun call
 * does that", interpreter.ts's own module header) — but since Unit 10's
 * Ruling 3 fix round 1 (`../workflow/advanceWorkflowRunUntilBlocked.ts`), a
 * single mutating REQUEST now loops that call up to the Workflow Run's own
 * step count, so ONE request (e.g. one `POST /goals`) can create and
 * complete Task A's run AND create Task B's run, both within the same
 * `db.transaction(action)` call this module wraps. Enumerating "every run
 * under this Workflow Run" both before and after — rather than tracking one
 * specific `runId` the caller already knows about — is what makes this
 * correct for that multi-run-per-request case without any change to this
 * module's own code when the loop's bound changes. DO NOT "simplify" this
 * to a single known run — that would silently stop relaying Task B's (or
 * any later step's) live events the moment a request advances more than one
 * step.
 *
 * Why scoped by `runId` at the query level, never by `workflowRunId` or a
 * global counter (see above): `sequenceNo` is monotonic only per-`runId`, so
 * each run's watermark is tracked and diffed independently; the
 * per-workflow-run ENUMERATION above just decides which `runId`s to check.
 *
 * Correctness/ordering guarantee: `publishLiveEvent` is only ever called
 * AFTER `db.transaction(action)` has already resolved (i.e. committed) —
 * never from inside the transaction, and never on a transaction that threw
 * (an uncaught throw from `action` propagates out of `db.transaction`
 * itself, so the "after" diff / relay never runs). A live subscriber can
 * therefore never observe an Event that Postgres does not durably have; the
 * worst failure mode is an event arriving late (on the next SSE reconnect's
 * replay) — never an event silently lost, which is exactly what
 * `eventBus.ts`'s "live delivery only, never a source of truth" contract
 * requires.
 *
 * That contract also means a failure IN this post-commit relay step itself
 * (fix round 2, Important #1) must never surface as a failure of the
 * mutation it's attached to — the mutation already committed. See the
 * try/catch around the enumeration/publish loop below: any error there is
 * logged and swallowed, and the caller still gets back the successful
 * `result`. The affected events are not lost — Postgres already has them
 * durably, and the next SSE reconnect's replay (`../routes/events.ts`)
 * picks them up from there; only the LIVE delivery of them was delayed.
 */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { events, runs, taskInstances } from "../db/schema.js";
import type { Database } from "../db/client.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { publishLiveEvent } from "./eventBus.js";
import { rowToEventEnvelope } from "./eventEnvelopeRow.js";

type RunWatermarks = Map<string, number>;

/** Every `runs` row currently under `workflowRunId`, mapped to its current max `sequenceNo` (0 if it has none yet). */
async function captureRunSequenceWatermarks(db: Database, workflowRunId: string): Promise<RunWatermarks> {
  const runRows = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(taskInstances, eq(runs.taskInstanceId, taskInstances.id))
    .where(eq(taskInstances.workflowRunId, workflowRunId));

  const watermarks: RunWatermarks = new Map();
  for (const { runId } of runRows) {
    const [top] = await db
      .select({ seq: events.sequenceNo })
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(desc(events.sequenceNo))
      .limit(1);
    watermarks.set(runId, top?.seq ?? 0);
  }
  return watermarks;
}

/**
 * Runs `action` inside a real, committing transaction, then relays every
 * Event it created to live SSE subscribers via `publishLiveEvent`, in
 * ascending `sequenceNo` order per run.
 *
 * `beforeWorkflowRunId` is the Workflow Run's id BEFORE the transaction
 * runs. Pass `null` when the transaction itself creates a brand new
 * Workflow Run (`POST /goals`) — "before" is then correctly empty (no run
 * can possibly exist yet for a Workflow Run that doesn't exist yet), so
 * every event the new run produces is treated as new, with no special-case
 * branch required. `action` must return an object carrying the (possibly
 * newly created) `workflowRunId` so the "after" snapshot knows what to look
 * at.
 */
export async function runWorkflowMutationAndRelay<T extends { workflowRunId: string }>(
  db: Database,
  beforeWorkflowRunId: string | null,
  action: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  const before = beforeWorkflowRunId ? await captureRunSequenceWatermarks(db, beforeWorkflowRunId) : new Map<string, number>();

  const result = await db.transaction(action);

  // Fix round 2, Important #1: the mutation above has ALREADY COMMITTED —
  // nothing below this point may cause the caller to see a failure for a
  // request that actually succeeded. Any error here is logged and
  // swallowed, never rethrown; `result` is still returned. See this
  // module's header for why nothing is lost even when this step fails (the
  // events are already durable in Postgres; only their LIVE delivery is
  // delayed until the next SSE reconnect's replay).
  try {
    const runRowsAfter = await db
      .select({ runId: runs.id })
      .from(runs)
      .innerJoin(taskInstances, eq(runs.taskInstanceId, taskInstances.id))
      .where(eq(taskInstances.workflowRunId, result.workflowRunId));

    for (const { runId } of runRowsAfter) {
      const priorMax = before.get(runId) ?? 0;
      const newRows = await db.query.events.findMany({
        where: and(eq(events.runId, runId), gt(events.sequenceNo, priorMax)),
        orderBy: asc(events.sequenceNo),
      });
      for (const row of newRows) {
        publishLiveEvent(rowToEventEnvelope(row));
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "runWorkflowMutationAndRelay: post-commit live-event relay failed (the mutation itself already committed " +
        "successfully — this failure does not affect that outcome). Affected live subscribers will still receive " +
        "these events via Postgres replay on their next SSE reconnect.",
      err
    );
  }

  return result;
}

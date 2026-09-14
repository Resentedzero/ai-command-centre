/**
 * `emitEvent` — the single primitive for appending to the Event table
 * (Phase 3e/8.1). Every other module writes events through this function,
 * never via a raw insert, so idempotency and per-run sequencing stay
 * centralized.
 */
import { eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { events } from "../db/schema.js";
import * as schema from "../db/schema.js";
import { isResourceUnit } from "../governance/resourceUnit.js";
import type { EventEnvelope } from "./types.js";

// Derived (not hand-written) so it always matches the schema actually wired
// into the app's Drizzle instance — a schema-typed transaction handle, with
// `.query.<table>` relational access available.
type SchemaDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTransaction = Parameters<Parameters<SchemaDatabase["transaction"]>[0]>[0];

export type EmitEventInput = Omit<EventEnvelope, "eventId" | "occurredAt" | "sequenceNo">;

function rowToEnvelope(row: typeof events.$inferSelect): EventEnvelope {
  const hasUsage =
    row.tokensIn !== null ||
    row.tokensOut !== null ||
    row.cacheHit !== null ||
    row.costAmount !== null ||
    row.modelId !== null;

  return {
    eventId: row.id,
    idempotencyKey: row.idempotencyKey,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    occurredAt: row.occurredAt,
    sequenceNo: row.sequenceNo,
    causationId: row.causationId,
    correlation: {
      goalId: row.goalId,
      workflowRunId: row.workflowRunId,
      taskInstanceId: row.taskInstanceId,
      runId: row.runId,
      invocationId: row.invocationId,
    },
    actor: row.actor,
    producer: row.producer,
    payload: row.payload,
    usage: hasUsage
      ? {
          tokensIn: row.tokensIn ?? 0,
          tokensOut: row.tokensOut ?? 0,
          cacheHit: row.cacheHit ?? false,
          costAmount: row.costAmount === null ? 0 : Number(row.costAmount),
          // Deliberately NOT `?? "usd"`. A usage-bearing row with no unit is a
          // bug (emitEvent refuses to write one, and migration 0006 backfilled
          // every pre-existing row), and silently reading it as dollars is the
          // exact mis-accounting the unit dimension exists to prevent.
          costUnit: assertPersistedResourceUnit(row.costUnit, row.id),
          modelId: row.modelId ?? "",
        }
      : null,
  };
}

/**
 * Fails closed when a usage-bearing row carries no recognized `cost_unit`,
 * rather than defaulting it. See the call site for why defaulting is unsafe.
 */
function assertPersistedResourceUnit(value: string | null, eventId: string) {
  if (!isResourceUnit(value)) {
    throw new Error(
      `emitEvent/rowToEnvelope: event "${eventId}" carries usage but its cost_unit is` +
        ` ${value === null ? "NULL" : `"${value}"`}, which is not a recognized ResourceUnit.` +
        " Refusing to assume a unit for a recorded cost amount."
    );
  }
  return value;
}

/**
 * Completes an event's correlation from its Run (spec §8.1: correlation carries
 * goal, workflow run, task instance, run and invocation).
 *
 * A Run determines its Task Instance, which determines its Workflow Run and
 * Goal, so any of those an emitter left null is derived here rather than
 * trusted to every call site — many emitters (the Executor, the Model Router,
 * governance) only know the run. Only NULL fields are filled; a value the
 * emitter supplied is never overwritten. Events with no run are unchanged.
 */
async function completeCorrelation(
  tx: DrizzleTransaction,
  correlation: EmitEventInput["correlation"]
): Promise<EmitEventInput["correlation"]> {
  if (!correlation.runId) return correlation;
  if (correlation.taskInstanceId && correlation.workflowRunId && correlation.goalId) return correlation;

  const [row] = await tx
    .select({
      taskInstanceId: schema.taskInstances.id,
      workflowRunId: schema.taskInstances.workflowRunId,
      goalId: schema.workflowRuns.goalId,
    })
    .from(schema.runs)
    .innerJoin(schema.taskInstances, eq(schema.runs.taskInstanceId, schema.taskInstances.id))
    .leftJoin(schema.workflowRuns, eq(schema.taskInstances.workflowRunId, schema.workflowRuns.id))
    .where(eq(schema.runs.id, correlation.runId));
  if (!row) return correlation;

  return {
    ...correlation,
    taskInstanceId: correlation.taskInstanceId ?? row.taskInstanceId,
    workflowRunId: correlation.workflowRunId ?? row.workflowRunId,
    goalId: correlation.goalId ?? row.goalId,
  };
}

/**
 * Inserts one Event row, computing its `sequenceNo` as the next monotonic
 * value scoped to `input.correlation.runId` (independent counters per
 * `runId`, including a shared counter for events with `runId: null`).
 *
 * Idempotent: if an event with the same `idempotencyKey` already exists,
 * that existing row is returned unchanged — no duplicate insert, no
 * sequence number consumed.
 *
 * Must be called with an open transaction (per the frozen interface) so the
 * sequence computation and insert are atomic together — the type only
 * accepts a transaction handle, not a bare db connection, to make that
 * invariant impossible to violate accidentally.
 */
export async function emitEvent(
  tx: DrizzleTransaction,
  input: EmitEventInput
): Promise<EventEnvelope> {
  // `costUnit` is required by the type, but enforce it at runtime too: this is
  // the single write path for every event in the system, so a unit-less usage
  // record must be unrepresentable here regardless of how the caller was
  // typechecked. Refusing costs one comparison; a wrongly-attributed cost
  // amount is permanent, because events are immutable.
  if (input.usage && !isResourceUnit(input.usage.costUnit)) {
    throw new Error(
      `emitEvent: event "${input.idempotencyKey}" supplies usage but no recognized costUnit` +
        " — a cost amount may never be recorded without the unit it is denominated in."
    );
  }

  const existing = await tx.query.events.findFirst({
    where: eq(events.idempotencyKey, input.idempotencyKey),
  });
  if (existing) {
    return rowToEnvelope(existing);
  }

  const runId = input.correlation.runId;
  const correlation = await completeCorrelation(tx, input.correlation);

  // Serialize sequence-number allocation per runId within this transaction
  // using a transaction-scoped advisory lock (released automatically at
  // commit/rollback) so concurrent emitters targeting the same runId can't
  // race on the max+1 computation.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId ?? "__null_run__"}))`);

  const runCondition = runId === null ? isNull(events.runId) : eq(events.runId, runId);
  const [{ nextSeq }] = await tx
    .select({
      nextSeq: sql<number>`coalesce(max(${events.sequenceNo}), 0) + 1`,
    })
    .from(events)
    .where(runCondition);

  const insertResult = await tx
    .insert(events)
    .values({
      idempotencyKey: input.idempotencyKey,
      eventType: input.eventType,
      eventVersion: input.eventVersion,
      sequenceNo: nextSeq,
      causationId: input.causationId,
      goalId: correlation.goalId,
      workflowRunId: correlation.workflowRunId,
      taskInstanceId: correlation.taskInstanceId,
      runId: correlation.runId,
      invocationId: correlation.invocationId,
      actor: input.actor,
      producer: input.producer,
      payload: input.payload,
      tokensIn: input.usage?.tokensIn ?? null,
      tokensOut: input.usage?.tokensOut ?? null,
      cacheHit: input.usage?.cacheHit ?? null,
      costAmount: input.usage ? String(input.usage.costAmount) : null,
      costUnit: input.usage ? input.usage.costUnit : null,
      modelId: input.usage?.modelId ?? null,
    })
    .onConflictDoNothing({ target: events.idempotencyKey })
    .returning();

  if (insertResult.length === 0) {
    // Lost a race against a concurrent emitter with the same idempotencyKey.
    const winner = await tx.query.events.findFirst({
      where: eq(events.idempotencyKey, input.idempotencyKey),
    });
    if (!winner) {
      throw new Error(
        `emitEvent: insert conflicted on idempotencyKey "${input.idempotencyKey}" but no row could be re-read`
      );
    }
    return rowToEnvelope(winner);
  }

  return rowToEnvelope(insertResult[0]);
}

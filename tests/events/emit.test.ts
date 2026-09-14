import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { resetTestSchema, closeTestDb, withRollback, testDb, deleteEventsForTest } from "../testDb.js";
import { emitEvent, type EmitEventInput } from "../../src/events/emit.js";
import { events } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

function baseInput(overrides: Partial<EmitEventInput> = {}): EmitEventInput {
  return {
    idempotencyKey: randomUUID(),
    eventType: "task_instance_completed",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: null,
      runId: randomUUID(),
      invocationId: null,
    },
    actor: "system",
    producer: "test-suite",
    payload: { note: "hello" },
    usage: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("emitEvent", () => {
  it("inserts a row with all envelope fields correctly populated", async () => {
    await withRollback(async (tx) => {
      const input = baseInput({
        eventType: "invocation_completed",
        eventVersion: 3,
        producer: "executor",
        actor: "agent:researcher@2",
        payload: { foo: "bar", n: 42 },
        usage: {
          tokensIn: 100,
          tokensOut: 50,
          cacheHit: true,
          costAmount: 0.0123, costUnit: "usd",
          modelId: "claude-test-model",
        },
      });

      const envelope = await emitEvent(tx, input);

      expect(envelope.eventId).toEqual(expect.any(String));
      expect(envelope.idempotencyKey).toBe(input.idempotencyKey);
      expect(envelope.eventType).toBe("invocation_completed");
      expect(envelope.eventVersion).toBe(3);
      expect(envelope.occurredAt).toBeInstanceOf(Date);
      expect(envelope.sequenceNo).toBe(1);
      expect(envelope.causationId).toBeNull();
      expect(envelope.correlation).toEqual(input.correlation);
      expect(envelope.actor).toBe("agent:researcher@2");
      expect(envelope.producer).toBe("executor");
      expect(envelope.payload).toEqual({ foo: "bar", n: 42 });
      expect(envelope.usage).toEqual({
        tokensIn: 100,
        tokensOut: 50,
        cacheHit: true,
        costAmount: 0.0123, costUnit: "usd",
        modelId: "claude-test-model",
      });

      // Confirm it actually landed in the table, not just in the return value.
      const row = await tx.query.events.findFirst({
        where: eq(events.idempotencyKey, input.idempotencyKey),
      });
      expect(row).toBeDefined();
      expect(row?.eventType).toBe("invocation_completed");
    });
  });

  it("produces strictly increasing sequenceNo per runId, independent across runIds", async () => {
    await withRollback(async (tx) => {
      const runA = randomUUID();
      const runB = randomUUID();

      const a1 = await emitEvent(tx, baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runA, invocationId: null } }));
      const a2 = await emitEvent(tx, baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runA, invocationId: null } }));
      const a3 = await emitEvent(tx, baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runA, invocationId: null } }));

      const b1 = await emitEvent(tx, baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runB, invocationId: null } }));
      const b2 = await emitEvent(tx, baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: runB, invocationId: null } }));

      expect([a1.sequenceNo, a2.sequenceNo, a3.sequenceNo]).toEqual([1, 2, 3]);
      expect([b1.sequenceNo, b2.sequenceNo]).toEqual([1, 2]);
    });
  });

  it("returns the original row when re-emitted with the same idempotencyKey, instead of inserting a duplicate", async () => {
    await withRollback(async (tx) => {
      const idempotencyKey = randomUUID();
      const runId = randomUUID();

      const first = await emitEvent(
        tx,
        baseInput({ idempotencyKey, payload: { attempt: 1 }, correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null } })
      );
      const second = await emitEvent(
        tx,
        baseInput({ idempotencyKey, payload: { attempt: 2 }, correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null } })
      );

      expect(second.eventId).toBe(first.eventId);
      expect(second.sequenceNo).toBe(first.sequenceNo);
      expect(second.payload).toEqual({ attempt: 1 }); // original, not the retried attempt's payload

      const rows = await tx.query.events.findMany({
        where: eq(events.idempotencyKey, idempotencyKey),
      });
      expect(rows).toHaveLength(1);

      // A third emit, this time to the same runId with a fresh key, should
      // continue the sequence from where the (single) prior insert left it.
      const third = await emitEvent(
        tx,
        baseInput({ correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null } })
      );
      expect(third.sequenceNo).toBe(2);
    });
  });

  it("assigns unique, monotonic sequence numbers when two genuinely concurrent transactions race on the same runId", async () => {
    const runId = randomUUID();

    // Two independent transactions, each on its own connection (testDb is a
    // Pool-backed instance, so each .transaction() call checks out a
    // separate client) — not the same tx handle reused sequentially. Both
    // are started and awaited together via Promise.all so their calls to
    // emitEvent genuinely overlap in time, then each commits on its own.
    const runInOwnTransaction = () =>
      testDb.transaction(async (tx) => {
        return emitEvent(
          tx,
          baseInput({
            correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null },
          })
        );
      });

    try {
      const [a, b] = await Promise.all([runInOwnTransaction(), runInOwnTransaction()]);

      expect(a.eventId).not.toBe(b.eventId);
      // Regardless of which transaction happened to commit first, the pair
      // of sequence numbers must be exactly {1, 2} — unique and monotonic,
      // no duplicates and no gaps.
      expect(new Set([a.sequenceNo, b.sequenceNo])).toEqual(new Set([1, 2]));
    } finally {
      // These two events were committed for real (not run inside
      // withRollback, since the whole point is two independently-committing
      // transactions) — clean them up so they don't linger for other tests
      // in this file.
      await deleteEventsForTest(eq(events.runId, runId));
    }
  });
});

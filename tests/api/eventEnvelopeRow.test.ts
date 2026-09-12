/**
 * Fix round 2 addition (Important #4's "while you're in the area" note,
 * not itself the required fix): a drift guard for
 * `../../src/api/eventEnvelopeRow.ts`'s `rowToEventEnvelope`, which is a
 * deliberate DUPLICATE of `../../src/events/emit.ts`'s private, frozen,
 * non-exported `rowToEnvelope` (see that module's own header for why it's
 * duplicated rather than imported). A duplicate has no compiler-enforced
 * link to its original — if `emit.ts`'s mapping ever changes (a new usage
 * field, a different null-handling rule), this file's copy would silently
 * drift out of sync with no test to catch it. This test proves, for the
 * SAME underlying row, that `rowToEventEnvelope`'s output deep-equals
 * exactly what `emitEvent` itself returned when it created that row —
 * covering both the `usage: null` and `usage: {...}` branches.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import { events } from "../../src/db/schema.js";
import { emitEvent } from "../../src/events/emit.js";
import { rowToEventEnvelope } from "../../src/api/eventEnvelopeRow.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("rowToEventEnvelope (drift guard against emit.ts's own private mapper)", () => {
  it("matches emitEvent's own returned envelope exactly for a usage-less event", async () => {
    await withRollback(async (tx) => {
      const returnedEnvelope = await emitEvent(tx, {
        idempotencyKey: "drift-guard-no-usage",
        eventType: "test_event",
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
        actor: "system",
        producer: "test",
        payload: { a: 1 },
        usage: null,
      });

      const row = await tx.query.events.findFirst({ where: eq(events.id, returnedEnvelope.eventId) });
      expect(row).toBeDefined();
      expect(rowToEventEnvelope(row!)).toEqual(returnedEnvelope);
      expect(rowToEventEnvelope(row!).usage).toBeNull();
    });
  });

  it("matches emitEvent's own returned envelope exactly for a usage-bearing event", async () => {
    await withRollback(async (tx) => {
      const returnedEnvelope = await emitEvent(tx, {
        idempotencyKey: "drift-guard-with-usage",
        eventType: "test_llm_event",
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
        actor: "system",
        producer: "test",
        payload: { b: 2 },
        usage: { tokensIn: 10, tokensOut: 5, cacheHit: true, costAmount: 0.002, modelId: "test-model" },
      });

      const row = await tx.query.events.findFirst({ where: eq(events.id, returnedEnvelope.eventId) });
      expect(row).toBeDefined();
      expect(rowToEventEnvelope(row!)).toEqual(returnedEnvelope);
      expect(rowToEventEnvelope(row!).usage).toEqual({
        tokensIn: 10,
        tokensOut: 5,
        cacheHit: true,
        costAmount: 0.002,
        modelId: "test-model",
      });
    });
  });
});

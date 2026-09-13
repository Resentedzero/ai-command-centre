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
 *
 * Finding 3 adaptation (NOT a relaxation): `rowToEventEnvelope` now returns a
 * `WireEventEnvelope` — the frozen domain envelope PLUS the transport-only
 * `eventCursor` (see that module's header for why the cursor lives at the
 * wire boundary rather than on `EventEnvelope`). `emitEvent` returns the
 * domain envelope and correctly has no such field, so the two can no longer
 * be compared with a bare `toEqual`. Each test below now splits the
 * comparison in two and asserts BOTH halves: the domain fields still
 * deep-equal `emitEvent`'s output exactly (the original drift guard, fully
 * intact), and the cursor is additionally checked against the row's own
 * `globalSeq`. The guard is strictly stronger than before, not weaker —
 * nothing that used to be asserted has been dropped.
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

      const { eventCursor, ...domainEnvelope } = rowToEventEnvelope(row!);
      expect(domainEnvelope).toEqual(returnedEnvelope);
      expect(eventCursor).toBe(row!.globalSeq);
      expect(domainEnvelope.usage).toBeNull();
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
        usage: { tokensIn: 10, tokensOut: 5, cacheHit: true, costAmount: 0.002, costUnit: "usd", modelId: "test-model" },
      });

      const row = await tx.query.events.findFirst({ where: eq(events.id, returnedEnvelope.eventId) });
      expect(row).toBeDefined();

      const { eventCursor, ...domainEnvelope } = rowToEventEnvelope(row!);
      expect(domainEnvelope).toEqual(returnedEnvelope);
      expect(eventCursor).toBe(row!.globalSeq);
      expect(domainEnvelope.usage).toEqual({
        tokensIn: 10,
        tokensOut: 5,
        cacheHit: true,
        costAmount: 0.002, costUnit: "usd",
        modelId: "test-model",
      });
    });
  });
});

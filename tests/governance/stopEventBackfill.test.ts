/**
 * A stop's audit event is written in a transaction after its state flip, so a
 * crash between them lost the event. Startup backfills it (idempotently).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import {
  backfillStopEvents,
  engageStop,
  EXECUTION_STOP_ENGAGED,
  EXECUTION_STOP_LIFTED,
  liftStop,
  recordStopEvent,
} from "../../src/governance/executionStop.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("stop audit event backfill", () => {
  it("writes the missing engaged and lifted events exactly once, and leaves recorded ones alone", async () => {
    await withRollback(async (tx) => {
      // Crashed after both flips, before either event.
      const lostRunId = randomUUID();
      const lost = await engageStop(tx, { scope: "run", scopeRefId: lostRunId, reason: "incident" });
      await liftStop(tx, { scope: "run", scopeRefId: lostRunId });
      // Fully recorded.
      const recorded = await engageStop(tx, { scope: "run", scopeRefId: randomUUID() });
      await recordStopEvent(tx, recorded, "engaged");

      expect(await backfillStopEvents(tx)).toBe(2);
      expect(await backfillStopEvents(tx)).toBe(0);

      const keys = (id: string) => [`${EXECUTION_STOP_ENGAGED}:${id}`, `${EXECUTION_STOP_LIFTED}:${id}`];
      const lostEvents = await tx.select().from(schema.events).where(inArray(schema.events.idempotencyKey, keys(lost.id)));
      expect(lostEvents.map((e) => e.eventType).sort()).toEqual([EXECUTION_STOP_ENGAGED, EXECUTION_STOP_LIFTED].sort());
      const recordedEvents = await tx.select().from(schema.events).where(eq(schema.events.idempotencyKey, `${EXECUTION_STOP_ENGAGED}:${recorded.id}`));
      expect(recordedEvents).toHaveLength(1);
    });
  });
});

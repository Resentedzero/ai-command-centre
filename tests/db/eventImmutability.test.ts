/**
 * Migration 0016: Events are append-only (spec §3e "append-only, immutable"; §8.7 "the
 * raw Event table itself, immutable — no separate audit log"). The database refuses
 * UPDATE, DELETE and TRUNCATE on `events`, so the audit log does not depend on every
 * writer's discipline. Inserting still works.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, deleteEventsForTest, resetTestSchema, testDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function anEvent(tx: DrizzleTransaction) {
  return emitEvent(tx, {
    idempotencyKey: `immutability:${randomUUID()}`,
    eventType: "immutability_probe",
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: randomUUID(), invocationId: null },
    actor: "system",
    producer: "test",
    payload: { note: "original" },
    usage: null,
  });
}

/** Runs `change` in a savepoint and returns the database error message it raised, if any. */
async function refusal(tx: DrizzleTransaction, change: (sp: DrizzleTransaction) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await change(sp);
    });
    return null;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
}

describe("events are append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and leaves the row as written", async () => {
    await withRollback(async (tx) => {
      const { eventId } = await anEvent(tx);
      const where = eq(schema.events.id, eventId);

      expect(await refusal(tx, (sp) => sp.update(schema.events).set({ payload: { note: "rewritten" } }).where(where))).toMatch(/events are immutable/);
      expect(await refusal(tx, (sp) => sp.update(schema.events).set({ eventType: "other" }).where(where))).toMatch(/events are immutable/);
      expect(await refusal(tx, (sp) => sp.delete(schema.events).where(where))).toMatch(/events are immutable/);
      // Plain TRUNCATE is already refused because other tables reference events; CASCADE is what reaches the guard.
      expect(await refusal(tx, (sp) => sp.execute(sql.raw('TRUNCATE "events" CASCADE')))).toMatch(/events are immutable/);

      expect(await tx.query.events.findFirst({ where })).toMatchObject({ eventType: "immutability_probe", payload: { note: "original" } });
    });
  });

  it("test cleanup can still remove committed events, and the guard is back afterwards", async () => {
    const { eventId } = await testDb.transaction((tx) => anEvent(tx));
    await deleteEventsForTest(eq(schema.events.id, eventId));
    expect(await testDb.query.events.findFirst({ where: eq(schema.events.id, eventId) })).toBeUndefined();

    await withRollback(async (tx) => {
      const { eventId: next } = await anEvent(tx);
      expect(await refusal(tx, (sp) => sp.delete(schema.events).where(eq(schema.events.id, next)))).toMatch(/events are immutable/);
    });
  });
});

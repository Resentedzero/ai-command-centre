/**
 * Provider quota state (Phase 7A; design Parts 3, 4, 10).
 *
 * Two properties are under test, and they are deliberately separate:
 *
 *  1. The projection holds the LATEST provider observation — never a maximum,
 *     never an accumulation, never a blend. Utilization was measured going
 *     BACKWARDS inside one second, so a projection that maxed or summed would
 *     be wrong on real data; several tests below replay that exact sequence.
 *
 *  2. Quota state and usage accounting never touch. No test here provisions a
 *     budget counter, and two tests assert that recording quota readings leaves
 *     `budget_counters` untouched and mints no `subscription_tokens` usage.
 *
 * Everything is fixture-driven; nothing here invokes Claude.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import {
  recordQuotaObservation,
  applyQuotaObservation,
  getQuotaState,
  PROVIDER_QUOTA_OBSERVED,
  PROVIDER_QUOTA_OBSERVED_VERSION,
  type QuotaObservation,
} from "../../src/governance/subscriptionQuotaState.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const PROVIDER = "claude_subscription";

/**
 * A reading shaped exactly like the `rate_limit_event` payload observed in the
 * Phase 4/5 benchmarks — same field names, same value ranges, same
 * `overageStatus`.
 */
function observation(overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    provider: PROVIDER,
    observedAt: new Date("2026-09-13T19:38:32.000Z"),
    status: "allowed",
    overageStatus: "rejected",
    source: "rate_limit_event",
    fiveHour: { utilization: 0.47, resetsAt: "2026-09-13T22:30:00.000Z" },
    sevenDay: { utilization: 0.17, resetsAt: "2026-09-20T03:00:00.000Z" },
    observationCount: 1,
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof recordQuotaObservation>[2]> = {}) {
  return {
    idempotencyKey: `${PROVIDER_QUOTA_OBSERVED}:${randomUUID()}:0`,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: null,
      runId: null,
      invocationId: null,
    },
    producer: "claude-subscription-provider",
    ...overrides,
  };
}

async function stateOf(tx: DrizzleTransaction) {
  const row = await getQuotaState(tx, PROVIDER);
  if (!row) throw new Error("expected a subscription_quota_state row");
  return row;
}

describe("provider quota observation event", () => {
  it("emits an immutable fact with the frozen type, version, actor and no usage", async () => {
    await withRollback(async (tx) => {
      const event = await recordQuotaObservation(tx, observation(), context());

      expect(event.eventType).toBe(PROVIDER_QUOTA_OBSERVED);
      expect(event.eventVersion).toBe(PROVIDER_QUOTA_OBSERVED_VERSION);
      expect(event.actor).toBe("system");
      expect(event.producer).toBe("claude-subscription-provider");
      // A quota reading is not consumption. A usage envelope here would be the
      // first step toward treating utilization as a cost.
      expect(event.usage).toBeNull();
    });
  });

  it("preserves correlation and causation so the reading is traceable to its invocation", async () => {
    await withRollback(async (tx) => {
      const causationId = randomUUID();
      const invocationId = randomUUID();
      const runId = randomUUID();

      const event = await recordQuotaObservation(
        tx,
        observation(),
        context({
          causationId,
          correlation: {
            goalId: null,
            workflowRunId: null,
            taskInstanceId: null,
            runId,
            invocationId,
          },
        })
      );

      expect(event.causationId).toBe(causationId);
      expect(event.correlation.invocationId).toBe(invocationId);
      expect(event.correlation.runId).toBe(runId);
    });
  });

  it("carries every field the projection needs, so the projection is reconstructible from the event alone", async () => {
    await withRollback(async (tx) => {
      const event = await recordQuotaObservation(tx, observation(), context());

      // Wipe the projection entirely, then rebuild it from the stored event.
      await tx.delete(schema.subscriptionQuotaState);
      expect(await getQuotaState(tx, PROVIDER)).toBeUndefined();

      const stored = await tx.query.events.findFirst({ where: eq(schema.events.id, event.eventId) });
      await applyQuotaObservation(tx, { ...event, payload: stored!.payload });

      const rebuilt = await stateOf(tx);
      expect(Number(rebuilt.fiveHourUtilization)).toBe(0.47);
      expect(Number(rebuilt.sevenDayUtilization)).toBe(0.17);
      expect(rebuilt.fiveHourResetAt?.toISOString()).toBe("2026-09-13T22:30:00.000Z");
      expect(rebuilt.sevenDayResetAt?.toISOString()).toBe("2026-09-20T03:00:00.000Z");
      expect(rebuilt.status).toBe("allowed");
      expect(rebuilt.overageStatus).toBe("rejected");
      expect(rebuilt.source).toBe("rate_limit_event");
      expect(rebuilt.observedAt.toISOString()).toBe("2026-09-13T19:38:32.000Z");
      expect(rebuilt.observationEventId).toBe(event.eventId);
    });
  });

  it("refuses to project an event that is not a quota observation", async () => {
    await withRollback(async (tx) => {
      const event = await recordQuotaObservation(tx, observation(), context());
      await expect(
        applyQuotaObservation(tx, { ...event, eventType: "invocation_completed" })
      ).rejects.toThrow(/only "provider_quota_observed"/);
    });
  });
});

describe("quota state projection", () => {
  it("creates state from the first observation, preserving every reported field", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(tx, observation(), context());

      const state = await stateOf(tx);
      expect(state.provider).toBe(PROVIDER);
      expect(Number(state.fiveHourUtilization)).toBe(0.47);
      expect(state.fiveHourResetAt?.toISOString()).toBe("2026-09-13T22:30:00.000Z");
      expect(Number(state.sevenDayUtilization)).toBe(0.17);
      expect(state.sevenDayResetAt?.toISOString()).toBe("2026-09-20T03:00:00.000Z");
      expect(state.status).toBe("allowed");
      expect(state.overageStatus).toBe("rejected");
      expect(state.source).toBe("rate_limit_event");
      expect(state.observedAt.toISOString()).toBe("2026-09-13T19:38:32.000Z");
    });
  });

  it("replaces state when a newer observation arrives", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(tx, observation(), context());
      const newer = await recordQuotaObservation(
        tx,
        observation({
          observedAt: new Date("2026-09-13T19:40:00.000Z"),
          fiveHour: { utilization: 0.52, resetsAt: "2026-09-13T22:30:00.000Z" },
          status: "allowed",
        }),
        context()
      );

      const state = await stateOf(tx);
      expect(Number(state.fiveHourUtilization)).toBe(0.52);
      expect(state.observedAt.toISOString()).toBe("2026-09-13T19:40:00.000Z");
      expect(state.observationEventId).toBe(newer.eventId);
    });
  });

  it("does not let an older observation overwrite newer state", async () => {
    await withRollback(async (tx) => {
      const newer = await recordQuotaObservation(
        tx,
        observation({
          observedAt: new Date("2026-09-13T19:40:00.000Z"),
          fiveHour: { utilization: 0.52, resetsAt: "2026-09-13T22:30:00.000Z" },
        }),
        context()
      );
      // An out-of-order arrival: emitted second, observed first.
      await recordQuotaObservation(
        tx,
        observation({
          observedAt: new Date("2026-09-13T19:20:00.000Z"),
          fiveHour: { utilization: 0.11, resetsAt: "2026-09-13T22:30:00.000Z" },
          status: "stale-should-not-apply",
        }),
        context()
      );

      const state = await stateOf(tx);
      expect(Number(state.fiveHourUtilization)).toBe(0.52);
      expect(state.status).toBe("allowed");
      expect(state.observedAt.toISOString()).toBe("2026-09-13T19:40:00.000Z");
      expect(state.observationEventId).toBe(newer.eventId);
    });
  });

  it("is idempotent: the same observation replayed changes nothing and emits no second event", async () => {
    await withRollback(async (tx) => {
      const ctx = context();
      const first = await recordQuotaObservation(tx, observation(), ctx);
      const replay = await recordQuotaObservation(tx, observation(), ctx);

      expect(replay.eventId).toBe(first.eventId);
      expect(replay.sequenceNo).toBe(first.sequenceNo);

      const rows = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.eventType, PROVIDER_QUOTA_OBSERVED));
      expect(rows).toHaveLength(1);

      const states = await tx.select().from(schema.subscriptionQuotaState);
      expect(states).toHaveLength(1);
      expect(states[0]!.observationEventId).toBe(first.eventId);
    });
  });

  it("stores the latest reading even when utilization goes DOWN — never a maximum", async () => {
    // The real Phase 5 sequence: four concurrent invocations at 19:38:32
    // reported 0.47, 0.47, 0.48, 0.47. A projection that kept the max would
    // report 0.48 forever; the correct answer is the last reading, 0.47.
    await withRollback(async (tx) => {
      const readings: Array<[string, number]> = [
        ["2026-09-13T19:38:32.100Z", 0.47],
        ["2026-09-13T19:38:32.200Z", 0.47],
        ["2026-09-13T19:38:32.300Z", 0.48],
        ["2026-09-13T19:38:32.400Z", 0.47],
      ];
      for (const [at, utilization] of readings) {
        await recordQuotaObservation(
          tx,
          observation({
            observedAt: new Date(at),
            fiveHour: { utilization, resetsAt: "2026-09-13T22:30:00.000Z" },
          }),
          context()
        );
      }

      const state = await stateOf(tx);
      expect(Number(state.fiveHourUtilization)).toBe(0.47);
      expect(state.observedAt.toISOString()).toBe("2026-09-13T19:38:32.400Z");
    });
  });

  it("never accumulates: N readings leave exactly one row holding one reading", async () => {
    await withRollback(async (tx) => {
      for (let i = 0; i < 5; i++) {
        await recordQuotaObservation(
          tx,
          observation({
            observedAt: new Date(Date.UTC(2026, 8, 13, 19, 40, i)),
            fiveHour: { utilization: 0.2, resetsAt: "2026-09-13T22:30:00.000Z" },
          }),
          context()
        );
      }

      const rows = await tx.select().from(schema.subscriptionQuotaState);
      expect(rows).toHaveLength(1);
      // 5 readings of 0.2 must not become 1.0.
      expect(Number(rows[0]!.fiveHourUtilization)).toBe(0.2);
    });
  });

  it("keeps providers independent, so a future provider can coexist", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(tx, observation(), context());
      await recordQuotaObservation(
        tx,
        observation({
          provider: "some_future_provider",
          fiveHour: { utilization: 0.99, resetsAt: "2026-09-13T22:30:00.000Z" },
        }),
        context()
      );

      const mine = await stateOf(tx);
      const other = await getQuotaState(tx, "some_future_provider");
      expect(Number(mine.fiveHourUtilization)).toBe(0.47);
      expect(Number(other!.fiveHourUtilization)).toBe(0.99);
    });
  });
});

describe("omitted provider fields", () => {
  it("records an absent window as absent rather than inventing a zero", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(
        tx,
        observation({ sevenDay: null, overageStatus: null }),
        context()
      );

      const state = await stateOf(tx);
      expect(state.sevenDayUtilization).toBeNull();
      expect(state.sevenDayResetAt).toBeNull();
      expect(state.overageStatus).toBeNull();
      // The window that WAS reported is unaffected.
      expect(Number(state.fiveHourUtilization)).toBe(0.47);
    });
  });

  it("records a window reported without a utilization or without a reset", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(
        tx,
        observation({
          fiveHour: { utilization: null, resetsAt: "2026-09-13T22:30:00.000Z" },
          sevenDay: { utilization: 0.17, resetsAt: null },
        }),
        context()
      );

      const state = await stateOf(tx);
      expect(state.fiveHourUtilization).toBeNull();
      expect(state.fiveHourResetAt?.toISOString()).toBe("2026-09-13T22:30:00.000Z");
      expect(Number(state.sevenDayUtilization)).toBe(0.17);
      expect(state.sevenDayResetAt).toBeNull();
    });
  });

  it("rejects a malformed reading rather than coercing it", async () => {
    await withRollback(async (tx) => {
      await expect(
        recordQuotaObservation(
          tx,
          observation({ fiveHour: { utilization: Number.NaN, resetsAt: null } }),
          context()
        )
      ).rejects.toThrow(/finite number/);

      await expect(
        recordQuotaObservation(
          tx,
          observation({ fiveHour: { utilization: 0.4, resetsAt: "not-a-date" } }),
          context()
        )
      ).rejects.toThrow(/not a valid ISO-8601 instant/);
    });
  });
});

describe("separation from usage accounting", () => {
  it("writes no budget counter and mints no usage", async () => {
    await withRollback(async (tx) => {
      await recordQuotaObservation(tx, observation(), context());
      await recordQuotaObservation(
        tx,
        observation({ observedAt: new Date("2026-09-13T19:45:00.000Z") }),
        context()
      );

      const counters = await tx.select().from(schema.budgetCounters);
      expect(counters).toHaveLength(0);

      const quotaEvents = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.eventType, PROVIDER_QUOTA_OBSERVED));
      expect(quotaEvents).toHaveLength(2);
      for (const row of quotaEvents) {
        expect(row.costAmount).toBeNull();
        expect(row.costUnit).toBeNull();
        expect(row.tokensIn).toBeNull();
        expect(row.tokensOut).toBeNull();
        expect(row.modelId).toBeNull();
      }
    });
  });

  it("leaves an existing subscription_tokens counter completely untouched", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await tx.insert(schema.budgetCounters).values({
        scope: "run",
        scopeRefId: runId,
        resourceUnit: "subscription_tokens",
        limitAmount: "100000",
        reservedAmount: "0",
        consumedAmount: "0",
      });

      await recordQuotaObservation(
        tx,
        observation({ fiveHour: { utilization: 0.95, resetsAt: "2026-09-13T22:30:00.000Z" } }),
        context()
      );

      const counter = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
      });
      // A 0.95 utilization reading must not have been converted into tokens,
      // reserved, consumed, or otherwise reflected in the counter.
      expect(counter!.reservedAmount).toBe("0");
      expect(counter!.consumedAmount).toBe("0");
      expect(counter!.limitAmount).toBe("100000");
    });
  });

  it("contains no utilization-to-token/USD conversion anywhere in the module", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/governance/subscriptionQuotaState.ts"),
      "utf8"
    );
    // Comments are stripped first: the module's own documentation NAMES the
    // things it must not do ("never converts utilization into tokens"), and a
    // naive grep would flag that prose as a violation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The module must not import the Budget Governor or reference a counter,
    // a resource unit, or a price — structurally, not just by convention.
    expect(code).not.toMatch(/from\s+["'].*\/budget\.js["']/);
    expect(code).not.toMatch(/budgetCounters/);
    expect(code).not.toMatch(/reserveBudget|reconcileBudget|releaseReservation/);
    expect(code).not.toMatch(/subscription_tokens|ResourceUnit|perToken|costAmount/);
  });
});

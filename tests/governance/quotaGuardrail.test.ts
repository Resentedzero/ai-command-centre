/**
 * Subscription quota guardrail (Phase 7C).
 *
 * Three properties are under test, and the suite is written so that collapsing
 * any of them fails it:
 *
 *  1. DISABLED IS DISABLED. The shipped config cannot refuse anything, and with
 *     it in place `authorizeRoute` behaves exactly as it did before Phase 7C.
 *  2. THE GUARDRAIL IS ADVISORY. It never writes a budget counter, never
 *     touches `subscription_tokens`, and converts utilization into nothing.
 *  3. HYSTERESIS ABSORBS REAL JITTER. The flap test replays the measured
 *     0.47/0.48 sequence rather than a synthetic one.
 *
 * All fixture-driven; no live Claude invocation.
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
  type QuotaObservation,
} from "../../src/governance/subscriptionQuotaState.js";
import {
  evaluateQuotaGuardrail,
  validateQuotaGuardrailConfig,
  readLatchedState,
  quotaGuardrailConfig,
  QUOTA_GUARDRAIL_STATE_CHANGED,
  type QuotaGuardrailConfig,
} from "../../src/governance/quotaGuardrail.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const PROVIDER = "claude_subscription";

const ENABLED: Record<string, QuotaGuardrailConfig> = {
  [PROVIDER]: {
    enabled: true,
    fiveHour: { upper: 0.9, lower: 0.8 },
    sevenDay: { upper: 0.95, lower: 0.85 },
  },
};

function observation(fiveHour: number | null, overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    provider: PROVIDER,
    observedAt: new Date("2026-09-13T19:38:32.000Z"),
    status: "allowed",
    overageStatus: "rejected",
    source: "rate_limit_event",
    fiveHour: fiveHour === null ? null : { utilization: fiveHour, resetsAt: "2026-09-13T22:30:00.000Z" },
    sevenDay: { utilization: 0.17, resetsAt: "2026-09-20T03:00:00.000Z" },
    observationCount: 1,
    ...overrides,
  };
}

let clock = 0;
async function observe(tx: DrizzleTransaction, obs: QuotaObservation) {
  // Each observation must be strictly newer, or the projection keeps the older.
  clock += 1000;
  return recordQuotaObservation(
    tx,
    { ...obs, observedAt: new Date(obs.observedAt.getTime() + clock) },
    {
      idempotencyKey: `provider_quota_observed:${randomUUID()}:0`,
      causationId: null,
      correlation: {
        goalId: null,
        workflowRunId: null,
        taskInstanceId: null,
        runId: null,
        invocationId: null,
      },
      producer: "claude-subscription-provider",
    }
  );
}

const evaluate = (tx: DrizzleTransaction, configs = ENABLED, now?: Date) =>
  evaluateQuotaGuardrail(tx, { provider: PROVIDER, now }, configs);

// ---------------------------------------------------------------------------

describe("shipping default", () => {
  it("is DISABLED, with no thresholds enshrined", () => {
    expect(quotaGuardrailConfig[PROVIDER]!.enabled).toBe(false);
    expect(quotaGuardrailConfig[PROVIDER]!.fiveHour).toBeUndefined();
    expect(quotaGuardrailConfig[PROVIDER]!.sevenDay).toBeUndefined();
  });

  it("cannot refuse, even at utilization that would otherwise close dispatch", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.99));

      const result = await evaluateQuotaGuardrail(tx, { provider: PROVIDER }, quotaGuardrailConfig);
      expect(result.decision).toEqual({ decision: "ALLOW", reason: "disabled" });
      expect(result.changed).toBe(false);
    });
  });

  it("allows a provider that has no guardrail configuration at all", async () => {
    await withRollback(async (tx) => {
      const result = await evaluateQuotaGuardrail(tx, { provider: "anthropic" }, quotaGuardrailConfig);
      expect(result.decision).toEqual({ decision: "ALLOW", reason: "not_configured" });
    });
  });
});

describe("unknown and stale state", () => {
  it("allows and records UNKNOWN when no observation exists", async () => {
    await withRollback(async (tx) => {
      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "UNKNOWN_ALLOWED", reason: "no_observation" });
      expect(result.state).toBe("OPEN");
    });
  });

  it("does not treat unknown state as provider rejection", async () => {
    await withRollback(async (tx) => {
      const result = await evaluate(tx);
      expect(result.decision.decision).not.toBe("PROVIDER_REJECTED");
      expect(result.decision.decision).not.toBe("REFUSE_QUOTA");
    });
  });

  it("treats an observation older than the configured freshness as STALE, and allows", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.1));

      const configs = { [PROVIDER]: { ...ENABLED[PROVIDER]!, freshnessMs: 60_000 } };
      const result = await evaluateQuotaGuardrail(
        tx,
        { provider: PROVIDER, now: new Date("2026-09-14T00:00:00.000Z") },
        configs
      );

      expect(result.decision).toEqual({ decision: "UNKNOWN_ALLOWED", reason: "stale_observation" });
    });
  });

  it("never goes stale when no freshness policy is configured", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.1));

      const result = await evaluate(tx, ENABLED, new Date("2027-01-01T00:00:00.000Z"));
      expect(result.decision).toEqual({ decision: "ALLOW", reason: "below_threshold" });
    });
  });

  it("keeps a CLOSED latch while telemetry is unknown, but still allows dispatch", async () => {
    // Otherwise a closed guardrail could never observe its own recovery:
    // telemetry only arrives as a by-product of invocations.
    await withRollback(async (tx) => {
      await observe(tx, observation(0.95));
      expect((await evaluate(tx)).state).toBe("CLOSED");

      await tx.delete(schema.subscriptionQuotaState);

      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "UNKNOWN_ALLOWED", reason: "no_observation" });
      expect(result.state).toBe("CLOSED");
      expect(await readLatchedState(tx, PROVIDER)).toBe("CLOSED");
    });
  });
});

describe("thresholds and hysteresis", () => {
  it("allows below the lower threshold", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.45));
      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "ALLOW", reason: "below_threshold" });
      expect(result.state).toBe("OPEN");
    });
  });

  it("refuses at the five-hour upper threshold", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.9));
      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "REFUSE_QUOTA", reason: "five_hour_upper" });
      expect(result.state).toBe("CLOSED");
      expect(result.changed).toBe(true);
    });
  });

  it("refuses on the seven-day window independently of the five-hour one", async () => {
    await withRollback(async (tx) => {
      // Five-hour window is clear; seven-day is at its ceiling.
      await observe(tx, observation(0.1, { sevenDay: { utilization: 0.96, resetsAt: null } }));

      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "REFUSE_QUOTA", reason: "seven_day_upper" });
    });
  });

  it("retains the previous state between the thresholds", async () => {
    await withRollback(async (tx) => {
      // Open, then move into the band: stays open.
      await observe(tx, observation(0.1));
      expect((await evaluate(tx)).state).toBe("OPEN");
      await observe(tx, observation(0.85));
      expect((await evaluate(tx)).decision).toEqual({ decision: "ALLOW", reason: "below_threshold" });

      // Close, then come back into the band: stays closed.
      await observe(tx, observation(0.92));
      expect((await evaluate(tx)).state).toBe("CLOSED");
      await observe(tx, observation(0.85));
      const held = await evaluate(tx);
      expect(held.decision).toEqual({ decision: "REFUSE_QUOTA", reason: "latched_closed" });
      expect(held.state).toBe("CLOSED");
    });
  });

  it("reopens only once BOTH windows are back below their lower thresholds", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.95));
      expect((await evaluate(tx)).state).toBe("CLOSED");

      // Five-hour recovered, seven-day still in its band -> stays closed.
      await observe(tx, observation(0.1, { sevenDay: { utilization: 0.9, resetsAt: null } }));
      expect((await evaluate(tx)).state).toBe("CLOSED");

      // Both below their lower thresholds -> reopens.
      await observe(tx, observation(0.1, { sevenDay: { utilization: 0.2, resetsAt: null } }));
      const reopened = await evaluate(tx);
      expect(reopened.decision).toEqual({ decision: "ALLOW", reason: "below_threshold" });
      expect(reopened.state).toBe("OPEN");
    });
  });

  it("does not flap on the measured 0.47/0.48 jitter", async () => {
    // Thresholds deliberately straddling the real jitter band. Without
    // hysteresis this sequence would alternate refuse/allow.
    const jitterConfig = {
      [PROVIDER]: { enabled: true, fiveHour: { upper: 0.48, lower: 0.4 } },
    };

    await withRollback(async (tx) => {
      const decisions: string[] = [];
      for (const utilization of [0.47, 0.47, 0.48, 0.47, 0.47, 0.48, 0.47]) {
        await observe(tx, observation(utilization));
        decisions.push((await evaluateQuotaGuardrail(tx, { provider: PROVIDER }, jitterConfig)).decision.decision);
      }

      // It closes ONCE at the first 0.48, then stays closed — 0.47 sits inside
      // the band, so it never bounces back open.
      expect(decisions).toEqual([
        "ALLOW",
        "ALLOW",
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
      ]);

      // And exactly one transition event, not one per reading.
      const transitions = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.eventType, QUOTA_GUARDRAIL_STATE_CHANGED));
      expect(transitions).toHaveLength(1);
    });
  });

  it("is stable when the identical observation repeats", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.95));

      const first = await evaluate(tx);
      const second = await evaluate(tx);
      const third = await evaluate(tx);

      expect([first, second, third].map((r) => r.decision.decision)).toEqual([
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
        "REFUSE_QUOTA",
      ]);
      // Only the first evaluation moved the latch.
      expect([first.changed, second.changed, third.changed]).toEqual([true, false, false]);
    });
  });

  it("cannot judge a window the provider reported without a utilization", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(null, { sevenDay: null }));

      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "ALLOW", reason: "not_configured" });
      expect(result.state).toBe("OPEN");
    });
  });

  it("preserves reset timestamps as state without deriving anything from them", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.45));
      const state = await tx.query.subscriptionQuotaState.findFirst({
        where: eq(schema.subscriptionQuotaState.provider, PROVIDER),
      });

      expect(state!.fiveHourResetAt?.toISOString()).toBe("2026-09-13T22:30:00.000Z");
      expect(state!.sevenDayResetAt?.toISOString()).toBe("2026-09-20T03:00:00.000Z");
      // The decision is driven by utilization alone; a reset in the past or the
      // future changes nothing about it.
      expect((await evaluate(tx)).decision).toEqual({ decision: "ALLOW", reason: "below_threshold" });
    });
  });
});

describe("provider status", () => {
  it("reports an explicit non-allowed status as PROVIDER_REJECTED, distinct from unknown", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.1, { status: "rejected" }));

      const result = await evaluate(tx);
      expect(result.decision).toEqual({ decision: "PROVIDER_REJECTED", reason: "status_not_allowed" });
      // Not latched: it reflects what the provider says right now.
      expect(result.changed).toBe(false);
    });
  });

  it("accepts the expected overage status and flags a changed one for policy review", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.1, { overageStatus: "rejected" }));
      expect((await evaluate(tx)).decision.decision).toBe("ALLOW");

      await observe(tx, observation(0.1, { overageStatus: "allowed" }));
      expect((await evaluate(tx)).decision).toEqual({
        decision: "PROVIDER_REJECTED",
        reason: "overage_status_unexpected",
      });
    });
  });
});

describe("configuration validation", () => {
  it("rejects a threshold pair with no hysteresis band", () => {
    expect(() =>
      validateQuotaGuardrailConfig(PROVIDER, { enabled: true, fiveHour: { upper: 0.8, lower: 0.8 } })
    ).toThrow(/strictly below/);
    expect(() =>
      validateQuotaGuardrailConfig(PROVIDER, { enabled: true, fiveHour: { upper: 0.5, lower: 0.9 } })
    ).toThrow(/strictly below/);
  });

  it("rejects utilization thresholds outside 0..1 and a non-positive freshness", () => {
    expect(() =>
      validateQuotaGuardrailConfig(PROVIDER, { enabled: true, fiveHour: { upper: 1.5, lower: 0.1 } })
    ).toThrow(/between 0 and 1/);
    expect(() =>
      validateQuotaGuardrailConfig(PROVIDER, { enabled: true, fiveHour: { upper: Number.NaN, lower: 0.1 } })
    ).toThrow(/between 0 and 1/);
    expect(() => validateQuotaGuardrailConfig(PROVIDER, { enabled: true, freshnessMs: 0 })).toThrow(/positive/);
  });
});

describe("separation from accounting", () => {
  it("writes no budget counter and no usage, whatever it decides", async () => {
    await withRollback(async (tx) => {
      await observe(tx, observation(0.99));
      await evaluate(tx);
      await observe(tx, observation(0.05));
      await evaluate(tx);

      expect(await tx.select().from(schema.budgetCounters)).toHaveLength(0);

      const transitions = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.eventType, QUOTA_GUARDRAIL_STATE_CHANGED));
      expect(transitions.length).toBeGreaterThan(0);
      for (const row of transitions) {
        expect(row.costAmount).toBeNull();
        expect(row.costUnit).toBeNull();
        expect(row.tokensIn).toBeNull();
      }
    });
  });

  it("leaves an existing subscription_tokens counter untouched while refusing", async () => {
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

      await observe(tx, observation(0.99));
      expect((await evaluate(tx)).decision.decision).toBe("REFUSE_QUOTA");

      const counter = await tx.query.budgetCounters.findFirst({
        where: eq(schema.budgetCounters.scopeRefId, runId),
      });
      expect(counter!.reservedAmount).toBe("0");
      expect(counter!.consumedAmount).toBe("0");
      expect(counter!.limitAmount).toBe("100000");
    });
  });

  it("contains no utilization-to-token or utilization-to-USD conversion", () => {
    const source = readFileSync(path.join(process.cwd(), "src/governance/quotaGuardrail.ts"), "utf8");
    // Comments name what the module must not do; strip them before grepping.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/from\s+["'].*\/budget\.js["']/);
    expect(code).not.toMatch(/budgetCounters|reserveBudget|reconcileBudget/);
    expect(code).not.toMatch(/subscription_tokens|ResourceUnit|perToken|costAmount/);
    // No arithmetic turning a utilization into an amount.
    expect(code).not.toMatch(/utilization\s*[*/]|[*/]\s*utilization/);
  });
});

describe("audit trail", () => {
  it("records the transition as its own event, without touching the provider fact", async () => {
    await withRollback(async (tx) => {
      const observationEvent = await observe(tx, observation(0.93));
      await evaluate(tx);

      const [transition] = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.eventType, QUOTA_GUARDRAIL_STATE_CHANGED));

      expect(transition!.producer).toBe("quota-guardrail");
      // Caused BY the observation, and pointing at it — the interpretation and
      // the fact stay separate rows.
      expect(transition!.causationId).toBe(observationEvent.eventId);
      expect(transition!.payload).toMatchObject({ provider: PROVIDER, from: "OPEN", to: "CLOSED" });

      // The provider observation event itself is untouched.
      const fact = await tx.query.events.findFirst({
        where: eq(schema.events.id, observationEvent.eventId),
      });
      expect(fact!.eventType).toBe("provider_quota_observed");
      expect(fact!.payload).toMatchObject({ status: "allowed" });
    });
  });
});

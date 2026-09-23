/**
 * The token report must not mix resource units (R2 Task 42, Step 7).
 *
 * `cost_amount` is denominated in the invocation's own unit. For `subscription_tokens` it is a token
 * count and shares a dimension with `tokens_in`/`tokens_out`, so the residual between them is
 * meaningful — it is exactly the non-primary model entries. For `usd` it is MONEY, and subtracting
 * tokens from it produces a number with no meaning at all. The report used to do that subtraction
 * unconditionally and then express a token estimate as a percentage of the result.
 *
 * These drive the real `runTokenReport` against real rows, with only the database handle redirected.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { emitEvent } from "../../src/events/emit.js";

vi.mock("../../src/db/client.js", async () => ({ db: (await import("../testDb.js")).testDb }));

import { formatTokenReport, runTokenReport } from "../../src/observability/tokenReport.js";

const RUN_TOKENS = "11111111-1111-4111-8111-111111111111";
const RUN_USD = "22222222-2222-4222-8222-222222222222";

/** One completed model invocation, written through the real emitter. */
async function invocation(runId: string, unit: "subscription_tokens" | "usd", counted: number, tokensIn: number, tokensOut: number, key: string) {
  await testDb.transaction((tx) =>
    emitEvent(tx as unknown as DrizzleTransaction, {
      idempotencyKey: key,
      eventType: "invocation_completed",
      eventVersion: 1,
      causationId: null,
      correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null },
      actor: "system",
      producer: "model-router",
      payload: { tier: "CHEAP", modelId: "m" },
      usage: { tokensIn, tokensOut, cacheHit: false, costAmount: counted, costUnit: unit, modelId: "m" },
    })
  );
}

beforeAll(async () => {
  await resetTestSchema();
  // A token run: counted 990 over a primary of 2/80, so 908 belongs to other model entries.
  await invocation(RUN_TOKENS, "subscription_tokens", 990, 2, 80, "t1");
  // A money run: 0.42 dollars, with 100/50 tokens. There is no residual to compute.
  await invocation(RUN_USD, "usd", 0.42, 100, 50, "u1");
}, 60_000);

afterAll(async () => {
  await closeTestDb();
});

describe("a token-denominated run", () => {
  it("reports the non-primary models' share exactly, because the counted total is their sum", async () => {
    const report = await runTokenReport(RUN_TOKENS);
    expect(report.unit).toBe("subscription_tokens");
    expect(report.totals.counted).toBe(990);
    expect(report.totals.secondaryTokens).toBe(908);
    expect(formatTokenReport(report)).toContain("secondary models 908");
  });
});

describe("a money-denominated run", () => {
  it("computes no token residual from a dollar amount", async () => {
    const report = await runTokenReport(RUN_USD);
    expect(report.unit).toBe("usd");
    // The defect: 0.42 - 100 - 50 = -149.58, once reported as though it meant something.
    expect(report.calls[0]!.secondaryTokens).toBeNull();
    expect(report.totals.secondaryTokens).toBe(0);
  });

  it("says the amount is a local estimate rather than printing token shares against it", async () => {
    const text = formatTokenReport(await runTokenReport(RUN_USD));
    expect(text).toContain("not a bill");
    expect(text).not.toContain("secondary models");
    expect(text).not.toContain("context sent");
    // And never the old figure.
    expect(text).not.toContain("-149");
  });

  it("never labels an unrecorded unit as tokens", () => {
    const text = formatTokenReport({
      runId: "r",
      unit: null,
      calls: [],
      modelCalls: 0,
      totals: { counted: 0, input: 0, output: 0, secondaryTokens: 0, estimatedInput: 0 },
      share: { output: 0, context: 0, secondary: 0 },
      iterations: [],
      terminal: null,
      artifacts: 0,
      contextExclusions: 0,
      perCompletedIteration: null,
      perDeliverable: null,
    });
    expect(text).toContain("(unit not recorded)");
    expect(text).not.toMatch(/0 tokens over/);
  });
});

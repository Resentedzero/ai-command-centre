/**
 * `agent_performance` projector (`src/projections/agentPerformance.ts`): the rules for
 * samples, groups, tier, retries and per-unit cost, rebuilt from Events; a rebuild is
 * idempotent; and Agent Detail returns the rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";
import { refreshAgentPerformance } from "../../src/projections/agentPerformance.js";

type Ids = { projectId: string; taskDefinitionId: string; agentA: string; agentB: string };
let ids: Ids;
let app: FastifyInstance;

async function event(tx: DrizzleTransaction, runId: string, eventType: string, payload: Record<string, unknown> = {}) {
  await emitEvent(tx, {
    idempotencyKey: `${eventType}:${randomUUID()}`,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null },
    actor: "system",
    producer: "test",
    payload,
    usage: null,
  });
}

async function taskInstance(tx: DrizzleTransaction) {
  const [row] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: ids.taskDefinitionId, taskDefinitionVersion: 1, projectId: ids.projectId, status: "completed" })
    .returning();
  return row!.id;
}

async function run(tx: DrizzleTransaction, taskInstanceId: string, agentDefinitionId: string | null, events: [string, Record<string, unknown>?][]) {
  const [row] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId, agentDefinitionId, agentDefinitionVersion: agentDefinitionId ? 1 : null, status: "completed" })
    .returning();
  for (const [type, payload] of events) await event(tx, row!.id, type, payload);
  return row!.id;
}

const tier = (resultingTier: string): [string, Record<string, unknown>] => ["invocation_started", { resultingTier }];
const consumed = (resourceUnit: string, amount: string): [string, Record<string, unknown>] => ["budget_consumed", { resourceUnit, amount }];

async function rows() {
  const all = await testDb.select().from(schema.agentPerformance);
  return all
    .map((r) => ({
      agent: r.agentDefinitionId === ids.agentA ? "A" : "B",
      tier: r.modelTier,
      samples: r.sampleCount,
      successRate: Number(r.successRate),
      avgRetries: Number(r.avgRetries),
      avgCost: Object.fromEntries(Object.entries(r.avgCost).map(([unit, v]) => [unit, Number(v)])),
    }))
    .sort((x, y) => `${x.agent}${x.tier}`.localeCompare(`${y.agent}${y.tier}`));
}

beforeAll(async () => {
  await resetTestSchema();
  ids = await testDb.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ name: "P" }).returning();
    const [task] = await tx.insert(schema.taskDefinitions).values({ name: "T", kind: "k", version: 1 }).returning();
    const agent = async (name: string) =>
      (await tx.insert(schema.agentDefinitions).values({ name, version: 1, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id;
    return { projectId: project!.id, taskDefinitionId: task!.id, agentA: await agent("A"), agentB: await agent("B") };
  });

  await testDb.transaction(async (tx) => {
    // One Task Instance, a failed Run then a retry that completed, both CHEAP.
    const retried = await taskInstance(tx);
    await run(tx, retried, ids.agentA, [tier("CHEAP"), consumed("usd", "0.02"), consumed("subscription_tokens", "100"), ["run_failed"]]);
    await run(tx, retried, ids.agentA, [tier("CHEAP"), consumed("usd", "0.04"), ["run_completed"]]);
    // No model call: tier "none", no consumption.
    await run(tx, await taskInstance(tx), ids.agentA, [["run_completed"]]);
    // Excluded: halted by an operator, still running, no bound Agent.
    await run(tx, await taskInstance(tx), ids.agentA, [tier("CHEAP"), consumed("usd", "9"), ["run_halted"]]);
    await run(tx, await taskInstance(tx), ids.agentA, [tier("CHEAP")]);
    await run(tx, await taskInstance(tx), null, [tier("CHEAP"), ["run_completed"]]);
    // The Run's tier is its LAST model invocation's.
    await run(tx, await taskInstance(tx), ids.agentB, [tier("CHEAP"), tier("STRONG"), ["run_completed"]]);
    // Governance and operator outcomes are not samples; a human rejection is a failure.
    const failed = (reason: string): [string, Record<string, unknown>?][] => [tier("GATED"), ["invocation_failed", { reason }], ["run_failed"]];
    for (const reason of ["policy_denied", "insufficient_budget", "approval_expired", "interrupted_outcome_unknown", "reauthorization_failed", "resume_spec_mismatch", "execution_stopped"]) {
      await run(tx, await taskInstance(tx), ids.agentB, failed(reason));
    }
    // Free-text reasons that are still not the agent's work, classified by errorCode (a pre-dispatch
    // refusal, a provider refusal that consumed nothing, a context that did not fit its degraded budget,
    // a database error) or by the step-failure prefix, and a Run failed with no Invocation failure.
    for (const errorCode of [
      "policy_denied_before_dispatch",
      "reauthorization_failed_before_dispatch",
      "approval_required_before_dispatch",
      "pre_dispatch_check_failed",
      "quota_exhausted",
      "auth_expired",
      "cli_unavailable",
      "misconfigured",
      "input_too_large",
      "context_budget_exceeded",
      "database_error",
    ]) {
      await run(tx, await taskInstance(tx), ids.agentB, [tier("GATED"), ["invocation_failed", { reason: `free text for ${errorCode}`, errorCode }], ["run_failed"]]);
    }
    await run(tx, await taskInstance(tx), ids.agentB, failed("execution_error: the step builder found ambiguous data"));
    await run(tx, await taskInstance(tx), ids.agentB, [tier("GATED"), ["run_failed", { reason: "execution_error" }]]);
    // A provider failure that may have consumed (timeout, validation) IS the agent's sample.
    await run(tx, await taskInstance(tx), ids.agentB, [tier("GATED"), ["invocation_failed", { reason: "timed out", errorCode: "timeout" }], ["run_failed"]]);
    await run(tx, await taskInstance(tx), ids.agentB, failed("approval_rejected"));
    await run(tx, await taskInstance(tx), ids.agentB, failed("provider returned malformed output"));
    // A Run halted after another terminal event is still excluded.
    await run(tx, await taskInstance(tx), ids.agentB, [tier("HALTED"), ["run_halted"], ["run_failed"]]);
  });

  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("agent_performance", () => {
  it("aggregates terminal, agent-bound, non-halted Runs per Agent version, Task Definition and tier, with cost per unit", async () => {
    await testDb.transaction((tx) => refreshAgentPerformance(tx));
    expect(await rows()).toEqual([
      { agent: "A", tier: "CHEAP", samples: 2, successRate: 0.5, avgRetries: 1, avgCost: { usd: 0.03, subscription_tokens: 50 } },
      { agent: "A", tier: "none", samples: 1, successRate: 1, avgRetries: 0, avgCost: {} },
      { agent: "B", tier: "GATED", samples: 3, successRate: 0, avgRetries: 0, avgCost: {} },
      { agent: "B", tier: "STRONG", samples: 1, successRate: 1, avgRetries: 0, avgCost: {} },
    ]);

    // Stored values are exact decimals without padding.
    const cheap = (await testDb.select().from(schema.agentPerformance)).find((r) => r.modelTier === "CHEAP")!;
    expect(cheap).toMatchObject({ successRate: "0.5", avgRetries: "1", avgCost: { usd: "0.03", subscription_tokens: "50" } });
  });

  it("no migration other than the one creating it reads or writes the table", () => {
    const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    const readers = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !f.startsWith("0015_"))
      .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes("agent_performance"));
    expect(readers).toEqual([]);
  });

  it("is rebuilt from Events: a refresh is idempotent and picks up new Runs", async () => {
    await testDb.transaction((tx) => refreshAgentPerformance(tx));
    const before = await rows();
    await testDb.transaction((tx) => refreshAgentPerformance(tx));
    expect(await rows()).toEqual(before);

    await testDb.transaction(async (tx) => {
      await run(tx, await taskInstance(tx), ids.agentB, [tier("STRONG"), consumed("usd", "1"), ["run_failed"]]);
      await refreshAgentPerformance(tx);
    });
    expect((await rows()).find((r) => r.agent === "B" && r.tier === "STRONG")).toEqual({
      agent: "B",
      tier: "STRONG",
      samples: 2,
      successRate: 0.5,
      avgRetries: 0,
      avgCost: { usd: 0.5 },
    });
  });

  it("GET /agents/:id returns the version's rows", async () => {
    await testDb.transaction((tx) => refreshAgentPerformance(tx));
    const res = await app.inject({ method: "GET", url: `/agents/${ids.agentA}` });
    expect(res.statusCode).toBe(200);
    const { performance } = res.json() as {
      performance: { modelTier: string; sampleCount: number; avgCost: Record<string, string>; eligible: boolean; eligibilityReason: string | null }[];
    };
    // Below N = 10: shown, and marked ineligible by the runtime's own gate.
    expect(performance.map((p) => [p.modelTier, p.sampleCount, p.eligible, p.eligibilityReason])).toEqual([
      ["CHEAP", 2, false, "insufficient_samples"],
      ["none", 1, false, "insufficient_samples"],
    ]);
    expect(Number(performance[0]!.avgCost.usd)).toBe(0.03);
  });
});

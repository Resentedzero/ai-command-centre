/**
 * The retry policy's decision (operator decision D1, 2026-09-15): which failed Runs are
 * retried, the limit of 2 retries (3 Runs), and one-tier escalation after a validation
 * failure, exhausted at STRONG. Pure; the end-to-end behaviour is in
 * `tests/workflow/retries.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";
import { MAX_RUN_ATTEMPTS, RETRY_LIMIT, readRunFailure, retryDecision, type RunFailureFacts } from "../../src/governance/retryPolicy.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

/** A Run with a tool Invocation (seq 1) and an LLM Invocation (seq 2), and its tier floor. */
async function seedRun(tx: DrizzleTransaction, minimumModelTier: string | null) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "active", input: {} })
    .returning();
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "failed", minimumModelTier }).returning();
  const invocation = async (seqNo: number, kind: "tool" | "llm") =>
    (
      await tx
        .insert(schema.invocations)
        .values({ runId: run!.id, seqNo, kind, costClass: kind === "tool" ? "local_tool" : "llm", status: "failed", idempotencyKey: randomUUID() })
        .returning()
    )[0]!;
  return { runId: run!.id, taskInstanceId: taskInstance!.id, tool: await invocation(1, "tool"), llm: await invocation(2, "llm") };
}

async function failed(tx: DrizzleTransaction, run: { runId: string; taskInstanceId: string }, invocationId: string, payload: Record<string, unknown>) {
  await emitEvent(tx, {
    idempotencyKey: `invocation_failed:${invocationId}`,
    eventType: "invocation_failed",
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: run.taskInstanceId, runId: run.runId, invocationId },
    actor: "system",
    producer: "executor",
    payload,
    usage: null,
  });
}

const unknownConsumption: RunFailureFacts = {
  halted: false,
  invocationKind: "llm",
  reason: "provider boom",
  errorCode: null,
  providerConsumption: "unknown",
  lastResultingTier: "CHEAP",
  minimumModelTier: null,
};
const validation: RunFailureFacts = { ...unknownConsumption, errorCode: "schema_validation", reason: "structured-output validation failed" };

describe("retryDecision", () => {
  it("is the operator's limit: 2 retries, 3 Runs in total", () => {
    expect(RETRY_LIMIT).toBe(2);
    expect(MAX_RUN_ATTEMPTS).toBe(3);
    expect(retryDecision(unknownConsumption, 1)).toMatchObject({ retry: true, attempt: 2 });
    expect(retryDecision(unknownConsumption, 2)).toMatchObject({ retry: true, attempt: 3 });
    expect(retryDecision(unknownConsumption, 3)).toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("retries an LLM provider failure of unknown consumption at the same tier floor", () => {
    expect(retryDecision(unknownConsumption, 1)).toEqual({ retry: true, cause: "provider_outcome_unknown", attempt: 2, minimumModelTier: null });
    // An escalated Run that then fails this way keeps its floor.
    expect(retryDecision({ ...unknownConsumption, minimumModelTier: "MID", lastResultingTier: "MID" }, 2)).toEqual({
      retry: true,
      cause: "provider_outcome_unknown",
      attempt: 3,
      minimumModelTier: "MID",
    });
  });

  it("retries an LLM Invocation interrupted by a dead process (its details carry no providerConsumption)", () => {
    const interrupted = { ...unknownConsumption, providerConsumption: null, reason: "interrupted_outcome_unknown" };
    expect(retryDecision(interrupted, 1)).toMatchObject({ retry: true, cause: "provider_outcome_unknown" });
  });

  it.each([
    ["CHEAP", "MID"],
    ["MID", "STRONG"],
  ] as const)("escalates a validation failure at %s to %s", (from, to) => {
    expect(retryDecision({ ...validation, lastResultingTier: from }, 1)).toEqual({
      retry: true,
      cause: "output_validation_failed",
      attempt: 2,
      minimumModelTier: to,
    });
  });

  it("a validation failure at STRONG is exhausted: the Task fails", () => {
    expect(retryDecision({ ...validation, lastResultingTier: "STRONG" }, 1)).toEqual({ retry: false, reason: "escalation_exhausted" });
  });

  it("a validation failure with no recorded tier cannot be escalated", () => {
    expect(retryDecision({ ...validation, lastResultingTier: null }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });

  it.each<[string, Partial<RunFailureFacts>]>([
    ["a Tool Invocation failure", { invocationKind: "tool" }],
    ["a Run with no failed Invocation", { invocationKind: null, providerConsumption: null }],
    ["a provider failure that consumed nothing (expired login, exhausted quota)", { providerConsumption: "none", errorCode: "quota_exhausted" }],
    ["a failure whose reservation was already reconciled", { providerConsumption: null, reason: "persist failed" }],
    ["a Run halted by an operator stop", { halted: true }],
    ["a Policy denial", { providerConsumption: null, reason: "policy_denied" }],
    ["an insufficient budget", { providerConsumption: null, reason: "insufficient_budget" }],
    ["a rejected Approval", { providerConsumption: null, reason: "approval_rejected" }],
    ["a step execution error", { providerConsumption: null, reason: "execution_error: boom" }],
  ])("never retries %s", (_label, change) => {
    expect(retryDecision({ ...unknownConsumption, ...change }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });

  it("a validation error code on a Tool Invocation, or on a halted Run, is not retried either", () => {
    expect(retryDecision({ ...validation, invocationKind: "tool" }, 1)).toEqual({ retry: false, reason: "not_retryable" });
    expect(retryDecision({ ...validation, halted: true }, 1)).toEqual({ retry: false, reason: "not_retryable" });
  });
});

describe("readRunFailure", () => {
  it("reads the Run's LAST failure and its own tier floor", async () => {
    await withRollback(async (tx) => {
      const run = await seedRun(tx, "MID");
      await failed(tx, run, run.tool.id, { reason: "tool boom", errorCode: "tool_error" });
      await failed(tx, run, run.llm.id, { reason: "timeout", errorCode: "timeout", providerConsumption: "unknown" });

      expect(await readRunFailure(tx, run.runId)).toEqual({
        halted: false,
        invocationKind: "llm",
        reason: "timeout",
        errorCode: "timeout",
        providerConsumption: "unknown",
        lastResultingTier: null,
        minimumModelTier: "MID",
      });
    });
  });

  it("a Run whose last failure is its tool's is not retried, even after an earlier LLM failure", async () => {
    await withRollback(async (tx) => {
      const run = await seedRun(tx, null);
      await failed(tx, run, run.llm.id, { reason: "timeout", providerConsumption: "unknown" });
      await failed(tx, run, run.tool.id, { reason: "tool boom" });
      const facts = await readRunFailure(tx, run.runId);
      expect(facts).toMatchObject({ invocationKind: "tool", minimumModelTier: null });
      expect(retryDecision(facts, 1)).toEqual({ retry: false, reason: "not_retryable" });
    });
  });
});

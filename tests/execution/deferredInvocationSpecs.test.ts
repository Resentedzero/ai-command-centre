/**
 * Final-review Finding 4 — the deferred (lazily-resolved) invocation-spec
 * primitive (`PlannedInvocationSpec`/`DeferredInvocationSpec`,
 * `src/execution/types.ts`), and the removal of the capability-side workaround
 * it replaced.
 *
 * Before this primitive, `executeRun` took a static, fully-resolved
 * `InvocationSpec[]`, so a later position could never be built from an earlier
 * position's real Artifact id — Phase 5.8's "a prior Tool Invocation's
 * structured output becomes a new high-priority candidate for the next
 * compilation" was unimplementable. `src/capabilities/researchRetrieve/
 * buildInvocationSpecs.ts` worked around it by calling `executeRun` twice from
 * inside itself and reverting `runs.status` in between to defeat the Executor's
 * own re-entry guard.
 *
 * Provider mocking: same convention as `./executor.test.ts` — only the
 * outermost provider boundary is mocked; `executeRun`, `compileContext`,
 * `authorizeRoute`, `callModel`, `evaluatePolicy` and `reserveBudget` all run
 * for real against the real test database.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type {
  DeferredInvocationSpec,
  DeterministicInvocationSpec,
  InvocationSpecContext,
  PlannedInvocationSpec,
  ToolInvocationSpec,
} from "../../src/execution/types.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  // MANDATORY since Phase 7F made Claude Max the routed default: without this
  // mock these tests would dispatch to the REAL adapter, spawn the Claude CLI,
  // and consume subscription entitlement on every `npm test`.
  callClaudeSubscriptionModel: vi.fn(),
}));

// Phase 9: executeRun yields at each LLM Invocation; this drives it to the next
// real boundary exactly as the production driver does. See the helper's header.
import { executeRunToBoundary as executeRun } from "../helpers/driveToBoundary.js";
import { createStandaloneTaskInstance } from "../../src/execution/taskInstance.js";
import { buildResearchReportInvocationSpecs } from "../../src/capabilities/researchRetrieve/buildInvocationSpecs.js";
import { seedResearchWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import * as compilerModule from "../../src/context/compiler.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Run with an agent binding, an AUTONOMOUS READ grant, and a budget counter — enough for a tool spec followed by an llm spec. */
async function seedRunFixture(tx: DrizzleTransaction): Promise<{
  runId: string;
  capabilityId: string;
  toolBindingId: string;
}> {
  const [capability] = await tx
    .insert(schema.capabilities)
    .values({ name: "cap-" + randomUUID(), staticRiskTag: "low" })
    .returning();
  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 })
    .returning();
  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "tester", objective: "test", instructions: "n/a" })
    .returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
    capabilityId: capability!.id,
    permissions: ["READ"],
    maxTrustLevelRequired: 1,
    autonomyState: "AUTONOMOUS",
  });

  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: taskDefinition!.version,
      projectId: project!.id,
      status: "pending",
      input: {},
    })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({
      taskInstanceId: taskInstance!.id,
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      status: "active",
    })
    .returning();
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    limitAmount: "1000.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });
  // Mirrors production provisioning (`provisionRunBudgets` creates one counter per
  // unit): an independent subscription_tokens counter alongside the USD one, now
  // that Claude Max is the primary candidate. NOT a conversion of the dollar
  // limit — a separate ceiling in a separate unit.
  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: run!.id,
    resourceUnit: "subscription_tokens",
    limitAmount: "200000",
    reservedAmount: "0",
    consumedAmount: "0",
  });

  return { runId: run!.id, capabilityId: capability!.id, toolBindingId: toolBinding!.id };
}

const TOOL_OUTPUT_MARKER = "SENTINEL-TOOL-PAYLOAD-a1b2c3";

function buildToolSpec(capabilityId: string, toolBindingId: string): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "metered_api",
    capabilityId,
    permission: "READ",
    proposedActionSnapshot: { query: "deferred-spec test" },
    toolBindingId,
    estimatedCost: 0.01,
    execute: async () => ({ findings: TOOL_OUTPUT_MARKER }),
  };
}

/** A deterministic spec that produces a real artifact (non-empty result) and counts its executions. */
function buildArtifactProducingSpec(marker: string, counter: { calls: number }): DeterministicInvocationSpec {
  return {
    kind: "deterministic",
    costClass: "deterministic",
    execute: async () => {
      counter.calls += 1;
      return { marker };
    },
  };
}

async function invocationsForRun(tx: DrizzleTransaction, runId: string) {
  return tx.query.invocations.findMany({
    where: eq(schema.invocations.runId, runId),
    orderBy: [asc(schema.invocations.seqNo)],
  });
}

// ---------------------------------------------------------------------------
// (a) A later position is built from an EARLIER position's REAL Artifact id,
//     inside ONE executeRun call.
// ---------------------------------------------------------------------------

describe("deferred spec receives an earlier position's real Artifact id (Phase 5.8)", () => {
  it("resolves the llm spec with the actual artifacts-row id produced by the tool Invocation, in a single executeRun call", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId } = await seedRunFixture(tx);

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
        result: { report: "synthesized" },
        usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
      });
      const compileContextSpy = vi.spyOn(compilerModule, "compileContext");

      let receivedContext: InvocationSpecContext | undefined;
      const llmThunk: DeferredInvocationSpec = async (ctx) => {
        receivedContext = ctx;
        return {
          kind: "llm",
          costClass: "llm",
          intent: "synthesize",
          candidateArtifactIds: ctx.priorArtifacts.filter((a) => a.seqNo === 1).map((a) => a.artifactId),
          candidateToolCapabilityIds: [],
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
          taskDifficulty: "simple",
          riskTier: "low",
          expectedOutputShape: { report: "string" },
        };
      };

      // ONE call. No status revert, no second call.
      const outcome = await executeRun(tx, runId, [buildToolSpec(capabilityId, toolBindingId), llmThunk]);
      expect(outcome).toEqual({ status: "completed", runId });

      // The id the thunk received must be the id of the REAL artifacts row the
      // tool Invocation produced — read back from the database here, never
      // constructed by this test, so a placeholder/fabricated id cannot pass.
      const rows = await invocationsForRun(tx, runId);
      expect(rows).toHaveLength(2);
      const toolInvocation = rows[0]!;
      expect(toolInvocation.kind).toBe("tool");
      const toolArtifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.producingInvocationId, toolInvocation.id),
      });
      expect(toolArtifact).toBeDefined();

      expect(receivedContext).toBeDefined();
      expect(receivedContext!.priorArtifacts).toEqual([
        { seqNo: 1, invocationId: toolInvocation.id, artifactId: toolArtifact!.id },
      ]);

      // ...and it actually reached the Context Compiler as a candidate.
      expect(compileContextSpy).toHaveBeenCalledTimes(1);
      expect(compileContextSpy.mock.calls[0]![1].candidateArtifactIds).toEqual([toolArtifact!.id]);
      compileContextSpy.mockRestore();
    });
  });

  it("carries Artifact IDS only, never content (Phase 5.5 — reference, not inlined content)", async () => {
    await withRollback(async (tx) => {
      const { runId, capabilityId, toolBindingId } = await seedRunFixture(tx);

      let receivedContext: InvocationSpecContext | undefined;
      const inspectThunk: DeferredInvocationSpec = async (ctx) => {
        receivedContext = ctx;
        return { kind: "deterministic", costClass: "deterministic", execute: async () => ({}) };
      };

      const outcome = await executeRun(tx, runId, [buildToolSpec(capabilityId, toolBindingId), inspectThunk]);
      expect(outcome).toEqual({ status: "completed", runId });

      expect(receivedContext!.priorArtifacts).toHaveLength(1);
      // Exactly three id-shaped fields — no inlineContent, no summary, no hash.
      expect(Object.keys(receivedContext!.priorArtifacts[0]!).sort()).toEqual(["artifactId", "invocationId", "seqNo"]);
      // The tool's own output text is genuinely persisted in the artifact row...
      const toolArtifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.id, receivedContext!.priorArtifacts[0]!.artifactId),
      });
      expect(toolArtifact!.inlineContent).toContain(TOOL_OUTPUT_MARKER);
      // ...but none of it leaked into the resolution context.
      expect(JSON.stringify(receivedContext)).not.toContain(TOOL_OUTPUT_MARKER);
    });
  });

  it("attributes each prior Artifact to its producing seqNo/invocation, ordered by seqNo", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRunFixture(tx);
      const first = { calls: 0 };
      const second = { calls: 0 };

      let receivedContext: InvocationSpecContext | undefined;
      const thirdThunk: DeferredInvocationSpec = async (ctx) => {
        receivedContext = ctx;
        return { kind: "deterministic", costClass: "deterministic", execute: async () => ({}) };
      };

      const outcome = await executeRun(tx, runId, [
        buildArtifactProducingSpec("alpha", first),
        buildArtifactProducingSpec("beta", second),
        thirdThunk,
      ]);
      expect(outcome).toEqual({ status: "completed", runId });

      const rows = await invocationsForRun(tx, runId);
      expect(rows.map((r) => r.seqNo)).toEqual([1, 2, 3]);

      // seqNo-keyed, ascending — not positional guesswork, and not dependent on
      // artifacts.created_at (Postgres now() is transaction-stable, so every
      // artifact written in this transaction shares a timestamp).
      expect(receivedContext!.priorArtifacts.map((a) => a.seqNo)).toEqual([1, 2]);
      expect(receivedContext!.priorArtifacts[0]!.invocationId).toBe(rows[0]!.id);
      expect(receivedContext!.priorArtifacts[1]!.invocationId).toBe(rows[1]!.id);

      const betaArtifact = await tx.query.artifacts.findFirst({
        where: eq(schema.artifacts.id, receivedContext!.priorArtifacts[1]!.artifactId),
      });
      expect(betaArtifact!.inlineContent).toBe(JSON.stringify({ marker: "beta" }));
    });
  });
});

// ---------------------------------------------------------------------------
// (c) The Executor's re-entry guards are never defeated by this primitive.
// ---------------------------------------------------------------------------

describe("deferred specs never defeat the Executor's re-entry guard", () => {
  it("a second executeRun call on a completed Run re-executes nothing AND never resolves any thunk", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRunFixture(tx);
      const firstExec = { calls: 0 };
      const secondExec = { calls: 0 };

      const firstThunk = vi.fn(async () => buildArtifactProducingSpec("one", firstExec));
      const secondThunk = vi.fn(async () => buildArtifactProducingSpec("two", secondExec));
      const plan: PlannedInvocationSpec[] = [firstThunk, secondThunk];

      const first = await executeRun(tx, runId, plan);
      expect(first).toEqual({ status: "completed", runId });
      expect(firstThunk).toHaveBeenCalledTimes(1);
      expect(secondThunk).toHaveBeenCalledTimes(1);
      expect(firstExec.calls).toBe(1);
      expect(secondExec.calls).toBe(1);

      const rowsAfterFirst = await invocationsForRun(tx, runId);
      expect(rowsAfterFirst).toHaveLength(2);
      const runAfterFirst = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(runAfterFirst?.status).toBe("completed");

      // The exact shape of the scenario the removed workaround used to create:
      // the same plan, handed to executeRun again on an already-terminal Run.
      const second = await executeRun(tx, runId, plan);
      expect(second).toEqual({ status: "completed", runId });

      // Nothing re-ran, and — the property that fails if a position were
      // resolved BEFORE its existing-row lookup — no thunk was even called.
      expect(firstThunk).toHaveBeenCalledTimes(1);
      expect(secondThunk).toHaveBeenCalledTimes(1);
      expect(firstExec.calls).toBe(1);
      expect(secondExec.calls).toBe(1);
      expect(await invocationsForRun(tx, runId)).toHaveLength(2);
    });
  });

  it("an already-completed position is skipped without resolving its thunk, even when a later position is still pending", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRunFixture(tx);
      const firstExec = { calls: 0 };

      // Phase 1: run position 1 only, so the Run is left mid-plan.
      const firstThunk = vi.fn(async () => buildArtifactProducingSpec("one", firstExec));
      await executeRun(tx, runId, [firstThunk]);
      expect(firstExec.calls).toBe(1);

      // executeRun marked the Run completed after walking the array it was
      // given, so reopen it the way a legitimate resume would arrive — this is
      // the ONLY place in the codebase that still does this, and it is a test
      // fixture, not capability code.
      await tx
        .update(schema.runs)
        .set({ status: "active", completedAt: null, outcome: null })
        .where(eq(schema.runs.id, runId));

      // Phase 2: the full plan. Position 1 is already completed and must be
      // skipped WITHOUT its thunk being resolved a second time; position 2 is
      // fresh and must resolve, seeing position 1's artifact.
      const secondExec = { calls: 0 };
      let receivedContext: InvocationSpecContext | undefined;
      const secondThunk = vi.fn(async (ctx: InvocationSpecContext) => {
        receivedContext = ctx;
        return buildArtifactProducingSpec("two", secondExec);
      });

      const outcome = await executeRun(tx, runId, [firstThunk, secondThunk]);
      expect(outcome).toEqual({ status: "completed", runId });

      expect(firstThunk).toHaveBeenCalledTimes(1); // skipped, never re-resolved
      expect(firstExec.calls).toBe(1); // and never re-executed
      expect(secondThunk).toHaveBeenCalledTimes(1);
      expect(secondExec.calls).toBe(1);
      expect(receivedContext!.priorArtifacts.map((a) => a.seqNo)).toEqual([1]);
    });
  });

  it("a thunk that would throw if ever resolved is never resolved on a completed Run", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedRunFixture(tx);
      const exec = { calls: 0 };

      await executeRun(tx, runId, [buildArtifactProducingSpec("only", exec)]);
      expect(exec.calls).toBe(1);

      const boobyTrap: DeferredInvocationSpec = async () => {
        throw new Error("this thunk must never be resolved on a completed Run");
      };

      // Resolves to {status:"completed"} via the terminal-status short-circuit,
      // without touching position 1 (completed) or position 2 (the trap).
      await expect(executeRun(tx, runId, [boobyTrap, boobyTrap])).resolves.toEqual({ status: "completed", runId });
      expect(exec.calls).toBe(1);
      expect(await invocationsForRun(tx, runId)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// (b) The capability workaround is genuinely gone, not relocated.
// ---------------------------------------------------------------------------

describe("buildResearchReportInvocationSpecs no longer executes anything itself", () => {
  it("creates zero Invocations and leaves runs.status untouched at build time, returning a 3-position plan", async () => {
    await withRollback(async (tx) => {
      const seed = await seedResearchWorkflow(tx);
      const { taskInstanceId } = await createStandaloneTaskInstance(tx, seed.taskDefinitionId, seed.goalId, {
        query: "finding 4 builder purity",
      });
      const [run] = await tx.insert(schema.runs).values({ taskInstanceId, status: "active" }).returning();

      const specs = await buildResearchReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.agentDefinitionId,
          agentDefinitionVersion: seed.agentDefinitionVersion,
          query: "finding 4 builder purity",
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
        },
        { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: 1, taskInstanceId, input: {} }
      );

      // The plan: three deferred positions. The tool position is deferred so a
      // re-drive after it ran never re-resolves the Capability's binding.
      expect(specs).toHaveLength(3);
      expect(typeof specs[0]).toBe("function");
      expect(typeof specs[1]).toBe("function");
      expect(typeof specs[2]).toBe("function");

      // Building it executed NOTHING: no Invocations, and the Run was never
      // driven to "completed" and back to "active" (the removed workaround).
      expect(await invocationsForRun(tx, run!.id)).toHaveLength(0);
      const runRow = await tx.query.runs.findFirst({ where: eq(schema.runs.id, run!.id) });
      expect(runRow?.status).toBe("active");
      expect(runRow?.completedAt).toBeNull();
      expect(runRow?.outcome).toBeNull();

      // It did still provision (Ruling 3) — the one side effect it legitimately owns.
      expect(runRow?.agentDefinitionId).toBe(seed.agentDefinitionId);
      const counter = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scope, "run"), eq(schema.budgetCounters.scopeRefId, run!.id)),
      });
      expect(counter).toBeDefined();
    });
  });

  it("structural: the builder module imports/calls no executeRun and mutates no runs/invocations state", () => {
    const builderPath = fileURLToPath(
      new URL("../../src/capabilities/researchRetrieve/buildInvocationSpecs.ts", import.meta.url)
    );
    const source = readFileSync(builderPath, "utf8");

    // Strip the module header comment: it DESCRIBES the removed workaround.
    const code = source.slice(source.indexOf("*/") + 2);

    expect(code).not.toMatch(/from\s+["'].*execution\/executor.*["']/);
    expect(code).not.toMatch(/executeRun\s*\(/);
    expect(code).not.toMatch(/update\s*\(\s*runs\s*\)/);
    expect(code).not.toMatch(/update\s*\(\s*invocations\s*\)/);
  });
});

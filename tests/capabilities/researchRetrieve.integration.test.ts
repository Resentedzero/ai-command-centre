/**
 * Unit 8 integration test — the FIRST test in this codebase that exercises
 * Units 2-6 together in a real end-to-end scenario (Goal -> Task Instance ->
 * Run -> tool Invocation -> Artifact -> llm Invocation -> Artifact) rather
 * than in isolation. See task-8-report.md for the full design rationale;
 * inline comments here cite the specific brief requirement / pre-dispatch
 * ruling each block satisfies.
 *
 * Provider mocking (Ruling 4): only the provider-call layer
 * (`callAnthropicModel`/`callOpenAiModel`) is mocked, exactly like
 * `tests/router/modelRouter.test.ts` and `tests/execution/executor.test.ts`
 * already do. `authorizeRoute`, `callModel`, `compileContext`,
 * `reserveBudget`, `evaluatePolicy`, and `executeRun` all run for real
 * against the real test database — nothing about the orchestration itself
 * is faked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

// ---------------------------------------------------------------------------
// Mock BOTH provider wrapper modules — this file never calls a real provider
// SDK (no ANTHROPIC_API_KEY/OPENAI_API_KEY is set in this environment, by
// design). Same pattern as tests/router/modelRouter.test.ts and
// tests/execution/executor.test.ts.
// ---------------------------------------------------------------------------
vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));

import { executeRun } from "../../src/execution/executor.js";
import { createStandaloneTaskInstance } from "../../src/execution/taskInstance.js";
import { persistReportArtifact } from "../../src/execution/reportArtifact.js";
import { seedResearchWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "../../src/capabilities/researchRetrieve/capability.js";
import { retrieveResearch } from "../../src/capabilities/researchRetrieve/toolBinding.js";
import { validateCapabilityGrant } from "../../src/governance/policy.js";
import type { CapabilityGrant, CapabilityPermission } from "../../src/governance/policy.js";
import type { LlmInvocationSpec, ToolInvocationSpec } from "../../src/execution/types.js";
import * as compilerModule from "../../src/context/compiler.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";

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
// Fixture helpers
// ---------------------------------------------------------------------------

const RESEARCH_QUERY = "quantum error correction advances";

type Seed = Awaited<ReturnType<typeof seedResearchWorkflow>>;

/**
 * Goal -> Task Instance (Unit 6's `createStandaloneTaskInstance`) -> Run ->
 * budget_counters row (Ruling 1: Unit 8 provisions its own; Unit 6 never
 * does). `limitAmount: "1.00"` is a documented MVP-default budget generous
 * enough for one metered_api tool call (estimatedCost 0.01) plus one
 * CHEAP-tier LLM call (Pass-1 estimate ~= (8_000 + 500) * 0.000001 =
 * 0.0085), leaving ample headroom.
 */
async function setUpStandaloneRun(tx: DrizzleTransaction): Promise<{ seed: Seed; taskInstanceId: string; runId: string }> {
  const seed = await seedResearchWorkflow(tx);

  const { taskInstanceId } = await createStandaloneTaskInstance(tx, seed.taskDefinitionId, seed.goalId, {
    query: RESEARCH_QUERY,
  });

  const [run] = await tx
    .insert(schema.runs)
    .values({
      taskInstanceId,
      agentDefinitionId: seed.agentDefinitionId, // Ruling 2: set directly, no closure workaround needed.
      agentDefinitionVersion: seed.agentDefinitionVersion,
      status: "active", // matches Unit 6's own fixture convention (executor.test.ts).
    })
    .returning();
  const runId = run!.id;

  await tx.insert(schema.budgetCounters).values({
    scope: "run",
    scopeRefId: runId,
    limitAmount: "1.00",
    reservedAmount: "0",
    consumedAmount: "0",
  });

  return { seed, taskInstanceId, runId };
}

function buildToolSpec(seed: Seed, execute?: () => Promise<Record<string, unknown>>): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "metered_api",
    capabilityId: seed.capabilityId,
    permission: "READ" satisfies CapabilityPermission,
    proposedActionSnapshot: { query: RESEARCH_QUERY },
    toolBindingId: seed.toolBindingId,
    estimatedCost: 0.01,
    execute: execute ?? (async () => await retrieveResearch(RESEARCH_QUERY)),
  };
}

function buildLlmSpec(candidateArtifactIds: string[]): LlmInvocationSpec {
  return {
    kind: "llm",
    costClass: "llm",
    intent: "synthesize",
    candidateArtifactIds,
    candidateToolCapabilityIds: [],
    contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
    taskDifficulty: "simple", // Ruling 3
    riskTier: "low", // Ruling 3
    expectedOutputShape: { report: "string" },
  };
}

// ---------------------------------------------------------------------------
// 1. Seeding
// ---------------------------------------------------------------------------

describe("seedResearchWorkflow", () => {
  it("creates the Project/Goal/Agent Definition/Grant/Task Definition rows correctly", async () => {
    await withRollback(async (tx) => {
      const seed = await seedResearchWorkflow(tx);

      const capability = await tx.query.capabilities.findFirst({ where: eq(schema.capabilities.id, seed.capabilityId) });
      expect(capability?.name).toBe(RESEARCH_RETRIEVE_CAPABILITY.id);
      expect(capability?.staticRiskTag).toBe(RESEARCH_RETRIEVE_CAPABILITY.staticRiskTag);
      expect(capability?.costProfile).toEqual(RESEARCH_RETRIEVE_CAPABILITY.costProfile);

      const toolBinding = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, seed.toolBindingId) });
      expect(toolBinding?.capabilityId).toBe(seed.capabilityId);
      expect(toolBinding?.kind).toBe("internal");
      expect(toolBinding?.trustLevel).toBe(2);

      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, seed.projectId) });
      expect(project).toBeDefined();

      const goal = await tx.query.goals.findFirst({ where: eq(schema.goals.id, seed.goalId) });
      expect(goal?.projectId).toBe(seed.projectId);

      const agentDefinition = await tx.query.agentDefinitions.findFirst({
        where: eq(schema.agentDefinitions.id, seed.agentDefinitionId),
      });
      expect(agentDefinition?.name).toBe("Researcher");
      expect(agentDefinition?.version).toBe(seed.agentDefinitionVersion);

      const grant = await tx.query.capabilityGrants.findFirst({
        where: eq(schema.capabilityGrants.id, seed.capabilityGrantId),
      });
      expect(grant?.agentDefinitionId).toBe(seed.agentDefinitionId);
      expect(grant?.capabilityId).toBe(seed.capabilityId);
      expect(grant?.permissions).toEqual(["READ"]);
      expect(grant?.autonomyState).toBe("AUTONOMOUS");
      expect(grant?.revokedAt).toBeNull();

      const taskDefinition = await tx.query.taskDefinitions.findFirst({
        where: eq(schema.taskDefinitions.id, seed.taskDefinitionId),
      });
      expect(taskDefinition?.name).toBe("Research-Report");
      expect(taskDefinition?.defaultContextBudget).toEqual(DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET);
    });
  });

  it("the seeded Grant passes validateCapabilityGrant (READ has no autonomy ceiling)", async () => {
    await withRollback(async (tx) => {
      const seed = await seedResearchWorkflow(tx);
      const grantRow = await tx.query.capabilityGrants.findFirst({
        where: eq(schema.capabilityGrants.id, seed.capabilityGrantId),
      });
      const grant: CapabilityGrant = {
        agentDefinitionId: grantRow!.agentDefinitionId,
        agentDefinitionVersion: grantRow!.agentDefinitionVersion,
        capabilityId: grantRow!.capabilityId,
        permissions: grantRow!.permissions as CapabilityPermission[],
        maxTrustLevelRequired: grantRow!.maxTrustLevelRequired,
        autonomyState: grantRow!.autonomyState as CapabilityGrant["autonomyState"],
      };
      expect(validateCapabilityGrant(grant)).toEqual({ valid: true });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. createStandaloneTaskInstance (Unit 6) — not any Workflow Interpreter path
// ---------------------------------------------------------------------------

describe("createStandaloneTaskInstance for this workflow", () => {
  it("produces a Task Instance with workflow_run_id: null", async () => {
    await withRollback(async (tx) => {
      const seed = await seedResearchWorkflow(tx);
      const { taskInstanceId } = await createStandaloneTaskInstance(tx, seed.taskDefinitionId, seed.goalId, {
        query: RESEARCH_QUERY,
      });
      const row = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) });
      expect(row?.workflowRunId).toBeNull();
      expect(row?.projectId).toBe(seed.projectId);
      expect(row?.input).toEqual({ query: RESEARCH_QUERY });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end: tool Invocation -> Artifact -> llm Invocation -> report
// ---------------------------------------------------------------------------

describe("end-to-end standalone workflow (tool -> artifact -> llm -> report)", () => {
  it(
    "executes the tool Invocation, persists its result as an Artifact BEFORE the llm Invocation runs, " +
      "and the llm Invocation's compileContext call receives that Artifact's ID (not the raw tool return value)",
    async () => {
      await withRollback(async (tx) => {
        const { seed, runId } = await setUpStandaloneRun(tx);

        // --- Phase 1: tool Invocation only (executeRun's own re-entry short-
        // circuit — executor.ts marks the Run "completed" once every spec in
        // the ARRAY IT WAS GIVEN is done — means this must be its own call
        // with only the tool spec; see the module-header discussion in
        // task-8-report.md on why a naive single-array call cannot work here
        // at all: the llm spec's candidateArtifactIds must already contain
        // the artifact id, which does not exist until AFTER this call
        // returns). ---
        const toolExecute = vi.fn(async () => await retrieveResearch(RESEARCH_QUERY));
        const toolSpec = buildToolSpec(seed, toolExecute);

        const phase1 = await executeRun(tx, runId, [toolSpec]);
        expect(phase1).toEqual({ status: "completed", runId });
        expect(toolExecute).toHaveBeenCalledTimes(1);

        const toolInvocation = await tx.query.invocations.findFirst({
          where: and(eq(schema.invocations.runId, runId), eq(schema.invocations.seqNo, 1)),
        });
        expect(toolInvocation?.status).toBe("completed");
        expect(toolInvocation?.kind).toBe("tool");

        // The tool's structured output was persisted as a real, addressable
        // Artifact via Unit 6's persistInvocationResultAsArtifact — not held
        // only as an in-memory JS object.
        const toolArtifact = await tx.query.artifacts.findFirst({
          where: eq(schema.artifacts.producingInvocationId, toolInvocation!.id),
        });
        expect(toolArtifact).toBeDefined();
        const expectedToolResult = await retrieveResearch(RESEARCH_QUERY);
        expect(toolArtifact!.inlineContent).toBe(JSON.stringify(expectedToolResult));

        // Discovered gap (documented in task-8-report.md): executeRun marks
        // runs.status "completed" once it finishes walking ITS OWN
        // invocationSpecs array (executor.ts's final update before
        // returning). A caller doing artifact-mediated two-phase hand-off
        // must revert that itself, or the second executeRun call
        // short-circuits at its own re-entry guard
        // (`if (runRow.status === "completed") return {status:"completed",...}`)
        // before ever looking at seqNo 2. This is Unit 8-owned orchestration
        // bookkeeping, not a change to executor.ts.
        await tx
          .update(schema.runs)
          .set({ status: "active", completedAt: null, outcome: null })
          .where(eq(schema.runs.id, runId));

        // --- Phase 2: llm Invocation, now that the artifact id is known ---
        const compileContextSpy = vi.spyOn(compilerModule, "compileContext");

        vi.mocked(callAnthropicModel).mockResolvedValueOnce({
          result: { report: `Report on: ${RESEARCH_QUERY}` },
          usage: { tokensIn: 120, tokensOut: 80, costAmount: 0.0002 },
        });

        const llmSpec = buildLlmSpec([toolArtifact!.id]);
        // Full array, both specs, matching executeRun's documented
        // resumability contract: seqNo 1 (tool) already has a "completed"
        // invocations row and is skipped without re-execution; seqNo 2 (llm)
        // has no row yet and is processed fresh.
        const phase2 = await executeRun(tx, runId, [toolSpec, llmSpec]);
        expect(phase2).toEqual({ status: "completed", runId });

        // Proves the "completed" skip worked, not a silent re-run of seqNo 1.
        expect(toolExecute).toHaveBeenCalledTimes(1);
        expect(callAnthropicModel).toHaveBeenCalledTimes(1);
        // NOTE (fix-round-1, Important #2 correction): this does NOT by
        // itself prove CHEAP was selected — tierConfig.ts maps BOTH CHEAP
        // and STRONG to provider "anthropic", so this assertion would pass
        // identically even if STRONG had been wrongly selected. It only
        // proves the provider mocks are being exercised as expected (no
        // OpenAI call was made at all). The actual CHEAP-tier proof is the
        // `payload.resultingTier === "CHEAP"` assertion below, read off the
        // real invocation_started event.
        expect(callOpenAiModel).not.toHaveBeenCalled();

        // --- THE critical hand-off assertion (brief's required test): ---
        // compileContext must receive the ARTIFACT's ID in
        // candidateArtifactIds, not retrieveResearch's raw JS return value.
        // This would fail if someone "optimized" the hand-off back into an
        // in-memory pass-through: retrieveResearch returns a plain
        // `{results: [...]}` object, which could never satisfy
        // `candidateArtifactIds: string[]` even by accident, and the id
        // asserted below was read back from a REAL `artifacts` row (queried
        // above), not hand-constructed by this test.
        expect(compileContextSpy).toHaveBeenCalledTimes(1);
        const compileContextInput = compileContextSpy.mock.calls[0]![1];
        expect(compileContextInput.candidateArtifactIds).toEqual([toolArtifact!.id]);
        compileContextSpy.mockRestore();

        const llmInvocation = await tx.query.invocations.findFirst({
          where: and(eq(schema.invocations.runId, runId), eq(schema.invocations.seqNo, 2)),
        });
        expect(llmInvocation?.status).toBe("completed");
        expect(llmInvocation?.kind).toBe("llm");

        // --- Model routing for this workflow resolves to CHEAP (Ruling 3),
        // read off the real event ledger, not a spy. ---
        const routingEvent = await tx.query.events.findFirst({
          where: and(
            eq(schema.events.invocationId, llmInvocation!.id),
            eq(schema.events.eventType, "invocation_started")
          ),
        });
        expect(routingEvent).toBeDefined();
        expect(routingEvent!.payload).toMatchObject({ resultingTier: "CHEAP" });

        const llmResultArtifact = await tx.query.artifacts.findFirst({
          where: eq(schema.artifacts.producingInvocationId, llmInvocation!.id),
        });
        expect(llmResultArtifact).toBeDefined();
        // Unit 6's persistInvocationResultAsArtifact hardcodes type:
        // "invocation_result" for every invocation kind alike (its own
        // header explains why) — it has no type-override parameter. See
        // task-8-report.md's "deviations" section for why the "report"-type
        // artifact below is therefore Unit-8-owned follow-up code rather
        // than a change to that function.
        expect(llmResultArtifact!.type).toBe("invocation_result");

        // --- "report"-type Artifact (brief's required test) ---
        // fix-round-1 (Important #1, independent review): this now calls the
        // real src/-level `persistReportArtifact` helper
        // (src/execution/reportArtifact.ts), not an inline `tx.insert(...)`
        // in the test. Before this fix, the test inserted the "report" row
        // itself and then asserted exactly one such row existed — an
        // assertion that could never fail regardless of what any `src/` code
        // did, since it was only checking for the exact row the test had
        // just inserted. Routing this through a real, reusable production
        // function makes the assertion below actually exercise src/ code.
        const llmResultStructuredOutput = JSON.parse(llmResultArtifact!.inlineContent!) as Record<string, unknown>;
        const { artifactId: reportArtifactId } = await persistReportArtifact(
          tx,
          llmInvocation!.id,
          llmResultStructuredOutput
        );

        const reportArtifactsForRun = await tx
          .select({ id: schema.artifacts.id })
          .from(schema.artifacts)
          .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
          .where(and(eq(schema.invocations.runId, runId), eq(schema.artifacts.type, "report")));
        expect(reportArtifactsForRun.length).toBe(1);
        expect(reportArtifactsForRun[0]!.id).toBe(reportArtifactId);

        const fetchedReport = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, reportArtifactId) });
        expect(fetchedReport?.type).toBe("report"); // referencable by id afterward
        expect(fetchedReport?.producingInvocationId).toBe(llmInvocation!.id);
        expect(fetchedReport?.inlineContent).toBe(JSON.stringify(llmResultStructuredOutput));

        // --- Nothing leaked across the whole 6-unit chain ---
        const finalCounter = await tx.query.budgetCounters.findFirst({
          where: eq(schema.budgetCounters.scopeRefId, runId),
        });
        expect(Number(finalCounter!.reservedAmount)).toBeCloseTo(0, 10);
        // Pins BOTH legs of the chain: tool reconcile (estimatedCost 0.01) +
        // llm reconcile (mocked usage.costAmount 0.0002) = 0.0102. A loose
        // `toBeGreaterThan(0)` would stay green even if one leg's
        // reconcileBudget call were silently skipped — this is the single
        // strongest proof that nothing leaked across the whole 6-unit chain.
        expect(Number(finalCounter!.consumedAmount)).toBeCloseTo(0.0102, 6);

        const finalRun = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
        expect(finalRun?.status).toBe("completed");
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 3b. persistReportArtifact (src/execution/reportArtifact.ts) in isolation
//     (fix-round-1, Important #1: proves the helper itself is correct,
//     independent of the end-to-end test that merely calls it).
// ---------------------------------------------------------------------------

describe("persistReportArtifact in isolation", () => {
  it("creates a type:'report' artifact row with the correct producingInvocationId, content, and hash", async () => {
    await withRollback(async (tx) => {
      const { seed, runId } = await setUpStandaloneRun(tx);
      // Any real invocations row works as the FK target — reuse the tool
      // phase purely to get one cheaply; this test is about the helper's
      // own behavior, not about the end-to-end tool->llm flow.
      const toolSpec = buildToolSpec(seed);
      await executeRun(tx, runId, [toolSpec]);
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });

      const structuredOutput = { report: "isolated helper test content" };
      const { artifactId } = await persistReportArtifact(tx, invocation!.id, structuredOutput);

      const row = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, artifactId) });
      const expectedJson = JSON.stringify(structuredOutput);
      expect(row?.type).toBe("report");
      expect(row?.producingInvocationId).toBe(invocation!.id);
      expect(row?.inlineContent).toBe(expectedJson);
      expect(row?.version).toBe(1);
      expect(row?.size).toBe(Buffer.byteLength(expectedJson, "utf8"));
      expect(row?.hash).toBe(createHash("sha256").update(expectedJson).digest("hex"));
    });
  });

  it("two calls with different structured output produce two distinct 'report' artifact rows (not a shared/cached one)", async () => {
    await withRollback(async (tx) => {
      const { seed, runId } = await setUpStandaloneRun(tx);
      const toolSpec = buildToolSpec(seed);
      await executeRun(tx, runId, [toolSpec]);
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });

      const first = await persistReportArtifact(tx, invocation!.id, { report: "first" });
      const second = await persistReportArtifact(tx, invocation!.id, { report: "second" });

      expect(first.artifactId).not.toBe(second.artifactId);
      const rows = await tx.query.artifacts.findMany({ where: eq(schema.artifacts.type, "report") });
      expect(rows.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Negative control — proves the hand-off test isn't vacuously passing
//    (Codex reviewability note: "confirms the artifact-mediated hand-off
//    test actually fails if the persistence step is skipped").
// ---------------------------------------------------------------------------

describe("negative control: artifact-mediated hand-off is load-bearing", () => {
  it("a candidateArtifactIds entry that never resolved to a persisted artifacts row (simulating a skipped persistence step) fails the llm Invocation via a real compileContext throw", async () => {
    await withRollback(async (tx) => {
      const { runId } = await setUpStandaloneRun(tx);
      const neverPersistedArtifactId = randomUUID(); // stands in for "persistence was skipped"

      // Deliberately NOT queueing a mockResolvedValueOnce here: compileContext
      // throws before callModel is ever reached, so nothing should consume a
      // queued value. Queueing one anyway would leak into a LATER test via
      // `vi.clearAllMocks()` (mockClear, not mockReset — queued
      // once-implementations survive it), same pattern executor.test.ts's
      // {authorized:false} test avoids.
      const llmSpec = buildLlmSpec([neverPersistedArtifactId]);
      const outcome = await executeRun(tx, runId, [llmSpec]);

      expect(outcome).toEqual({ status: "failed", runId });
      expect(callAnthropicModel).not.toHaveBeenCalled(); // compileContext throws before callModel is ever reached

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runId) });
      expect(invocation?.status).toBe("failed");
      const failedEvent = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failedEvent?.payload).toMatchObject({
        reason: expect.stringContaining("does not resolve to a persisted row"),
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Structural: capability.ts stays provider-agnostic
// ---------------------------------------------------------------------------

describe("structural: capability.ts contains no reference to the concrete implementation in toolBinding.ts", () => {
  it("has no import of toolBinding.ts and no mention of its function name or implementation details", () => {
    const capabilityPath = fileURLToPath(
      new URL("../../src/capabilities/researchRetrieve/capability.ts", import.meta.url)
    );
    const source = readFileSync(capabilityPath, "utf8");
    expect(source).not.toMatch(/from\s+["'].*toolBinding.*["']/);
    expect(source).not.toMatch(/toolBinding/i);
    expect(source).not.toMatch(/retrieveResearch/);
    expect(source).not.toMatch(/deterministic|synthesized|search api/i);
  });
});

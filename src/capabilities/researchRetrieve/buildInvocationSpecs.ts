/**
 * `buildResearchReportInvocationSpecs` — a real, reusable
 * `InvocationSpecBuilder`-shaped builder (Unit 9, Ruling 1) for the
 * "Research-Report" Task Definition (Unit 8's, reused verbatim — see
 * `src/definitions/seed.ts`'s `seedResearchWorkflow`) when it runs as
 * Workflow 2's step 0, driven by Unit 7's `advanceWorkflowRun`.
 *
 * Builds the exact `[toolSpec, llmSpec]` pair Unit 8's own integration test
 * built inline (tool: `research.retrieve` via `retrieveResearch`; llm:
 * `intent: "synthesize"`, `riskTier: "low"`, `taskDifficulty: "simple"`,
 * `candidateArtifactIds` populated with the tool step's Artifact) — but as
 * real, reusable production code rather than test-only inline logic.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Confirmation of the report contract's central question: Unit 8's
 * "two-phase executeRun" hand-off gap (task-8-report.md) STILL APPLIES here,
 * verified directly against `executor.ts`'s current code — the llm spec's
 * `candidateArtifactIds` must contain a real, persisted Artifact id, which
 * does not exist until the tool spec has actually executed, and
 * `executeRun` processes a given `invocationSpecs` array in one synchronous
 * walk with no gap to look anything up in between.
 *
 * Unlike Unit 8's standalone test, THIS module has no ability to call
 * `executeRun` twice from "outside": `advanceWorkflowRun`'s
 * `createAndRunStep`/`resumeStep` call `buildInvocationSpecs` exactly ONCE,
 * then call `executeRun` exactly ONCE with whatever this function returns
 * (`src/workflow/interpreter.ts`). So this function performs BOTH phases
 * ITSELF, internally, before ever returning:
 *   1. `executeRun(tx, runId, [toolSpec])` — runs the tool step alone.
 *   2. Reset `runs.status` back to `"active"` (Unit 8's own discovered
 *      requirement: `executeRun` marks the run "completed" once it finishes
 *      walking the array IT WAS GIVEN, which would make a second call
 *      short-circuit at the top before ever looking at seqNo 2).
 *   3. `executeRun(tx, runId, [toolSpec, llmSpec])`, now that the tool
 *      Artifact's real id is known — seqNo 1 already has a "completed" row
 *      and is skipped without re-execution (`executeRun`'s own documented
 *      resumability contract); seqNo 2 (llm) is processed fresh.
 *   4. `persistReportArtifact` (Unit 8's helper, reused verbatim, NOT
 *      duplicated) on the llm invocation's structured output.
 *   5. Return `[toolSpec, llmSpec]` WITHOUT resetting `runs.status` again —
 *      the run is genuinely, correctly "completed" at this point (both
 *      invocations done). The OUTER `executeRun` call
 *      `advanceWorkflowRun`/`createAndRunStep` makes immediately after this
 *      function returns then hits its own top-of-function re-entry guard
 *      (`if (runRow.status === "completed") return {status:"completed",...}`)
 *      and returns the correct outcome without re-walking anything. So the
 *      full picture is: two REAL internal `executeRun` calls here, plus one
 *      harmless no-op short-circuit call made by the interpreter itself.
 *
 * Idempotency (Ruling 3's determinism requirement): this Task Definition
 * never reaches `awaiting_approval` under this seed (`research.retrieve`'s
 * Grant is `AUTONOMOUS`; llm Invocations are never Approval-gated), so
 * `advanceWorkflowRun` never actually calls this builder a second time for
 * the same step in normal operation. It is still made defensively safe to
 * call again: if seqNo 2 already has a `"completed"` invocation row, this
 * function returns `[toolSpec, llmSpec]` immediately without repeating
 * either internal `executeRun` call, resetting `runs.status`, or calling
 * `persistReportArtifact` a second time (which is NOT itself idempotent —
 * see its own module header/tests — a second call would create a second,
 * duplicate `"report"`-type Artifact row, corrupting Task B's Ruling-2
 * cross-step lookup, which requires exactly one such row per Run).
 */
import { and, eq } from "drizzle-orm";
import { artifacts, invocations, runs } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { executeRun } from "../../execution/executor.js";
import { persistReportArtifact } from "../../execution/reportArtifact.js";
import type { InvocationSpec, LlmInvocationSpec, ToolInvocationSpec } from "../../execution/types.js";
import type { ContextBudget } from "../../context/types.js";
import { bindRunAgent, ensureRunBudgetCounter, findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { retrieveResearch } from "./toolBinding.js";

export type ResearchReportBuilderConfig = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  capabilityId: string;
  toolBindingId: string;
  query: string;
  contextBudget: ContextBudget;
  /** MVP default "1.00" (matches Unit 8's own fixture convention) — generous headroom for one metered_api call plus one CHEAP-tier llm call. */
  runBudgetLimit?: string;
};

export type BuilderParams = {
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  taskInstanceId: string;
  input: Record<string, unknown>;
};

function buildToolSpec(config: ResearchReportBuilderConfig): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "metered_api",
    capabilityId: config.capabilityId,
    permission: "READ",
    proposedActionSnapshot: { query: config.query },
    toolBindingId: config.toolBindingId,
    estimatedCost: 0.01,
    execute: async () => await retrieveResearch(config.query),
  };
}

async function buildLlmSpecFromToolArtifact(
  tx: DrizzleTransaction,
  runId: string,
  config: ResearchReportBuilderConfig
): Promise<LlmInvocationSpec> {
  const toolInvocation = await tx.query.invocations.findFirst({
    where: and(eq(invocations.runId, runId), eq(invocations.seqNo, 1)),
  });
  if (!toolInvocation) {
    throw new Error(`buildResearchReportInvocationSpecs: no seqNo=1 (tool) invocation found for run "${runId}"`);
  }
  const toolArtifact = await tx.query.artifacts.findFirst({
    where: eq(artifacts.producingInvocationId, toolInvocation.id),
  });
  if (!toolArtifact) {
    throw new Error(`buildResearchReportInvocationSpecs: no Artifact found for tool invocation "${toolInvocation.id}"`);
  }

  return {
    kind: "llm",
    costClass: "llm",
    intent: "synthesize",
    candidateArtifactIds: [toolArtifact.id],
    candidateToolCapabilityIds: [],
    contextBudget: config.contextBudget,
    taskDifficulty: "simple",
    riskTier: "low",
    expectedOutputShape: { report: "string" },
  };
}

export async function buildResearchReportInvocationSpecs(
  tx: DrizzleTransaction,
  config: ResearchReportBuilderConfig,
  params: BuilderParams
): Promise<InvocationSpec[]> {
  const runRow = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const runId = runRow.id;

  // Ruling 3: agent-binding + budget provisioning are this builder's job.
  await bindRunAgent(tx, runId, config.agentDefinitionId, config.agentDefinitionVersion);
  await ensureRunBudgetCounter(tx, runId, config.runBudgetLimit ?? "1.00");

  const toolSpec = buildToolSpec(config);

  // Idempotency guard (see module header) — do not redo the two-phase dance
  // or re-persist the report Artifact if this builder is somehow called
  // again after already fully completing.
  const existingCompletedLlmInvocation = await tx.query.invocations.findFirst({
    where: and(eq(invocations.runId, runId), eq(invocations.seqNo, 2), eq(invocations.status, "completed")),
  });
  if (existingCompletedLlmInvocation) {
    const llmSpec = await buildLlmSpecFromToolArtifact(tx, runId, config);
    return [toolSpec, llmSpec];
  }

  // --- Phase 1: tool Invocation alone ---
  const toolOutcome = await executeRun(tx, runId, [toolSpec]);
  if (toolOutcome.status !== "completed") {
    // Failed (or, structurally impossible for this Grant, awaiting_approval)
    // — the outer executeRun call will observe the Run's terminal status and
    // short-circuit; nothing further to build.
    return [toolSpec];
  }

  const llmSpec = await buildLlmSpecFromToolArtifact(tx, runId, config);

  // Unit 8's discovered gap (see module header): revert executeRun's own
  // "completed" write before the second internal call, or it would
  // short-circuit at its own top-of-function re-entry guard.
  await tx.update(runs).set({ status: "active", completedAt: null, outcome: null }).where(eq(runs.id, runId));

  // --- Phase 2: llm Invocation, now that the tool Artifact id is known ---
  const llmOutcome = await executeRun(tx, runId, [toolSpec, llmSpec]);
  if (llmOutcome.status !== "completed") {
    return [toolSpec, llmSpec];
  }

  const llmInvocation = await tx.query.invocations.findFirst({
    where: and(eq(invocations.runId, runId), eq(invocations.seqNo, 2)),
  });
  if (!llmInvocation) {
    throw new Error(`buildResearchReportInvocationSpecs: no seqNo=2 (llm) invocation found for run "${runId}"`);
  }
  const llmResultArtifact = await tx.query.artifacts.findFirst({
    where: eq(artifacts.producingInvocationId, llmInvocation.id),
  });
  if (!llmResultArtifact?.inlineContent) {
    throw new Error(`buildResearchReportInvocationSpecs: no result Artifact found for llm invocation "${llmInvocation.id}"`);
  }
  const structuredOutput = JSON.parse(llmResultArtifact.inlineContent) as Record<string, unknown>;
  await persistReportArtifact(tx, llmInvocation.id, structuredOutput);

  // Deliberately NOT resetting runs.status again — see module header step 5.
  return [toolSpec, llmSpec];
}

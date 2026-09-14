/**
 * `buildResearchReportInvocationSpecs` — a real, reusable
 * `InvocationSpecBuilder`-shaped builder (Unit 9, Ruling 1) for the
 * "Research-Report" Task Definition (Unit 8's, reused verbatim — see
 * `src/definitions/seed.ts`'s `seedResearchWorkflow`) when it runs as
 * Workflow 2's step 0, driven by Unit 7's `advanceWorkflowRun`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FINAL-REVIEW FINDING 4 — this builder no longer executes anything itself.
 * ═══════════════════════════════════════════════════════════════════════
 * It previously called `executeRun` TWICE from inside itself and, between the
 * two calls, reverted the Executor's own terminal lifecycle state
 * (`tx.update(runs).set({status: "active", completedAt: null, outcome: null})`)
 * so `executeRun`'s top-of-function re-entry guard would not short-circuit the
 * second call — a capability module reaching into core runtime state to defeat
 * a safety guard, and relying on the Interpreter's own `executeRun` call
 * degrading to a no-op afterwards.
 *
 * The root cause was a missing Executor primitive, not a mistake here: the llm
 * spec's `candidateArtifactIds` must contain a REAL, persisted Artifact id,
 * which does not exist until the tool spec has actually executed — yet
 * `executeRun` took a static, fully-resolved `InvocationSpec[]` computed before
 * any position ran. That primitive now exists
 * (`DeferredInvocationSpec`/`PlannedInvocationSpec`,
 * `../../execution/types.ts`), so this module is PURELY DECLARATIVE: it
 * provisions, then returns a three-position plan and returns. Every Invocation
 * is executed exactly once, by the ONE `executeRun` call the Workflow
 * Interpreter makes.
 *
 * The plan (`seqNo` = array position + 1):
 *   1. `"tool"` — `research.retrieve`, fulfilled by whichever Tool Binding the
 *      Capability currently has (`../toolAdapters.ts`). Deferred although it
 *      depends on nothing earlier, so the binding is resolved only if the tool
 *      has not run yet.
 *   2. `"llm"` — DEFERRED. `intent: "synthesize"`, `riskTier: "low"`,
 *      `taskDifficulty: "simple"`, with `candidateArtifactIds` populated from
 *      seqNo 1's ACTUAL Artifact id, supplied by the Executor at resolution
 *      time. This is Phase 5.8 exactly ("a prior Tool Invocation's structured
 *      output becomes a new high-priority candidate for the next
 *      compilation"), and Phase 5.5 exactly (an ID REFERENCE — the Context
 *      Compiler, not this module, decides whether any content gets inlined).
 *   3. `"deterministic"` — DEFERRED. Marks seqNo 2's output as this Run's
 *      final, addressable `"report"` Artifact via `persistReportArtifact`
 *      (Unit 8's helper, reused verbatim, NOT duplicated). This used to be a
 *      side effect of the builder, invisible to the event ledger; as a real
 *      Deterministic Invocation it is a first-class member of the Run's
 *      ordered sequence, which is what Phase 3a describes ("Deterministic
 *      function: free, no governance overhead beyond existence check" —
 *      precisely what `processGenericSpec` does). Task B's cross-step lookup
 *      (`../publishReport/buildInvocationSpecs.ts`) requires exactly one such
 *      Artifact per Run.
 *
 * Idempotency (Ruling 3's determinism requirement): the hand-rolled guard this
 * module used to carry is GONE, and deliberately not ported. It existed only
 * because execution had been pulled up into build time, which made the
 * non-idempotent `persistReportArtifact` reachable twice. Now that every
 * Invocation runs inside `executeRun`, that unit's own per-`seqNo` skip
 * ("already `completed` -> continue", `../../execution/executor.ts`) is the
 * single, canonical guard — and it skips a completed position WITHOUT even
 * resolving its thunk, so `persistReportArtifact` cannot run twice. Building
 * the plan is now free of side effects beyond `bindRunAgent`/
 * `provisionRunBudgets`, both idempotent by design (see
 * `../shared/runProvisioning.ts`).
 */
import { eq } from "drizzle-orm";
import { artifacts } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { persistReportArtifact } from "../../execution/reportArtifact.js";
import type {
  DeferredInvocationSpec,
  DeterministicInvocationSpec,
  InvocationSpecContext,
  LlmInvocationSpec,
  PlannedInvocationSpec,
  ToolInvocationSpec,
} from "../../execution/types.js";
import type { ContextBudget } from "../../context/types.js";
import { bindRunAgent, findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { provisionRunBudgets } from "../../governance/runBudgetPolicy.js";
import { resolveToolInvocation } from "../toolAdapters.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "./capability.js";

/**
 * This plan's fixed shape. Positions are selected by `seqNo`, never by index
 * into `ctx.priorArtifacts` — see `PriorInvocationArtifact`'s doc comment for
 * why creation-time/positional selection is unsafe here.
 */
const TOOL_SEQ_NO = 1;
const LLM_SEQ_NO = 2;

export type ResearchReportBuilderConfig = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  query: string;
  contextBudget: ContextBudget;
};

export type BuilderParams = {
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  taskInstanceId: string;
  input: Record<string, unknown>;
};

/** seqNo 1: the Capability's current Tool Binding decides what runs (`../toolAdapters.ts`). */
async function buildToolSpec(tx: DrizzleTransaction, config: ResearchReportBuilderConfig): Promise<ToolInvocationSpec> {
  return await resolveToolInvocation(tx, {
    capabilityName: RESEARCH_RETRIEVE_CAPABILITY.id,
    permission: "READ",
    proposedActionSnapshot: { query: config.query },
  });
}

/**
 * seqNo 2, deferred: the llm spec, built from the tool Invocation's REAL
 * Artifact id. Fails closed if the Executor hands over a context with no
 * artifact from seqNo 1 — that would mean the tool step produced nothing, and
 * synthesizing from an empty candidate set would silently produce a report
 * about nothing rather than an error.
 */
function buildLlmSpec(config: ResearchReportBuilderConfig, ctx: InvocationSpecContext): LlmInvocationSpec {
  const toolArtifactIds = ctx.priorArtifacts.filter((a) => a.seqNo === TOOL_SEQ_NO).map((a) => a.artifactId);
  if (toolArtifactIds.length === 0) {
    throw new Error(
      `buildResearchReportInvocationSpecs: no Artifact produced by seqNo ${TOOL_SEQ_NO} (the research.retrieve tool ` +
        "Invocation) was available when building the llm spec (fail closed)."
    );
  }

  return {
    kind: "llm",
    costClass: "llm",
    intent: "synthesize",
    // Phase 5.5: an ID REFERENCE. compileContext decides reference-vs-content.
    candidateArtifactIds: toolArtifactIds,
    candidateToolCapabilityIds: [],
    contextBudget: config.contextBudget,
    taskDifficulty: "simple",
    riskTier: "low",
    expectedOutputShape: { report: "string" },
  };
}

/**
 * seqNo 3, deferred: marks the llm Invocation's output as this Run's final
 * `"report"` Artifact.
 *
 * `producingInvocationId` is deliberately the LLM Invocation's id, NOT this
 * deterministic Invocation's own — the artifact IS the llm's output, marked
 * final, and attributing it elsewhere would change its meaning (and break the
 * `producingInvocationId` assertion in
 * `tests/capabilities/researchRetrieve.integration.test.ts`).
 *
 * `execute` returns `{}` so `processGenericSpec`'s
 * `Object.keys(result).length > 0` check skips persisting a redundant
 * `"invocation_result"` Artifact for this bookkeeping step — the Run's artifact
 * set stays exactly what it was before Finding 4's fix.
 */
function buildReportSpec(tx: DrizzleTransaction, ctx: InvocationSpecContext): DeterministicInvocationSpec {
  const llmArtifact = ctx.priorArtifacts.find((a) => a.seqNo === LLM_SEQ_NO);
  if (!llmArtifact) {
    throw new Error(
      `buildResearchReportInvocationSpecs: no Artifact produced by seqNo ${LLM_SEQ_NO} (the llm Invocation) was ` +
        "available when building the report spec (fail closed)."
    );
  }

  return {
    kind: "deterministic",
    costClass: "deterministic",
    execute: async () => {
      const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, llmArtifact.artifactId) });
      if (!row?.inlineContent) {
        throw new Error(
          `buildResearchReportInvocationSpecs: llm Artifact "${llmArtifact.artifactId}" has no inlineContent to publish as a report.`
        );
      }
      const structuredOutput = JSON.parse(row.inlineContent) as Record<string, unknown>;
      await persistReportArtifact(tx, llmArtifact.invocationId, structuredOutput);
      return {};
    },
  };
}

export async function buildResearchReportInvocationSpecs(
  tx: DrizzleTransaction,
  config: ResearchReportBuilderConfig,
  params: BuilderParams
): Promise<PlannedInvocationSpec[]> {
  const runRow = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const runId = runRow.id;

  // Ruling 3: agent-binding + budget provisioning are this builder's job — the
  // only hook available after the `runs` row exists and before `executeRun`
  // authorizes anything (see `../shared/runProvisioning.ts`). Both idempotent.
  await bindRunAgent(tx, runId, config.agentDefinitionId, config.agentDefinitionVersion);
  // Governance owns the ceilings; this builder can request provisioning for its
  // Run but cannot choose, raise, or pass a limit (Phase 8).
  await provisionRunBudgets(tx, runId);

  // Deferred too: the Executor resolves a position only when it still needs
  // processing, so a re-drive after the tool already ran never re-resolves the
  // Capability's binding (which may have been replaced since).
  const toolSpec: DeferredInvocationSpec = async () => buildToolSpec(tx, config);
  const llmSpec: DeferredInvocationSpec = async (ctx) => buildLlmSpec(config, ctx);
  const reportSpec: DeferredInvocationSpec = async (ctx) => buildReportSpec(tx, ctx);

  // Fixed length, fixed order, decided here and now — nothing below can change
  // how many Invocations this Run has, only what each position contains.
  return [toolSpec, llmSpec, reportSpec];
}

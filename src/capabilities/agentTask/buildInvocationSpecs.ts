/**
 * `agent_task` (V1.1): a general workflow step. The step's Agent does one piece of
 * writing work from the workflow author's instruction and the earlier outputs the step
 * explicitly takes as inputs, and produces a `deliverable`.
 *
 *   1. llm (intent `write`): agent instructions (Compiler layer 1), the Goal (task
 *      state), the step instruction as a trusted directive, the input Artifacts as
 *      candidates (fenced as untrusted data), `DELIVERABLE_OUTPUT_SCHEMA`. Tier from the
 *      Agent's execution profile; provider restriction passed to the Router.
 *   2. deterministic, deferred: persists position 1's output as the `deliverable`, with
 *      the evidence basis recorded by code.
 *
 * Fixed length; the Router, Budget Governor, stops and events govern it like any step.
 */
import { eq } from "drizzle-orm";
import { artifacts } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import type { ContextBudget } from "../../context/types.js";
import type { DeferredInvocationSpec, LlmInvocationSpec, PlannedInvocationSpec } from "../../execution/types.js";
import type { LinearGraphDefinition } from "../../workflow/graphTypes.js";
import { TIER_DIFFICULTY, type ExecutionProfile } from "../../definitions/executionProfile.js";
import { findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { resolveStepInputArtifacts, validateStepInputs, type StepInput } from "../shared/stepInputs.js";
import { DELIVERABLE_DIRECTIVE, DELIVERABLE_OUTPUT_SCHEMA, evidenceBasisFor, persistDeliverableArtifact } from "../shared/deliverable.js";

export const MAX_INSTRUCTION_CHARS = 4_000;
const LLM_SEQ_NO = 1;

export type AgentTaskParameters = { instruction: string; inputs: StepInput[] };

export function validateAgentTaskStep(ctx: { parameters: Record<string, unknown>; graph: LinearGraphDefinition; stepIndex: number }): string | null {
  const extra = Object.keys(ctx.parameters).filter((k) => k !== "instruction" && k !== "inputs");
  if (extra.length > 0) return `unknown parameter(s): ${extra.join(", ")}.`;
  const instruction = ctx.parameters.instruction;
  if (typeof instruction !== "string" || instruction.trim() === "" || instruction.length > MAX_INSTRUCTION_CHARS) {
    return `"instruction" must be 1 to ${MAX_INSTRUCTION_CHARS} characters.`;
  }
  const inputs = validateStepInputs(ctx.parameters.inputs, ctx.graph, ctx.stepIndex);
  return inputs.ok ? null : inputs.reason;
}

export async function buildAgentTaskInvocationSpecs(
  tx: DrizzleTransaction,
  config: { parameters: AgentTaskParameters; contextBudget: ContextBudget; profile: ExecutionProfile },
  params: { taskInstanceId: string }
): Promise<PlannedInvocationSpec[]> {
  const run = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const inputs = await resolveStepInputArtifacts(tx, params.taskInstanceId, config.parameters.inputs);

  const llm: LlmInvocationSpec = {
    kind: "llm",
    costClass: "llm",
    intent: "write",
    directive: `${DELIVERABLE_DIRECTIVE}\n\nStep instruction from the workflow author:\n${config.parameters.instruction}`,
    candidateArtifactIds: inputs.map((i) => i.artifactId),
    candidateToolCapabilityIds: [],
    contextBudget: config.contextBudget,
    taskDifficulty: TIER_DIFFICULTY[config.profile.preferredTier ?? "MID"],
    riskTier: "low",
    expectedOutputShape: DELIVERABLE_OUTPUT_SCHEMA,
    ...(config.profile.provider ? { requiredProvider: config.profile.provider } : {}),
  };

  const persist: DeferredInvocationSpec = async (ctx) => {
    const written = ctx.priorArtifacts.find((a) => a.seqNo === LLM_SEQ_NO);
    if (!written) throw new Error("agent_task: the writing step produced no output (fail closed).");
    return {
      kind: "deterministic",
      costClass: "deterministic",
      execute: async () => {
        const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, written.artifactId) });
        const output = JSON.parse(row?.inlineContent ?? "null") as Record<string, unknown> | null;
        if (!output || typeof output !== "object") throw new Error("agent_task: the writing step's output is not an object (fail closed).");
        const basis = await evidenceBasisFor(tx, [run.id], inputs.map((i) => i.artifactId));
        await persistDeliverableArtifact(tx, written.invocationId, output, { basis });
        return {};
      },
    };
  };

  return [llm, persist];
}

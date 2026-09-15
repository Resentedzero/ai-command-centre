/**
 * `operator_checkpoint` (V1.1): an explicit approval-gate step. One Tool Invocation of
 * `review.checkpoint` whose snapshot pins the question and the exact outputs of the
 * earlier steps it gates (id and hash), so the Approval is for those bytes. The first
 * pinned output is also the snapshot's `artifactId`/`artifactHash`, which the Approvals
 * queue already previews with a hash check.
 *
 * Fails closed unless the step's Agent version holds `review.checkpoint` with EXECUTE
 * at `ALWAYS_APPROVE`: checked when the workflow is saved and again when it runs.
 */
import { and, eq, isNull } from "drizzle-orm";
import { capabilities, capabilityGrants } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import type { InvocationSpec } from "../../execution/types.js";
import type { LinearGraphDefinition } from "../../workflow/graphTypes.js";
import { resolveToolInvocation } from "../toolAdapters.js";
import { resolveStepInputArtifacts, validateStepInputs, type StepInput } from "../shared/stepInputs.js";
import { REVIEW_CHECKPOINT_CAPABILITY, REVIEW_CHECKPOINT_PERMISSION } from "./capability.js";

const MAX_QUESTION_CHARS = 2_000;

/** Why the Agent cannot gate, or null when it holds the capability at ALWAYS_APPROVE only. */
export async function gateGrantProblem(tx: DrizzleTransaction, agentDefinitionId: string, agentDefinitionVersion: number): Promise<string | null> {
  const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, REVIEW_CHECKPOINT_CAPABILITY.id) });
  if (!capability) return `the "${REVIEW_CHECKPOINT_CAPABILITY.id}" capability is not registered`;
  const grants = (
    await tx.query.capabilityGrants.findMany({
      where: and(
        eq(capabilityGrants.agentDefinitionId, agentDefinitionId),
        eq(capabilityGrants.agentDefinitionVersion, agentDefinitionVersion),
        eq(capabilityGrants.capabilityId, capability.id),
        isNull(capabilityGrants.revokedAt)
      ),
    })
  ).filter((g) => g.permissions.includes(REVIEW_CHECKPOINT_PERMISSION));
  if (grants.length === 0) return `the step's agent must hold "${REVIEW_CHECKPOINT_CAPABILITY.id}" (${REVIEW_CHECKPOINT_PERMISSION})`;
  if (grants.some((g) => g.autonomyState !== "ALWAYS_APPROVE")) {
    return `an approval gate's "${REVIEW_CHECKPOINT_CAPABILITY.id}" grant must be ALWAYS_APPROVE, so the gate always asks`;
  }
  return null;
}

export type CheckpointParameters = { question: string; inputs: StepInput[] };

export async function validateCheckpointStep(
  tx: DrizzleTransaction,
  ctx: { parameters: Record<string, unknown>; graph: LinearGraphDefinition; stepIndex: number; agentDefinitionId: string; agentDefinitionVersion: number }
): Promise<string | null> {
  const extra = Object.keys(ctx.parameters).filter((k) => k !== "question" && k !== "inputs");
  if (extra.length > 0) return `unknown parameter(s): ${extra.join(", ")}.`;
  const q = ctx.parameters.question;
  if (typeof q !== "string" || q.trim() === "" || q.length > MAX_QUESTION_CHARS) return `"question" must be 1 to ${MAX_QUESTION_CHARS} characters.`;
  const inputs = validateStepInputs(ctx.parameters.inputs, ctx.graph, ctx.stepIndex);
  if (!inputs.ok) return inputs.reason;
  if (inputs.inputs.length === 0) return "an approval gate must pin at least one earlier step's output (inputs).";
  return gateGrantProblem(tx, ctx.agentDefinitionId, ctx.agentDefinitionVersion);
}

export async function buildCheckpointInvocationSpecs(
  tx: DrizzleTransaction,
  config: { agentDefinitionId: string; agentDefinitionVersion: number; parameters: CheckpointParameters },
  params: { taskInstanceId: string }
): Promise<InvocationSpec[]> {
  const problem = await gateGrantProblem(tx, config.agentDefinitionId, config.agentDefinitionVersion);
  if (problem) throw new Error(`operator_checkpoint: ${problem} (fail closed).`);
  const resolved = await resolveStepInputArtifacts(tx, params.taskInstanceId, config.parameters.inputs);
  if (resolved.length === 0) throw new Error("operator_checkpoint: no outputs to gate (fail closed).");
  const proposedActionSnapshot = {
    question: config.parameters.question,
    artifactId: resolved[0]!.artifactId,
    artifactHash: resolved[0]!.hash,
    artifacts: resolved.map((r) => ({ stepId: r.stepId, id: r.artifactId, hash: r.hash, type: r.type })),
  };
  return [
    await resolveToolInvocation(tx, {
      capabilityName: REVIEW_CHECKPOINT_CAPABILITY.id,
      permission: REVIEW_CHECKPOINT_PERMISSION,
      proposedActionSnapshot,
    }),
  ];
}

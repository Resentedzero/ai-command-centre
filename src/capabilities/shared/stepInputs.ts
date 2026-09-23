/**
 * Explicit step-to-step data flow (V1.1): a later workflow step consumes selected
 * output of an earlier step BY REFERENCE (spec §18.2), never the workflow's history.
 *
 * A step declares `parameters.inputs: [{ fromStepId, artifactType }]`. At save time
 * (`validateStepInputs`) each must name an EARLIER step's `stepId`. At run time
 * (`resolveStepInputArtifacts`) each resolves to exactly one Artifact of that type
 * produced by that step's COMPLETED Run; zero or several fail closed. The resolved
 * ids go to the Context Compiler as candidates, which decides reference vs content;
 * a failed attempt's outputs are never used. Deterministic: Artifacts and finished
 * Runs are immutable, so a resume resolves the same ids.
 *
 * Provenance AND integrity: resolution proves the artifact was produced by the named
 * earlier step's one completed Run, and that its stored content still hashes to the
 * hash recorded with it. Either check failing fails the step closed.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { artifacts, invocations, runs, taskInstances, workflowRuns } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import type { LinearGraphDefinition } from "../../workflow/graphTypes.js";
import { loadGraphDefinition } from "../../workflow/interpreter.js";

export const INPUT_ARTIFACT_TYPES = ["deliverable", "report"] as const;
export type InputArtifactType = (typeof INPUT_ARTIFACT_TYPES)[number];
export type StepInput = { fromStepId: string; artifactType: InputArtifactType };
export const MAX_STEP_INPUTS = 8;

export type ResolvedStepInput = { stepId: string; artifactId: string; hash: string; type: string; runId: string };

/** The declared inputs' shape, without the graph. */
export function parseStepInputs(value: unknown): { ok: true; inputs: StepInput[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, inputs: [] };
  if (!Array.isArray(value) || value.length > MAX_STEP_INPUTS) {
    return { ok: false, reason: `"inputs" must be a list of at most ${MAX_STEP_INPUTS} inputs.` };
  }
  const inputs: StepInput[] = [];
  for (const [i, item] of value.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return { ok: false, reason: `inputs[${i}] must be an object.` };
    const r = item as Record<string, unknown>;
    const extra = Object.keys(r).filter((k) => k !== "fromStepId" && k !== "artifactType");
    if (extra.length > 0) return { ok: false, reason: `inputs[${i}] has unknown field(s): ${extra.join(", ")}.` };
    if (typeof r.fromStepId !== "string" || r.fromStepId === "") return { ok: false, reason: `inputs[${i}].fromStepId must name a step.` };
    const artifactType = r.artifactType ?? "deliverable";
    if (!INPUT_ARTIFACT_TYPES.includes(artifactType as InputArtifactType)) {
      return { ok: false, reason: `inputs[${i}].artifactType must be one of ${INPUT_ARTIFACT_TYPES.join(", ")}.` };
    }
    if (inputs.some((x) => x.fromStepId === r.fromStepId && x.artifactType === artifactType)) {
      return { ok: false, reason: `inputs[${i}] repeats an earlier input.` };
    }
    inputs.push({ fromStepId: r.fromStepId, artifactType: artifactType as InputArtifactType });
  }
  return { ok: true, inputs };
}

/** Save-time check: every input names an earlier step of this graph. */
export function validateStepInputs(value: unknown, graph: LinearGraphDefinition, stepIndex: number): { ok: true; inputs: StepInput[] } | { ok: false; reason: string } {
  const parsed = parseStepInputs(value);
  if (!parsed.ok) return parsed;
  for (const input of parsed.inputs) {
    const from = graph.steps.findIndex((s) => s.stepId === input.fromStepId);
    if (from < 0) return { ok: false, reason: `input "${input.fromStepId}" names no step of this workflow.` };
    if (from >= stepIndex) return { ok: false, reason: `input "${input.fromStepId}" must be an earlier step (explicit forward data flow only).` };
  }
  return parsed;
}

/** Run-time resolution of a step's declared inputs to Artifacts. Fails closed on anything but exactly one match each. */
export async function resolveStepInputArtifacts(
  tx: DrizzleTransaction,
  taskInstanceId: string,
  inputs: StepInput[],
  options: { verifyIntegrity?: boolean } = {}
): Promise<ResolvedStepInput[]> {
  // A step that CONSUMES evidence must never be handed a corrupted artifact. The Manager's review exists to
  // JUDGE that evidence and reports a hash mismatch itself as `verification_failed`, so it — and only it —
  // resolves without this check; failing it closed here would replace a reasoned verdict with a crash.
  const { verifyIntegrity = true } = options;
  if (inputs.length === 0) return [];
  const fail = (why: string): never => {
    throw new Error(`resolveStepInputArtifacts: task_instance "${taskInstanceId}" ${why} (fail closed).`);
  };
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) });
  if (!taskInstance?.workflowRunId) return fail("is not a workflow step");
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) });
  if (!workflowRun) return fail("has no workflow run");
  const graph = await loadGraphDefinition(tx, workflowRun.workflowDefinitionId, workflowRun.workflowDefinitionVersion);
  const slots = (workflowRun.variables as { stepTaskInstanceIds?: unknown } | null)?.stepTaskInstanceIds;
  const slotIds = Array.isArray(slots) ? (slots as unknown[]) : [];
  const ownIndex = slotIds.indexOf(taskInstanceId);

  const resolved: ResolvedStepInput[] = [];
  for (const input of inputs) {
    const from = graph.steps.findIndex((s) => s.stepId === input.fromStepId);
    if (from < 0 || (ownIndex >= 0 && from >= ownIndex)) fail(`input "${input.fromStepId}" is not an earlier step`);
    const sourceTaskInstanceId = slotIds[from];
    if (typeof sourceTaskInstanceId !== "string") fail(`input "${input.fromStepId}" has not run`);
    const completed = await tx.query.runs.findMany({
      where: and(eq(runs.taskInstanceId, sourceTaskInstanceId as string), eq(runs.status, "completed")),
    });
    if (completed.length !== 1) fail(`input "${input.fromStepId}" has ${completed.length} completed runs`);
    const rows = await tx
      .select({ id: artifacts.id, hash: artifacts.hash, type: artifacts.type, inlineContent: artifacts.inlineContent })
      .from(artifacts)
      .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
      .where(and(eq(invocations.runId, completed[0]!.id), eq(artifacts.type, input.artifactType)));
    if (rows.length !== 1) fail(`input "${input.fromStepId}" produced ${rows.length} "${input.artifactType}" artifacts`);
    // Provenance says the evidence came from the right run; this says it is still what that run wrote.
    // Artifacts are immutable by trigger, so a mismatch means the row was changed around the runtime —
    // one agent must never build on it, and must never be told it was fine.
    const { inlineContent, hash } = rows[0]!;
    if (verifyIntegrity && inlineContent !== null && createHash("sha256").update(inlineContent).digest("hex") !== hash) {
      fail(`input "${input.fromStepId}" has an artifact whose content no longer matches its recorded hash`);
    }
    resolved.push({ stepId: input.fromStepId, artifactId: rows[0]!.id, hash: rows[0]!.hash, type: rows[0]!.type, runId: completed[0]!.id });
  }
  return resolved;
}

/**
 * `buildPublishReportInvocationSpecs` — a real, reusable
 * `InvocationSpecBuilder`-shaped builder (Unit 9) for the "Review-and-Publish"
 * Task Definition, Workflow 2's step 1.
 *
 * Ruling 4: `publish.report` is the ENTIRE Task — "Review-and-Publish"'s
 * review is the human Approval gate itself (the Grant's `ALWAYS_APPROVE`
 * autonomyState), not an additional LLM call. This builder always returns
 * exactly one `"tool"`-kind spec, never an `"llm"` one.
 *
 * Ruling 3 (agent-binding + budget provisioning): identical concern to
 * `../researchRetrieve/buildInvocationSpecs.ts`, factored into
 * `../shared/runProvisioning.ts` rather than duplicated — see that module's
 * header.
 *
 * Ruling 2 (cross-step data hand-off via direct DB lookup): Unit 7's own
 * report disclosed that a workflow-created step's Task Instance `input` is
 * always `{}` — there is no variable-passing mechanism between steps in
 * Unit 7's frozen interfaces. This builder therefore does NOT rely on
 * `params.input` at all; instead, at build time (this function's own `tx`),
 * it:
 *   1. Reads its OWN Task Instance row (`params.taskInstanceId`) to learn
 *      `workflowRunId` — every workflow-created Task Instance already
 *      carries this (`createWorkflowTaskInstance`), so no separate
 *      `workflowRunId` needs to be threaded through the builder's config.
 *   2. Finds Task A's `task_instances` row in that SAME workflow run, by
 *      `(workflowRunId, taskDefinitionId = "Research-Report")`.
 *   3. Finds Task A's `runs` row (one run per Task Instance, always, in this
 *      codebase's usage pattern — see `../shared/runProvisioning.ts`'s
 *      header and `src/workflow/interpreter.ts`'s own module-header
 *      discussion of why `runs.task_instance_id` has no unique index but a
 *      1:1 relationship holds in practice).
 *   4. Joins `artifacts` -> `invocations` on that run, filtered to
 *      `type: "report"`, and requires EXACTLY ONE matching row — not a
 *      loose `findFirst`, so a future bug that leaves 0 or 2+ "report"
 *      Artifacts for the run fails loudly here rather than silently picking
 *      an arbitrary one (the same "fail closed on ambiguity" convention this
 *      codebase uses elsewhere, e.g. `approvals.invocation_id`'s unique
 *      index).
 * The result is a real Artifact id (Ruling 5) — never the report's content
 * itself — embedded in `proposedActionSnapshot`.
 *
 * Idempotency (Ruling 3's determinism requirement): UNLIKE Task A's builder,
 * this one genuinely IS called more than once in normal operation — the
 * Grant's `ALWAYS_APPROVE` autonomyState drives this step to
 * `awaiting_approval`, and every resume re-invokes this builder with the
 * same params (`resumeStep` in `interpreter.ts`). Every step here is either
 * a pure read of already-persisted, immutable data (Task A's report Artifact
 * never changes) or an idempotent write (`bindRunAgent` is a bare `UPDATE`;
 * `provisionRunBudgets` no-ops once a counter row exists) — so the
 * returned `proposedActionSnapshot` is BYTE-IDENTICAL across every call for
 * the same run, which `executeRun`'s own resume-time spec-vs-stored
 * validation (`resumeToolSpec`, `executor.ts`) requires: any mismatch there
 * (e.g. from a non-deterministic id in the snapshot) would fail the
 * invocation via `"resume_spec_mismatch"` before ever reaching `reauthorize`.
 */
import { and, eq } from "drizzle-orm";
import { artifacts, invocations, runs, taskInstances } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import type { InvocationSpec } from "../../execution/types.js";
import { bindRunAgent, findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { provisionRunBudgets } from "../../governance/runBudgetPolicy.js";
import { resolveToolInvocation } from "../toolAdapters.js";
import { PUBLISH_REPORT_CAPABILITY } from "./capability.js";

export type PublishReportBuilderConfig = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  /** Unit 8's "Research-Report" `task_definitions.id` — the id to find Task A's Task Instance by, within this workflow run. */
  researchReportTaskDefinitionId: string;
  /** Must be a stable, deterministic value across every call for the same run — see this module's header. */
  destinationRelativePath: string;
};

export type BuilderParams = {
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  taskInstanceId: string;
  input: Record<string, unknown>;
};

/**
 * Ruling 2's cross-step lookup — see module header. Throws (fails closed) unless
 * exactly one "report" Artifact is found. Returns its content hash too, which is
 * pinned into the Approval's snapshot (see `buildPublishReportInvocationSpecs`).
 */
async function findResearchReportArtifact(
  tx: DrizzleTransaction,
  workflowRunId: string,
  researchReportTaskDefinitionId: string
): Promise<{ id: string; hash: string }> {
  const taskAInstance = await tx.query.taskInstances.findFirst({
    where: and(eq(taskInstances.workflowRunId, workflowRunId), eq(taskInstances.taskDefinitionId, researchReportTaskDefinitionId)),
  });
  if (!taskAInstance) {
    throw new Error(
      `buildPublishReportInvocationSpecs: no Research-Report task_instances row found for workflow_run "${workflowRunId}"`
    );
  }

  const taskARun = await tx.query.runs.findFirst({ where: eq(runs.taskInstanceId, taskAInstance.id) });
  if (!taskARun) {
    throw new Error(`buildPublishReportInvocationSpecs: no runs row found for Task A's task_instance "${taskAInstance.id}"`);
  }

  const rows = await tx
    .select({ id: artifacts.id, hash: artifacts.hash, inlineContent: artifacts.inlineContent })
    .from(artifacts)
    .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
    .where(and(eq(invocations.runId, taskARun.id), eq(artifacts.type, "report")));

  if (rows.length !== 1) {
    throw new Error(
      `buildPublishReportInvocationSpecs: expected exactly one "report"-type Artifact for Task A's run "${taskARun.id}", found ${rows.length}.`
    );
  }
  const row = rows[0]!;
  return { id: row.id, hash: row.hash };
}

export async function buildPublishReportInvocationSpecs(
  tx: DrizzleTransaction,
  config: PublishReportBuilderConfig,
  params: BuilderParams
): Promise<InvocationSpec[]> {
  const runRow = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const runId = runRow.id;

  // Ruling 3: agent-binding + budget provisioning are this builder's job.
  await bindRunAgent(tx, runId, config.agentDefinitionId, config.agentDefinitionVersion);
  // Governance owns the ceilings; this builder can request provisioning for its
  // Run but cannot choose, raise, or pass a limit (Phase 8).
  await provisionRunBudgets(tx, runId);

  const ownTaskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, params.taskInstanceId) });
  if (!ownTaskInstance?.workflowRunId) {
    throw new Error(
      `buildPublishReportInvocationSpecs: task_instance "${params.taskInstanceId}" has no workflow_run_id ` +
        "(this builder is only valid for a workflow-created Task Instance)."
    );
  }

  const { id: artifactId, hash: artifactHash } = await findResearchReportArtifact(
    tx,
    ownTaskInstance.workflowRunId,
    config.researchReportTaskDefinitionId
  );

  // Ruling 5: an ID REFERENCE, never the report's content itself — plus the
  // content's HASH (2026-09-14), so the Approval is for these exact bytes and
  // `publishReport` refuses anything else. Artifacts are immutable, so the hash
  // is as deterministic across resumes as the id (the builder contract holds).
  // An Approval created before this pin existed has no `artifactHash`; resuming
  // it fails closed as `resume_spec_mismatch`.
  const proposedActionSnapshot = { artifactId, artifactHash, destinationRelativePath: config.destinationRelativePath };

  // The Capability's current Tool Binding decides what runs (`../toolAdapters.ts`).
  // Its adapter reads the approved bytes now and re-proves them against the
  // approved hash when it runs, with no transaction open.
  const toolSpec = await resolveToolInvocation(tx, {
    capabilityName: PUBLISH_REPORT_CAPABILITY.id,
    permission: "PUBLISH",
    proposedActionSnapshot,
  });

  return [toolSpec]; // Ruling 4: tool-only, no llm step.
}

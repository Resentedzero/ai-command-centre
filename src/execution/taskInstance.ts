/**
 * `createStandaloneTaskInstance` / `createWorkflowTaskInstance` — the two
 * structurally distinct Goal->Task Instance creation paths (Phase 3b/Ruling
 * 7). `task_instances.workflow_run_id` is nullable precisely to distinguish
 * them: standalone tasks go Goal -> Task Instance directly
 * (`workflow_run_id: null`); workflow-created tasks go Workflow Run -> Task
 * Instance (`workflow_run_id` set, by the Workflow Interpreter).
 *
 * In production only the workflow path is used: no API route or driver
 * creates or executes standalone Task Instances. `createStandaloneTaskInstance`
 * is used by tests, and emits no `task_instance_created` event.
 *
 * Neither the brief's `createStandaloneTaskInstance(tx, taskDefinitionId,
 * goalId, input)` signature nor `createWorkflowTaskInstance(tx,
 * taskDefinitionId, workflowRunId, input)` takes a `projectId` or a
 * `taskDefinitionVersion` directly, yet `task_instances.project_id` is
 * NOT NULL and there is no `goal_id` column on `task_instances` at all
 * (Phase 12's schema puts `goal_id` on `workflow_runs`, not on
 * `task_instances`). Both functions therefore resolve `projectId` via a
 * Goal lookup (standalone: directly by the given `goalId`; workflow: via
 * `workflowRuns.goalId`) and resolve `taskDefinitionVersion` by reading the
 * referenced `task_definitions` row's current `version` — documented,
 * necessary glue this unit's own schema requires, not a speculative
 * addition.
 *
 * `createWorkflowTaskInstance` IS exported (Unit 7 needs to import it) —
 * the brief's "not exported for standalone use" means "not intended to be
 * called by standalone-task code," not "lacks the `export` keyword." What
 * makes the two paths structurally distinct is that this unit's OWN code
 * (`executor.ts`, and any standalone-task caller) never references
 * `createWorkflowTaskInstance` — verified by a structural test in
 * `tests/execution/taskInstance.test.ts`.
 */
import { eq } from "drizzle-orm";
import { goals, taskDefinitions, taskInstances, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";

async function resolveTaskDefinitionVersion(tx: DrizzleTransaction, taskDefinitionId: string): Promise<number> {
  const row = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, taskDefinitionId) });
  if (!row) {
    throw new Error(`resolveTaskDefinitionVersion: no task_definitions row found for id "${taskDefinitionId}"`);
  }
  return row.version;
}

/** Goal -> Task Instance directly, workflow_run_id = null. Used by standalone tasks (Unit 8). */
export async function createStandaloneTaskInstance(
  tx: DrizzleTransaction,
  taskDefinitionId: string,
  goalId: string,
  input: Record<string, unknown>
): Promise<{ taskInstanceId: string }> {
  const goal = await tx.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!goal) {
    throw new Error(`createStandaloneTaskInstance: no goals row found for id "${goalId}"`);
  }

  const taskDefinitionVersion = await resolveTaskDefinitionVersion(tx, taskDefinitionId);

  const [row] = await tx
    .insert(taskInstances)
    .values({
      taskDefinitionId,
      taskDefinitionVersion,
      workflowRunId: null,
      projectId: goal.projectId,
      status: "pending",
      input,
    })
    .returning();

  return { taskInstanceId: row!.id };
}

/**
 * Workflow Run -> Task Instance, workflow_run_id set. Called ONLY from Unit
 * 7's `advanceWorkflowRun` — see module header on why it is still exported.
 */
export async function createWorkflowTaskInstance(
  tx: DrizzleTransaction,
  taskDefinitionId: string,
  workflowRunId: string,
  input: Record<string, unknown>
): Promise<{ taskInstanceId: string }> {
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!workflowRun) {
    throw new Error(`createWorkflowTaskInstance: no workflow_runs row found for id "${workflowRunId}"`);
  }

  const goal = await tx.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) });
  if (!goal) {
    throw new Error(`createWorkflowTaskInstance: no goals row found for workflow_run "${workflowRunId}"'s goalId "${workflowRun.goalId}"`);
  }

  const taskDefinitionVersion = await resolveTaskDefinitionVersion(tx, taskDefinitionId);

  const [row] = await tx
    .insert(taskInstances)
    .values({
      taskDefinitionId,
      taskDefinitionVersion,
      workflowRunId,
      projectId: goal.projectId,
      status: "pending",
      input,
    })
    .returning();

  return { taskInstanceId: row!.id };
}

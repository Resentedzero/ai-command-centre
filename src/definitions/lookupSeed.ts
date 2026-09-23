/**
 * `findSeededPublishWorkflow` — reconstructs the small set of seeded-row ids
 * this unit's API layer needs (workflow/task-definition/agent/capability/
 * tool-binding ids) by looking each up by its well-known, stable
 * name/logical-id, rather than depending on `seedPublishWorkflow`
 * (`./seed.js`) to hand those ids back — a freshly
 * started API process has no other way to learn the randomly-generated
 * UUIDs a prior `npm run seed` run assigned them.
 *
 * Used by two callers:
 *   - `./seed.ts`'s `seedMissingWorkflows` (`npm run seed`, Ruling 1): the
 *     idempotency check — if this returns non-null, Research-and-Publish is not
 *     seeded again.
 *   - `../api/routes/goals.ts`: the default Workflow Definition and Project for
 *     a `POST /goals` that names none. Steps themselves are planned from
 *     persisted Definitions (`../workflow/buildInvocationSpecsFromDefinitions.ts`),
 *     never from these refs.
 *
 * Returns `null` if the workflow has never been seeded. Versioned Definitions
 * resolve to their latest version (the Registry versions them under the same
 * name). Fails closed (throws) on an ambiguous match — two capabilities or
 * projects sharing a name, or two rows sharing a name and version — or on a partially-seeded state (some but not all
 * expected rows present), consistent with this codebase's established
 * "never silently pick an arbitrary match" convention (e.g.
 * `buildPublishReportInvocationSpecs`'s own `findResearchReportArtifact`,
 * `src/capabilities/publishReport/buildInvocationSpecs.ts`).
 *
 * Deliberately its own slim type (`SeededWorkflowRefs`), not Unit 9's
 * `SeedPublishWorkflowResult` — this module only reconstructs the subset of
 * fields this unit's dispatcher/routes actually consume (no task-definition
 * *versions*, no Grant ids, no fixture Goal id), rather than re-deriving
 * every field `seedPublishWorkflow` happens to return.
 */
import { eq } from "drizzle-orm";
import { agentDefinitions, capabilities, projects, taskDefinitions, workflowDefinitions } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "../capabilities/researchRetrieve/capability.js";
import { PUBLISH_REPORT_CAPABILITY } from "../capabilities/publishReport/capability.js";

const WORKFLOW_DEFINITION_NAME = "Research-and-Publish";
const RESEARCHER_AGENT_NAME = "Researcher";
const PUBLISHER_AGENT_NAME = "Publisher";
const RESEARCH_TASK_DEFINITION_NAME = "Research-Report";
const REVIEW_AND_PUBLISH_TASK_DEFINITION_NAME = "Review-and-Publish";

export type SeededWorkflowRefs = {
  /** The seed's own fixture Project (`seedResearchWorkflow`'s "Research Workflow" project) — reused by `POST /goals` for every real Goal it creates (this MVP has no project-management routes of its own). */
  projectId: string;
  workflowDefinitionId: string;
  /** "Research-Report" — Workflow 2's step 0. */
  taskDefinitionId: string;
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  capabilityId: string;
  /** "Review-and-Publish" — Workflow 2's step 1. */
  reviewAndPublishTaskDefinitionId: string;
  publisherAgentDefinitionId: string;
  publisherAgentDefinitionVersion: number;
  publishCapabilityId: string;
};

/**
 * The API cannot act without the seed. A 503 whose message is shown to the
 * caller (the API's error handler hides other 5xx messages), so the operator
 * sees the fix instead of "Internal server error".
 */
export class SeedMissingError extends Error {
  readonly statusCode = 503;
  constructor() {
    super('No seeded Workflow Definition found — run "npm run seed" first.');
    this.name = "SeedMissingError";
  }
}

/** `findSeededPublishWorkflow`, throwing `SeedMissingError` when nothing is seeded. */
export async function requireSeededPublishWorkflow(tx: DrizzleTransaction): Promise<SeededWorkflowRefs> {
  const refs = await findSeededPublishWorkflow(tx);
  if (!refs) throw new SeedMissingError();
  return refs;
}

async function findOneByName<T>(rows: T[], label: string): Promise<T | null> {
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`findSeededPublishWorkflow: expected at most one ${label}, found ${rows.length} (ambiguous seed state).`);
  }
  return rows[0]!;
}

/**
 * The latest version of a versioned Definition. The Registry creates new versions
 * under the same name (`./registryWrites.ts`), so several rows per name is normal;
 * a default Goal runs the latest Workflow Definition version.
 */
async function findLatestByName<T extends { version: number }>(rows: T[], label: string): Promise<T | null> {
  const latest = Math.max(...rows.map((r) => r.version));
  return findOneByName(rows.filter((r) => r.version === latest), label);
}

/** The Keeper's Project and latest "Keeper Think" Workflow Definition (`./seed.ts` `seedKeeper`), or null when not seeded. */
export async function findKeeperRefs(tx: DrizzleTransaction): Promise<{ projectId: string; workflowDefinitionId: string } | null> {
  const workflows = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, "Keeper Think") });
  const workflow = workflows.length > 0 ? await findLatestByName(workflows, "workflow_definitions named Keeper Think") : null;
  const project = await findOneByName(await tx.query.projects.findMany({ where: eq(projects.name, "Keeper") }), "projects named Keeper");
  return workflow && project ? { projectId: project.id, workflowDefinitionId: workflow.id } : null;
}

/** Talk's Project and latest "Agent Talk" Task Definition (`./seed.ts` `seedTalk`), or null when not seeded. */
export async function findTalkRefs(tx: DrizzleTransaction): Promise<{ projectId: string; taskDefinitionId: string; taskDefinitionVersion: number } | null> {
  const tasks = await tx.query.taskDefinitions.findMany({ where: eq(taskDefinitions.name, "Agent Talk") });
  const task = tasks.length > 0 ? await findLatestByName(tasks, "task_definitions named Agent Talk") : null;
  const project = await findOneByName(await tx.query.projects.findMany({ where: eq(projects.name, "Direct requests") }), "projects named Direct requests");
  return task && project ? { projectId: project.id, taskDefinitionId: task.id, taskDefinitionVersion: task.version } : null;
}

/** The Manager's latest Agent Definition, the "Missions" Project and the latest "Manager Plan" Workflow (`./seed.ts` `seedManager`), or null when not seeded. */
export async function findManagerRefs(
  tx: DrizzleTransaction
): Promise<{ agent: { id: string; name: string; version: number }; agentVersionIds: string[]; projectId: string; planWorkflowDefinitionId: string } | null> {
  const defs = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, "Manager") });
  const latest = [...defs].sort((x, y) => y.version - x.version)[0];
  const workflows = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, "Manager Plan") });
  const workflow = workflows.length > 0 ? await findLatestByName(workflows, "workflow_definitions named Manager Plan") : null;
  const project = await findOneByName(await tx.query.projects.findMany({ where: eq(projects.name, "Missions") }), "projects named Missions");
  return latest && workflow && project
    ? { agent: { id: latest.id, name: latest.name, version: latest.version }, agentVersionIds: defs.map((d) => d.id), projectId: project.id, planWorkflowDefinitionId: workflow.id }
    : null;
}

/** The Keeper's persistent Agent Definition (latest version), for drawing it with its appearance. Null when not seeded. */
export async function findKeeperAgent(tx: DrizzleTransaction): Promise<{ id: string; name: string; version: number } | null> {
  const defs = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, "Keeper") });
  const latest = defs.sort((a, b) => b.version - a.version)[0];
  return latest ? { id: latest.id, name: latest.name, version: latest.version } : null;
}

export async function findSeededPublishWorkflow(tx: DrizzleTransaction): Promise<SeededWorkflowRefs | null> {
  const workflowDefinition = await findLatestByName(
    await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, WORKFLOW_DEFINITION_NAME) }),
    `workflow_definitions named "${WORKFLOW_DEFINITION_NAME}"`
  );
  if (!workflowDefinition) return null;

  const researchTaskDefinition = await findLatestByName(
    await tx.query.taskDefinitions.findMany({ where: eq(taskDefinitions.name, RESEARCH_TASK_DEFINITION_NAME) }),
    `task_definitions named "${RESEARCH_TASK_DEFINITION_NAME}"`
  );
  const reviewAndPublishTaskDefinition = await findLatestByName(
    await tx.query.taskDefinitions.findMany({ where: eq(taskDefinitions.name, REVIEW_AND_PUBLISH_TASK_DEFINITION_NAME) }),
    `task_definitions named "${REVIEW_AND_PUBLISH_TASK_DEFINITION_NAME}"`
  );
  const researcherAgent = await findLatestByName(
    await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, RESEARCHER_AGENT_NAME) }),
    `agent_definitions named "${RESEARCHER_AGENT_NAME}"`
  );
  const publisherAgent = await findLatestByName(
    await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, PUBLISHER_AGENT_NAME) }),
    `agent_definitions named "${PUBLISHER_AGENT_NAME}"`
  );
  const researchCapability = await findOneByName(
    await tx.query.capabilities.findMany({ where: eq(capabilities.name, RESEARCH_RETRIEVE_CAPABILITY.id) }),
    `capabilities named "${RESEARCH_RETRIEVE_CAPABILITY.id}"`
  );
  const publishCapability = await findOneByName(
    await tx.query.capabilities.findMany({ where: eq(capabilities.name, PUBLISH_REPORT_CAPABILITY.id) }),
    `capabilities named "${PUBLISH_REPORT_CAPABILITY.id}"`
  );

  if (
    !researchTaskDefinition ||
    !reviewAndPublishTaskDefinition ||
    !researcherAgent ||
    !publisherAgent ||
    !researchCapability ||
    !publishCapability
  ) {
    throw new Error(
      "findSeededPublishWorkflow: found a workflow_definitions row but one or more dependent seeded rows are missing " +
        "(inconsistent partial seed state)."
    );
  }

  // Tool Bindings are deliberately not looked up: a Capability may have several
  // (a newer one replaces an older one, `../capabilities/toolAdapters.ts`), and
  // the binding that runs is resolved per Invocation, never from the seed.

  // The seed's own fixture Project — resolved via the Research-Report Task
  // Definition's originating Goal is unnecessary; `seedResearchWorkflow`
  // creates exactly one "Research Workflow" Project, findable directly.
  const project = await findOneByName(
    await tx.query.projects.findMany({ where: eq(projects.name, "Research Workflow") }),
    'projects named "Research Workflow"'
  );
  if (!project) {
    throw new Error('findSeededPublishWorkflow: missing the seed\'s fixture "Research Workflow" project (inconsistent partial seed state).');
  }

  return {
    projectId: project.id,
    workflowDefinitionId: workflowDefinition.id,
    taskDefinitionId: researchTaskDefinition.id,
    agentDefinitionId: researcherAgent.id,
    agentDefinitionVersion: researcherAgent.version,
    capabilityId: researchCapability.id,
    reviewAndPublishTaskDefinitionId: reviewAndPublishTaskDefinition.id,
    publisherAgentDefinitionId: publisherAgent.id,
    publisherAgentDefinitionVersion: publisherAgent.version,
    publishCapabilityId: publishCapability.id,
  };
}

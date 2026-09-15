/**
 * `seedResearchWorkflow` / `seedPublishWorkflow` — the seed data for spec §18.2's two
 * workflows ("Research -> Report" and "Research -> Report -> Review-and-Publish").
 *
 * THROUGH THE REGISTRY (2026-09-14). Every Capability, Tool Binding, Agent / Task /
 * Workflow Definition and Capability Grant is created with `./registryWrites.ts`, the
 * same functions the API uses, in the caller's transaction. So the seed validates
 * exactly as an operator's write does (autonomy ceiling, binding adapter, task plan,
 * graph references, Agent version not yet in use) and logs the same facts:
 * `definition_version_created` for each Definition and `capability_granted` for each
 * Grant (spec §8.2). The Researcher's `AUTONOMOUS` Grant is therefore a logged act
 * (§9.4), not a row that appeared without a trace. The seeded Goal emits
 * `goal_created`, as `POST /goals` does. `tests/execution/structuralInvariants.test.ts`
 * keeps every other source file from inserting into those tables.
 *
 * The actor is the V1 operator identity the Registry routes record: `npm run seed`
 * is an operator applying these definitions (`./runSeed.ts`).
 *
 * `seedPublishWorkflow` reuses `seedResearchWorkflow`'s Task Definition, Agent,
 * Capability and Grant as step 0 rather than creating a parallel copy. Grants are
 * created before the Workflow Definition that names their Agent, because a Grant may
 * only be added to an Agent version not yet in use.
 *
 * `MVP_MAX_TRUST_LEVEL_REQUIRED` is each Grant's declared MINIMUM binding trust level;
 * Policy DENYs a binding below it (Phase 6 / 9.2). Both seeded bindings are
 * `trustLevel: 2` ("first party"), so both clear it.
 *
 * `task_definitions.kind` selects the Task Definition's registered plan
 * (`../capabilities/taskPlans.ts`), and each graph step binds its Agent Definition and
 * plan parameters (spec §18.3). Migration 0012 gives rows seeded before then the same
 * kinds and step bindings.
 */
import { eq } from "drizzle-orm";
import { goals, projects, workflowDefinitions } from "../db/schema.js";
import { findSeededPublishWorkflow } from "./lookupSeed.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../events/lifecycle.js";
import type { CapabilityPermission } from "../governance/policy.js";
import type { ContextBudget } from "../context/types.js";
import { isLinearGraphDefinition, type LinearGraphDefinition, type LinearGraphStep } from "../workflow/graphTypes.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "../capabilities/researchRetrieve/capability.js";
import { PUBLISH_REPORT_CAPABILITY } from "../capabilities/publishReport/capability.js";
import { RESEARCH_RETRIEVE_SYNTHETIC } from "../capabilities/researchRetrieve/adapter.js";
import { PUBLISH_REPORT_FILESYSTEM } from "../capabilities/publishReport/adapter.js";
import { PUBLISH_REPORT_TASK_KIND, RESEARCH_REPORT_TASK_KIND } from "../capabilities/taskPlans.js";
import {
  createAgentDefinition,
  createCapability,
  createCapabilityGrant,
  createTaskDefinition,
  createToolBinding,
  createWorkflowDefinition,
} from "./registryWrites.js";

/** The V1 operator identity, as the Registry routes record it. */
const SEED_ACTOR = "human:operator";

/**
 * MVP default Context Budget for the "Research-Report" Task Definition.
 * Values are documented placeholders (no product-specified sizing exists
 * yet), chosen to comfortably fit one small tool-result artifact (tier 2)
 * alongside the task's own input (tier 1) for a CHEAP-tier LLM call:
 *   - `maxInputTokens: 8_000` / `expectedOutputTokens: 500`: generous for a
 *     short synthesized report, small enough to keep the CHEAP-tier Pass-1
 *     cost estimate trivially cheap.
 *   - `maxArtifactTokens: 2_000` / `compressionThreshold: 2_000`: the tool's
 *     synthesized result set is tiny (a couple hundred tokens at most), so
 *     this is headroom, not a tight constraint.
 *   - `maxRetrievedItems: 10`: this workflow only ever produces one
 *     candidate artifact (the tool's result), so this is a non-binding cap.
 *   - `maxToolSchemaTokens: 1_000`: this workflow's LLM step passes no
 *     `candidateToolCapabilityIds` (the LLM synthesizes from the already-persisted
 *     artifact; it does not itself call tools), so this is also non-binding.
 *   - `freshnessRequirementSeconds: 0`: no staleness requirement — the
 *     artifact is produced and consumed within the same Run.
 */
export const DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 8_000,
  maxArtifactTokens: 2_000,
  maxRetrievedItems: 10,
  maxToolSchemaTokens: 1_000,
  compressionThreshold: 2_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 500,
};

const MVP_MAX_TRUST_LEVEL_REQUIRED = 1;

const RESEARCH_RETRIEVE_PERMISSIONS: CapabilityPermission[] = ["READ"];
const RESEARCH_RETRIEVE_AUTONOMY_STATE = "AUTONOMOUS" as const;

export type SeedResearchWorkflowResult = {
  projectId: string;
  goalId: string;
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  capabilityId: string;
  toolBindingId: string;
  capabilityGrantId: string;
};

export async function seedResearchWorkflow(tx: DrizzleTransaction): Promise<SeedResearchWorkflowResult> {
  const capability = await createCapability(
    tx,
    {
      name: RESEARCH_RETRIEVE_CAPABILITY.id,
      description: RESEARCH_RETRIEVE_CAPABILITY.description,
      staticRiskTag: RESEARCH_RETRIEVE_CAPABILITY.staticRiskTag,
      costProfile: RESEARCH_RETRIEVE_CAPABILITY.costProfile,
    },
    SEED_ACTOR
  );

  const toolBinding = await createToolBinding(
    tx,
    { capabilityId: capability.id, kind: "internal", config: { function: RESEARCH_RETRIEVE_SYNTHETIC }, trustLevel: 2 },
    SEED_ACTOR
  );

  const [project] = await tx
    .insert(projects)
    .values({ name: "Research Workflow", description: "Unit 8 standalone research -> report workflow" })
    .returning();
  const projectId = project!.id;

  const goalTitle = "Produce a research report";
  const [goal] = await tx
    .insert(goals)
    .values({
      projectId,
      title: goalTitle,
      description: "Retrieve information on a topic and synthesize it into a report.",
      status: "active",
    })
    .returning();
  const goalId = goal!.id;
  await emitLifecycleEvent(tx, {
    eventType: "goal_created",
    subjectId: goalId,
    correlation: { ...NO_CORRELATION, goalId },
    producer: "seed",
    actor: SEED_ACTOR,
    payload: { title: goalTitle },
  });

  const agent = await createAgentDefinition(
    tx,
    {
      name: "Researcher",
      role: "Research Analyst",
      objective: "Retrieve relevant information for a query and synthesize it into a concise report.",
      instructions: "Use the research.retrieve capability to gather information, then synthesize a report from it.",
    },
    SEED_ACTOR
  );

  const grant = await createCapabilityGrant(
    tx,
    {
      agentDefinitionId: agent.id,
      agentDefinitionVersion: agent.version,
      capabilityId: capability.id,
      permissions: RESEARCH_RETRIEVE_PERMISSIONS,
      maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
      autonomyState: RESEARCH_RETRIEVE_AUTONOMY_STATE,
    },
    SEED_ACTOR
  );

  const taskDefinition = await createTaskDefinition(
    tx,
    {
      name: "Research-Report",
      kind: RESEARCH_REPORT_TASK_KIND,
      defaultContextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
    },
    SEED_ACTOR
  );

  return {
    projectId,
    goalId,
    agentDefinitionId: agent.id,
    agentDefinitionVersion: agent.version!,
    taskDefinitionId: taskDefinition.id,
    taskDefinitionVersion: taskDefinition.version!,
    capabilityId: capability.id,
    toolBindingId: toolBinding.id,
    capabilityGrantId: grant.id,
  };
}

// ---------------------------------------------------------------------------
// seedPublishWorkflow
// ---------------------------------------------------------------------------

/**
 * Adds, after `seedResearchWorkflow`: the `publish.report` Capability and binding, the
 * "Publisher" Agent with a `PUBLISH` Grant at `ALWAYS_APPROVE` (the §9.4 ceiling forbids
 * `AUTONOMOUS` for PUBLISH), the publish-only "Review-and-Publish" Task Definition (its
 * "review" is the Grant's Approval gate), and the two-step "Research-and-Publish"
 * Workflow Definition.
 */
const PUBLISH_REPORT_PERMISSIONS: CapabilityPermission[] = ["PUBLISH"];
const PUBLISH_REPORT_AUTONOMY_STATE = "ALWAYS_APPROVE" as const;

export type SeedPublishWorkflowResult = SeedResearchWorkflowResult & {
  publishCapabilityId: string;
  publishToolBindingId: string;
  publisherAgentDefinitionId: string;
  publisherAgentDefinitionVersion: number;
  publishCapabilityGrantId: string;
  reviewAndPublishTaskDefinitionId: string;
  reviewAndPublishTaskDefinitionVersion: number;
  workflowDefinitionId: string;
  workflowDefinitionVersion: number;
};

export async function seedPublishWorkflow(tx: DrizzleTransaction): Promise<SeedPublishWorkflowResult> {
  const research = await seedResearchWorkflow(tx);

  const publishCapability = await createCapability(
    tx,
    {
      name: PUBLISH_REPORT_CAPABILITY.id,
      description: PUBLISH_REPORT_CAPABILITY.description,
      staticRiskTag: PUBLISH_REPORT_CAPABILITY.staticRiskTag,
      costProfile: PUBLISH_REPORT_CAPABILITY.costProfile,
    },
    SEED_ACTOR
  );

  const publishToolBinding = await createToolBinding(
    tx,
    { capabilityId: publishCapability.id, kind: "internal", config: { function: PUBLISH_REPORT_FILESYSTEM }, trustLevel: 2 },
    SEED_ACTOR
  );

  const publisher = await createAgentDefinition(
    tx,
    {
      name: "Publisher",
      role: "Publishing Reviewer",
      objective: "Review a synthesized report and publish it to the proof-of-governance output location.",
      instructions: "Use the publish.report capability to publish the report Artifact produced by the Research-Report task.",
    },
    SEED_ACTOR
  );

  const publishGrant = await createCapabilityGrant(
    tx,
    {
      agentDefinitionId: publisher.id,
      agentDefinitionVersion: publisher.version,
      capabilityId: publishCapability.id,
      permissions: PUBLISH_REPORT_PERMISSIONS,
      maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
      autonomyState: PUBLISH_REPORT_AUTONOMY_STATE,
    },
    SEED_ACTOR
  );

  const reviewAndPublish = await createTaskDefinition(
    tx,
    { name: "Review-and-Publish", kind: PUBLISH_REPORT_TASK_KIND },
    SEED_ACTOR
  );

  const graphDefinition: LinearGraphDefinition = {
    kind: "linear",
    steps: [
      {
        taskDefinitionId: research.taskDefinitionId,
        taskDefinitionVersion: research.taskDefinitionVersion,
        agentDefinitionId: research.agentDefinitionId,
        agentDefinitionVersion: research.agentDefinitionVersion,
      },
      {
        taskDefinitionId: reviewAndPublish.id,
        taskDefinitionVersion: reviewAndPublish.version!,
        agentDefinitionId: publisher.id,
        agentDefinitionVersion: publisher.version!,
        parameters: { sourceTaskDefinitionId: research.taskDefinitionId },
      },
    ],
  };

  const workflowDefinition = await createWorkflowDefinition(tx, { name: "Research-and-Publish", graphDefinition }, SEED_ACTOR);

  return {
    ...research,
    publishCapabilityId: publishCapability.id,
    publishToolBindingId: publishToolBinding.id,
    publisherAgentDefinitionId: publisher.id,
    publisherAgentDefinitionVersion: publisher.version!,
    publishCapabilityGrantId: publishGrant.id,
    reviewAndPublishTaskDefinitionId: reviewAndPublish.id,
    reviewAndPublishTaskDefinitionVersion: reviewAndPublish.version!,
    workflowDefinitionId: workflowDefinition.id,
    workflowDefinitionVersion: workflowDefinition.version!,
  };
}

// ---------------------------------------------------------------------------
// seedResearchReportWorkflow
// ---------------------------------------------------------------------------

/** Workflow 1 (spec §18.2): the standalone `research.retrieve` → Report Task. */
export const RESEARCH_REPORT_WORKFLOW_NAME = "Research-Report";

/**
 * Adds Workflow 1 as a one-step Workflow Definition whose step is Research-and-Publish's
 * research step — the same Task Definition and Agent versions, so the same Grants — so a
 * database seeded before it existed gains it without re-creating anything.
 */
export async function seedResearchReportWorkflow(
  tx: DrizzleTransaction,
  researchStep: LinearGraphStep
): Promise<{ workflowDefinitionId: string; workflowDefinitionVersion: number }> {
  const { taskDefinitionId, taskDefinitionVersion, agentDefinitionId, agentDefinitionVersion } = researchStep;
  const graphDefinition: LinearGraphDefinition = {
    kind: "linear",
    steps: [{ taskDefinitionId, taskDefinitionVersion, agentDefinitionId, agentDefinitionVersion }],
  };
  const workflowDefinition = await createWorkflowDefinition(tx, { name: RESEARCH_REPORT_WORKFLOW_NAME, graphDefinition }, SEED_ACTOR);
  return { workflowDefinitionId: workflowDefinition.id, workflowDefinitionVersion: workflowDefinition.version! };
}

/**
 * `npm run seed`'s body: seeds each workflow that is missing, each by its own check.
 * Research-and-Publish is found by `findSeededPublishWorkflow`. Workflow 1 is found by
 * name and must be a one-step graph over the research step; any other Workflow
 * Definition under that name fails closed rather than counting as seeded.
 */
export async function seedMissingWorkflows(tx: DrizzleTransaction): Promise<{ seededPublish: boolean; seededResearchReport: boolean }> {
  const seededPublish = !(await findSeededPublishWorkflow(tx));
  if (seededPublish) await seedPublishWorkflow(tx);

  const publishRows = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, "Research-and-Publish") });
  const publish = publishRows.reduce((a, b) => (b.version > a.version ? b : a));
  if (!isLinearGraphDefinition(publish.graphDefinition) || !publish.graphDefinition.steps[0]) {
    throw new Error("seedMissingWorkflows: Research-and-Publish has no valid first step to build Workflow 1 from (fail closed).");
  }
  const researchStep = publish.graphDefinition.steps[0];

  const existing = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, RESEARCH_REPORT_WORKFLOW_NAME) });
  if (existing.length > 0) {
    const matches = existing.every(
      (row) =>
        isLinearGraphDefinition(row.graphDefinition) &&
        row.graphDefinition.steps.length === 1 &&
        row.graphDefinition.steps[0]!.taskDefinitionId === researchStep.taskDefinitionId
    );
    if (!matches) {
      throw new Error(
        `seedMissingWorkflows: a Workflow Definition named "${RESEARCH_REPORT_WORKFLOW_NAME}" exists but is not the one-step ` +
          "Research-Report workflow (fail closed)."
      );
    }
    return { seededPublish, seededResearchReport: false };
  }
  await seedResearchReportWorkflow(tx, researchStep);
  return { seededPublish, seededResearchReport: true };
}

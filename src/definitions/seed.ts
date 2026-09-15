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
import { and, eq } from "drizzle-orm";
import { agentDefinitions, capabilities, goals, projects, taskDefinitions, workflowDefinitions } from "../db/schema.js";
import { REVIEW_CHECKPOINT_CAPABILITY, REVIEW_CHECKPOINT_PERMISSION } from "../capabilities/reviewCheckpoint/capability.js";
import { REVIEW_CHECKPOINT_RECORD } from "../capabilities/reviewCheckpoint/adapter.js";
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
import { AGENT_OBJECTIVE_KIND, AGENT_TASK_KIND, OPERATOR_CHECKPOINT_KIND, PUBLISH_REPORT_TASK_KIND, RESEARCH_REPORT_TASK_KIND } from "../capabilities/taskPlans.js";
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
 * Research-and-Publish is found by `findSeededPublishWorkflow`. Workflow 1 counts as
 * seeded when a Workflow Definition under its name is a one-step graph over a
 * `research_report` Task Definition, whatever versions a Registry edit has since made;
 * rows under that name with none of them fail closed rather than counting as seeded.
 */
export async function seedMissingWorkflows(
  tx: DrizzleTransaction
): Promise<{ seededPublish: boolean; seededResearchReport: boolean; seededV11: boolean }> {
  const seededPublish = !(await findSeededPublishWorkflow(tx));
  if (seededPublish) await seedPublishWorkflow(tx);
  const seededV11 = await seedV11Definitions(tx);

  const isResearchStep = async (step: LinearGraphStep) =>
    (
      await tx.query.taskDefinitions.findFirst({
        where: and(eq(taskDefinitions.id, step.taskDefinitionId), eq(taskDefinitions.version, step.taskDefinitionVersion)),
      })
    )?.kind === RESEARCH_REPORT_TASK_KIND;

  const existing = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, RESEARCH_REPORT_WORKFLOW_NAME) });
  if (existing.length > 0) {
    let matches = false;
    for (const row of existing) {
      const steps = isLinearGraphDefinition(row.graphDefinition) ? row.graphDefinition.steps : [];
      if (steps.length === 1 && (await isResearchStep(steps[0]!))) matches = true;
    }
    if (!matches) {
      throw new Error(
        `seedMissingWorkflows: a Workflow Definition named "${RESEARCH_REPORT_WORKFLOW_NAME}" exists but is not the one-step ` +
          "Research-Report workflow (fail closed)."
      );
    }
    return { seededPublish, seededResearchReport: false, seededV11 };
  }

  const publishRows = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, "Research-and-Publish") });
  const publish = publishRows.reduce((a, b) => (b.version > a.version ? b : a));
  let researchStep: LinearGraphStep | undefined;
  for (const step of isLinearGraphDefinition(publish.graphDefinition) ? publish.graphDefinition.steps : []) {
    if (!researchStep && (await isResearchStep(step))) researchStep = step;
  }
  if (!researchStep) {
    throw new Error("seedMissingWorkflows: Research-and-Publish has no research_report step to build Workflow 1 from (fail closed).");
  }
  await seedResearchReportWorkflow(tx, researchStep);
  return { seededPublish, seededResearchReport: true, seededV11 };
}

// ---------------------------------------------------------------------------
// seedV11Definitions
// ---------------------------------------------------------------------------

/**
 * V1.1 Task Definition default Context Budget for writing steps (`agent_task`).
 * Documented placeholders, like `DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET`: room for a
 * few input documents and a full deliverable. An operator wanting other values creates
 * another Task Definition version through the Registry.
 */
export const AGENT_TASK_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 16_000,
  maxArtifactTokens: 6_000,
  maxRetrievedItems: 8,
  maxToolSchemaTokens: 0,
  compressionThreshold: 6_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 2_500,
};

/**
 * V1.1 default Context Budget for autonomous objectives (`agent_objective`): the final
 * write's budget; the loop's decide and act calls use smaller budgets derived from it
 * (`../capabilities/agentObjective/buildInvocationSpecs.ts`). Documented placeholders,
 * sized so several iterations and the final write fit the Task Instance ceiling.
 */
export const AGENT_OBJECTIVE_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 7_000,
  maxArtifactTokens: 3_000,
  maxRetrievedItems: 6,
  maxToolSchemaTokens: 0,
  compressionThreshold: 3_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 2_500,
};

export const AUTONOMOUS_OBJECTIVE_DEFINITION_NAME = "Autonomous Objective";
export const AGENT_TASK_DEFINITION_NAME = "Agent Task";
export const APPROVAL_GATE_DEFINITION_NAME = "Approval Gate";
export const REVIEWER_AGENT_NAME = "Reviewer";

/**
 * The V1.1 building blocks, each created through the Registry only if missing (by
 * name), so it is idempotent and adds nothing to an operator's own Definitions:
 * - the `review.checkpoint` Capability with its binding;
 * - Task Definitions for the general agent step and the approval gate;
 * - an ordinary "Reviewer" Agent holding `review.checkpoint` at ALWAYS_APPROVE, the
 *   agent an approval-gate step binds unless the operator picks another.
 * Returns whether anything was created.
 */
export async function seedV11Definitions(tx: DrizzleTransaction): Promise<boolean> {
  let created = false;

  let checkpoint = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, REVIEW_CHECKPOINT_CAPABILITY.id) });
  if (!checkpoint) {
    const c = await createCapability(
      tx,
      {
        name: REVIEW_CHECKPOINT_CAPABILITY.id,
        description: REVIEW_CHECKPOINT_CAPABILITY.description,
        staticRiskTag: REVIEW_CHECKPOINT_CAPABILITY.staticRiskTag,
        costProfile: REVIEW_CHECKPOINT_CAPABILITY.costProfile,
      },
      SEED_ACTOR
    );
    await createToolBinding(tx, { capabilityId: c.id, kind: "internal", config: { function: REVIEW_CHECKPOINT_RECORD }, trustLevel: 2 }, SEED_ACTOR);
    checkpoint = await tx.query.capabilities.findFirst({ where: eq(capabilities.id, c.id) });
    created = true;
  }

  if (!(await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, AGENT_TASK_DEFINITION_NAME) }))) {
    await createTaskDefinition(tx, { name: AGENT_TASK_DEFINITION_NAME, kind: AGENT_TASK_KIND, defaultContextBudget: AGENT_TASK_CONTEXT_BUDGET }, SEED_ACTOR);
    created = true;
  }
  if (!(await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, AUTONOMOUS_OBJECTIVE_DEFINITION_NAME) }))) {
    await createTaskDefinition(
      tx,
      { name: AUTONOMOUS_OBJECTIVE_DEFINITION_NAME, kind: AGENT_OBJECTIVE_KIND, defaultContextBudget: AGENT_OBJECTIVE_CONTEXT_BUDGET },
      SEED_ACTOR
    );
    created = true;
  }
  if (!(await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, APPROVAL_GATE_DEFINITION_NAME) }))) {
    await createTaskDefinition(tx, { name: APPROVAL_GATE_DEFINITION_NAME, kind: OPERATOR_CHECKPOINT_KIND }, SEED_ACTOR);
    created = true;
  }

  if (!(await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, REVIEWER_AGENT_NAME) }))) {
    await createAgentDefinition(
      tx,
      {
        name: REVIEWER_AGENT_NAME,
        role: "Approval gate",
        objective: "Hold a workflow at a checkpoint until the operator approves the outputs shown.",
        instructions: "Ask the operator to approve continuing with the exact outputs pinned by the checkpoint. Take no other action.",
        grants: [
          {
            capabilityId: checkpoint!.id,
            permissions: [REVIEW_CHECKPOINT_PERMISSION],
            autonomyState: "ALWAYS_APPROVE",
            maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
          },
        ],
      },
      SEED_ACTOR
    );
    created = true;
  }
  return created;
}

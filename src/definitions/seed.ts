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
import { and, eq, isNull } from "drizzle-orm";
import { agentDefinitions, capabilities, capabilityGrants, goals, projects, taskDefinitions, workflowDefinitions } from "../db/schema.js";
import { REVIEW_CHECKPOINT_CAPABILITY, REVIEW_CHECKPOINT_PERMISSION } from "../capabilities/reviewCheckpoint/capability.js";
import { REVIEW_CHECKPOINT_RECORD } from "../capabilities/reviewCheckpoint/adapter.js";
import { SYSTEM_INSPECT_CAPABILITY } from "../capabilities/systemInspect/capability.js";
import { SYSTEM_INSPECT_READ } from "../capabilities/systemInspect/adapter.js";
import { DOCS_RETRIEVE_CAPABILITY } from "../capabilities/docsRetrieve/capability.js";
import { DOCS_RETRIEVE_GUIDE } from "../capabilities/docsRetrieve/adapter.js";
import { KEEP_STATS_CAPABILITY, KEEP_STATS_READ } from "../capabilities/keepStats/capability.js";
import { WORKPLACE_CALENDAR_READ, WORKPLACE_INSPECT_CALENDAR_CAPABILITY, WORKPLACE_MEETING_RECORD, WORKPLACE_OUTCOME_RECORD, WORKPLACE_RECORD_OUTCOME_CAPABILITY, WORKPLACE_SCHEDULE_MEETING_CAPABILITY } from "../capabilities/workplace/capability.js";
import { ensureDefaultRooms } from "../workplace/workplace.js";
import { activeAreaNames } from "../world/worldConfig.js";
import { findSeededPublishWorkflow } from "./lookupSeed.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../events/lifecycle.js";
import type { CapabilityPermission } from "../governance/policy.js";
import type { ContextBudget } from "../context/types.js";
import { isLinearGraphDefinition, type LinearGraphDefinition, type LinearGraphStep } from "../workflow/graphTypes.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "../capabilities/researchRetrieve/capability.js";
import { RESEARCH_SEARCH_CAPABILITY } from "../capabilities/researchSearch/capability.js";
import { PEER_ENDORSE_CAPABILITY } from "../capabilities/peerEndorse/capability.js";
import { PEER_ENDORSE_RECORD } from "../capabilities/peerEndorse/adapter.js";
import { MANAGER_DELEGATE_CAPABILITY, MANAGER_DELEGATE_PERMISSION, MANAGER_DELEGATE_RECORD, MANAGER_INSPECT_WORKFORCE_CAPABILITY, MANAGER_WORKFORCE_READ, MANAGER_INSPECT_HISTORY_CAPABILITY, MANAGER_HISTORY_READ } from "../capabilities/manager/capability.js";
import { RESEARCH_SEARCH_PUBLIC_INDEXES } from "../capabilities/researchSearch/adapter.js";
import { RESEARCH_WEB_CAPABILITY } from "../capabilities/researchWeb/capability.js";
import { PUBLISH_REPORT_CAPABILITY } from "../capabilities/publishReport/capability.js";
import { RESEARCH_RETRIEVE_SYNTHETIC } from "../capabilities/researchRetrieve/adapter.js";
import { PUBLISH_REPORT_FILESYSTEM } from "../capabilities/publishReport/adapter.js";
import { AGENT_OBJECTIVE_KIND, AGENT_TALK_KIND, AGENT_TASK_KIND, KEEPER_ANSWER_KIND, MANAGER_PLAN_KIND, MANAGER_RECOVER_KIND, MANAGER_REVIEW_KIND, MEETING_CONTRIBUTION_KIND, MEETING_OUTCOME_KIND, OPERATOR_CHECKPOINT_KIND, PUBLISH_REPORT_TASK_KIND, RESEARCH_REPORT_TASK_KIND } from "../capabilities/taskPlans.js";
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
  if (await seedResearchCapabilities(tx)) created = true;
  if (await seedKeeper(tx)) created = true;
  if (await seedTalk(tx)) created = true;
  if (await seedManager(tx)) created = true;
  return created;
}

// ---------------------------------------------------------------------------
// seedManager
// ---------------------------------------------------------------------------

export const MANAGER_AGENT_NAME = "Manager";
export const MISSIONS_PROJECT_NAME = "Missions";
export const MANAGER_PLAN_TASK_NAME = "Manager Plan";
export const MANAGER_REVIEW_TASK_NAME = "Manager Review";
export const MANAGER_PLAN_WORKFLOW_NAME = "Manager Plan";
export const MANAGER_RECOVER_TASK_NAME = "Manager Recovery";
export const MEETINGS_PROJECT_NAME = "Meetings";
export const MEETING_CONTRIBUTION_TASK_NAME = "Meeting Contribution";
export const MEETING_OUTCOME_TASK_NAME = "Meeting Outcome";
export const MANAGER_RECOVERY_WORKFLOW_NAME = "Manager Recovery";

/** The Manager's planning and review Context Budgets: a compact roster or a few handed deliverables, one structured reply. Documented placeholders. */
export const MANAGER_PLAN_CONTEXT_BUDGET: ContextBudget = {
  // R2 Stage 10: a third retrieved item — the Keep's recent history beside the roster and the calendar.
  // Raised deliberately: at 2, adding history would have silently evicted one of the other two as a
  // "budget" exclusion rather than failing loudly, and the Manager would have planned without a roster.
  maxInputTokens: 8_000,
  maxArtifactTokens: 3_000,
  maxRetrievedItems: 3,
  maxToolSchemaTokens: 0,
  compressionThreshold: 3_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 1_500,
};
export const MANAGER_REVIEW_CONTEXT_BUDGET: ContextBudget = { ...MANAGER_PLAN_CONTEXT_BUDGET, maxInputTokens: 9_000, maxArtifactTokens: 6_000, maxRetrievedItems: 5 };

/**
 * Manager Recovery's Context Budget: the runtime's own diagnosis and the roster, and nothing else. A
 * recovery never re-reads the failed work's output — the diagnosis already says what happened, in the
 * runtime's words.
 */
/**
 * A turn in a meeting: the agenda and what has been said, nothing else. No history and no other goals — an
 * agent speaks from its own role, not from the Keep's archive.
 */
export const MEETING_CONTRIBUTION_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 6_000,
  maxArtifactTokens: 3_000,
  maxRetrievedItems: 8,
  maxToolSchemaTokens: 0,
  compressionThreshold: 3_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 500,
};

/** Closing a meeting: every contribution in view, a short outcome out. */
export const MEETING_OUTCOME_CONTEXT_BUDGET: ContextBudget = { ...MEETING_CONTRIBUTION_CONTEXT_BUDGET, maxInputTokens: 9_000, maxArtifactTokens: 6_000, maxRetrievedItems: 12, expectedOutputTokens: 700 };

export const MANAGER_RECOVERY_CONTEXT_BUDGET: ContextBudget = { ...MANAGER_PLAN_CONTEXT_BUDGET, maxInputTokens: 5_000, maxArtifactTokens: 2_500, maxRetrievedItems: 2, expectedOutputTokens: 700 };

/**
 * R2 management layer: the Manager as ordinary Definitions. Two internal Capabilities with bindings,
 * the Manager agent (CHEAP tier) holding exactly two Grants - READ on the workforce roster and CREATE on
 * delegation, both autonomous because each delegated step is itself governed - the plan and review Task
 * Definitions, the "Missions" Project and the one-step "Manager Plan" Workflow. It holds no research,
 * publishing, approval, endorsement or inspection Grant. Each item is created only if missing.
 *
 * Workplace: + `workplace.inspect_calendar` (READ) and `workplace.schedule_meeting` (CREATE schedules,
 * WRITE moves or cancels), both autonomous because they change only internal office records. A Manager
 * whose latest version lacks them gets a new version holding all four Grants (an existing version is
 * never re-authorized), and "Manager Plan" gets a new version pinning it. The default meeting rooms are
 * created if missing.
 */
export async function seedManager(tx: DrizzleTransaction): Promise<boolean> {
  let created = false;
  const ensureCapability = async (contract: typeof MANAGER_DELEGATE_CAPABILITY, fn: string) => {
    const existing = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, contract.id) });
    if (existing) return existing.id;
    const c = await createCapability(tx, { name: contract.id, description: contract.description, staticRiskTag: contract.staticRiskTag, costProfile: contract.costProfile }, SEED_ACTOR);
    await createToolBinding(tx, { capabilityId: c.id, kind: "internal", config: { function: fn }, trustLevel: 2 }, SEED_ACTOR);
    created = true;
    return c.id;
  };
  const inspectId = await ensureCapability(MANAGER_INSPECT_WORKFORCE_CAPABILITY, MANAGER_WORKFORCE_READ);
  const delegateId = await ensureCapability(MANAGER_DELEGATE_CAPABILITY, MANAGER_DELEGATE_RECORD);
  const calendarId = await ensureCapability(WORKPLACE_INSPECT_CALENDAR_CAPABILITY, WORKPLACE_CALENDAR_READ);
  const meetingId = await ensureCapability(WORKPLACE_SCHEDULE_MEETING_CAPABILITY, WORKPLACE_MEETING_RECORD);
  const outcomeId = await ensureCapability(WORKPLACE_RECORD_OUTCOME_CAPABILITY, WORKPLACE_OUTCOME_RECORD);
  const historyId = await ensureCapability(MANAGER_INSPECT_HISTORY_CAPABILITY, MANAGER_HISTORY_READ);
  // The rooms are placed on the drawn rooms this world actually has, and repaired if a template switch moved them.
  if (await ensureDefaultRooms(tx, SEED_ACTOR, await activeAreaNames(tx))) created = true;

  const ensureTask = async (name: string, kind: string, budget: ContextBudget) => {
    let task = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, name) });
    if (!task) {
      const t = await createTaskDefinition(tx, { name, kind, defaultContextBudget: budget }, SEED_ACTOR);
      task = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, t.id) });
      created = true;
    }
    return task!;
  };
  const planTask = await ensureTask(MANAGER_PLAN_TASK_NAME, MANAGER_PLAN_KIND, MANAGER_PLAN_CONTEXT_BUDGET);
  await ensureTask(MANAGER_REVIEW_TASK_NAME, MANAGER_REVIEW_KIND, MANAGER_REVIEW_CONTEXT_BUDGET);
  const recoverTask = await ensureTask(MANAGER_RECOVER_TASK_NAME, MANAGER_RECOVER_KIND, MANAGER_RECOVERY_CONTEXT_BUDGET);
  // A meeting's own steps. The contribution task is generic: the round-table graph names the speaker.
  await ensureTask(MEETING_CONTRIBUTION_TASK_NAME, MEETING_CONTRIBUTION_KIND, MEETING_CONTRIBUTION_CONTEXT_BUDGET);
  await ensureTask(MEETING_OUTCOME_TASK_NAME, MEETING_OUTCOME_KIND, MEETING_OUTCOME_CONTEXT_BUDGET);

  const managerVersions = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, MANAGER_AGENT_NAME) });
  let agent: (typeof managerVersions)[number] | undefined = [...managerVersions].sort((x, y) => y.version - x.version)[0];
  // A Manager missing ANY of its Grants — a new Capability it has never held, or one the operator
  // revoked — gets a NEW version holding all five. Gating on a single Capability would leave a Manager
  // whose other Grant was revoked unrepaired for good. An existing version is never re-authorized.
  const required = [inspectId, delegateId, calendarId, meetingId, outcomeId, historyId];
  const heldNow = agent
    ? await tx.query.capabilityGrants.findMany({ where: and(eq(capabilityGrants.agentDefinitionId, agent.id), isNull(capabilityGrants.revokedAt)) })
    : [];
  const holdsAll = agent !== undefined && required.every((id) => heldNow.some((g) => g.capabilityId === id));
  if (!holdsAll) {
    const grant = (capabilityId: string, permissions: string[]) => ({ capabilityId, permissions, autonomyState: "AUTONOMOUS", maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED });
    const a = await createAgentDefinition(
      tx,
      {
        name: MANAGER_AGENT_NAME,
        ...(agent ? { previousVersion: agent.version } : {}),
        role: agent?.role ?? "Workforce coordinator",
        objective: agent?.objective ?? "Turn the operator's objectives into bounded, governed work for the right existing agents, check what they produce, and report the outcome truthfully.",
        instructions:
          agent?.instructions ??
          "Plan the fewest bounded tasks that meet the objective, using only existing agents and what they are allowed to do. Never do the specialist work yourself, " +
            "never claim authority you do not hold, and escalate to the operator when an objective needs a capability, approval, budget or decision you cannot provide. " +
            "Judge delegated work only against its completion criteria and say plainly what is missing.",
        executionProfile: agent?.executionProfile ?? { preferredTier: "CHEAP" },
        grants: [
          grant(inspectId, ["READ"]),
          grant(delegateId, [MANAGER_DELEGATE_PERMISSION]),
          grant(calendarId, ["READ"]),
          grant(meetingId, ["CREATE", "WRITE"]),
          grant(outcomeId, ["WRITE"]),
          grant(historyId, ["READ"]),
        ],
      },
      SEED_ACTOR
    );
    agent = await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, a.id) });
    created = true;
  }

  if (!(await tx.query.projects.findFirst({ where: eq(projects.name, MISSIONS_PROJECT_NAME) }))) {
    await tx.insert(projects).values({ name: MISSIONS_PROJECT_NAME, description: "Objectives the operator gave the Manager." });
    created = true;
  }

  // Meetings the Keep held live in their own Project, so a round table never makes the Manager "busy" for
  // a new mission and a mission never blocks a meeting: different work, different Goals.
  if (!(await tx.query.projects.findFirst({ where: eq(projects.name, MEETINGS_PROJECT_NAME) }))) {
    await tx.insert(projects).values({ name: MEETINGS_PROJECT_NAME, description: "Meetings the Command Keep actually held." });
    created = true;
  }

  const planVersions = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, MANAGER_PLAN_WORKFLOW_NAME) });
  const latestPlan = [...planVersions].sort((x, y) => y.version - x.version)[0];
  if (!(latestPlan && isLinearGraphDefinition(latestPlan.graphDefinition) && latestPlan.graphDefinition.steps[0]?.agentDefinitionId === agent!.id)) {
    await createWorkflowDefinition(
      tx,
      {
        name: MANAGER_PLAN_WORKFLOW_NAME,
        ...(latestPlan ? { previousVersion: latestPlan.version } : {}),
        graphDefinition: {
          kind: "linear",
          description: "The Manager reads the workforce, plans bounded tasks, and delegates what validation accepts.",
          steps: [{ stepId: "plan", label: "Plan", taskDefinitionId: planTask.id, taskDefinitionVersion: planTask.version, agentDefinitionId: agent!.id, agentDefinitionVersion: agent!.version }],
        },
      },
      SEED_ACTOR
    );
    created = true;
  }

  // The one-step Workflow a failed mission's recovery runs as. The mission driver starts it, within the
  // mission's own limits; every step inside it is an ordinary governed invocation.
  const recoveryVersions = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, MANAGER_RECOVERY_WORKFLOW_NAME) });
  const latestRecovery = [...recoveryVersions].sort((x, y) => y.version - x.version)[0];
  if (!(latestRecovery && isLinearGraphDefinition(latestRecovery.graphDefinition) && latestRecovery.graphDefinition.steps[0]?.agentDefinitionId === agent!.id)) {
    await createWorkflowDefinition(
      tx,
      {
        name: MANAGER_RECOVERY_WORKFLOW_NAME,
        ...(latestRecovery ? { previousVersion: latestRecovery.version } : {}),
        graphDefinition: {
          kind: "linear",
          description: "The Manager diagnoses failed delegated work from the runtime's records and recovers it, or escalates.",
          steps: [{ stepId: "recover", label: "Recover", taskDefinitionId: recoverTask.id, taskDefinitionVersion: recoverTask.version, agentDefinitionId: agent!.id, agentDefinitionVersion: agent!.version }],
        },
      },
      SEED_ACTOR
    );
    created = true;
  }
  return created;
}

// ---------------------------------------------------------------------------
// seedTalk
// ---------------------------------------------------------------------------

export const TALK_PROJECT_NAME = "Direct requests";
export const TALK_TASK_DEFINITION_NAME = "Agent Talk";

/** A Talk's Context Budget: the agent's own instructions, one request, one short reply. Documented placeholders. */
export const AGENT_TALK_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 3_000,
  maxArtifactTokens: 0,
  maxRetrievedItems: 0,
  maxToolSchemaTokens: 0,
  compressionThreshold: 2_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 900,
};

/**
 * R2 character interaction: the `agent_talk` Task Definition and the "Direct requests" Project that
 * holds what the operator asks agents in the world. The per-agent one-step Workflows are created on
 * first use through the Registry (`POST /agents/:id/talk`). Each is created only if missing.
 */
export async function seedTalk(tx: DrizzleTransaction): Promise<boolean> {
  let created = false;
  if (!(await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, TALK_TASK_DEFINITION_NAME) }))) {
    await createTaskDefinition(tx, { name: TALK_TASK_DEFINITION_NAME, kind: AGENT_TALK_KIND, defaultContextBudget: AGENT_TALK_CONTEXT_BUDGET }, SEED_ACTOR);
    created = true;
  }
  if (!(await tx.query.projects.findFirst({ where: eq(projects.name, TALK_PROJECT_NAME) }))) {
    await tx.insert(projects).values({ name: TALK_PROJECT_NAME, description: "What the operator asked agents directly in the world." });
    created = true;
  }
  return created;
}

/** The agent R2 recruits to do real research. Named for what it does, not for a provider. */
const FIELD_RESEARCHER_AGENT_NAME = "Field Researcher";

/**
 * R2: the two external research Capabilities, and one agent holding both.
 *
 * They are separate Capabilities on purpose. `research.search` reads public encyclopedic
 * and scholarly indexes over HTTP and costs nothing but a request; `research.web` searches
 * the live web inside a model call and costs real entitlement — measured at roughly 54,000
 * subscription tokens for a single question. An operator can therefore grant the cheap one
 * alone, and an agent holding only it cannot reach for the expensive one.
 *
 * `research.web` gets no Tool Binding: there is no tool to run, because the search happens
 * inside the model call (`../capabilities/researchWeb/loopAction.ts`).
 */
export async function seedResearchCapabilities(tx: DrizzleTransaction): Promise<boolean> {
  let created = false;

  // Both contracts, not one cast to the other: they differ in cost class, which is the
  // whole point of keeping them separate.
  const ensure = async (contract: typeof RESEARCH_SEARCH_CAPABILITY | typeof RESEARCH_WEB_CAPABILITY | typeof PEER_ENDORSE_CAPABILITY, fn: string | null): Promise<string> => {
    const existing = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, contract.id) });
    if (existing) return existing.id;
    const c = await createCapability(
      tx,
      { name: contract.id, description: contract.description, staticRiskTag: contract.staticRiskTag, costProfile: contract.costProfile },
      SEED_ACTOR
    );
    if (fn) await createToolBinding(tx, { capabilityId: c.id, kind: "internal", config: { function: fn }, trustLevel: 2 }, SEED_ACTOR);
    created = true;
    return c.id;
  };

  const searchId = await ensure(RESEARCH_SEARCH_CAPABILITY, RESEARCH_SEARCH_PUBLIC_INDEXES);
  const webId = await ensure(RESEARCH_WEB_CAPABILITY, null);
  // R2 progression: the endorsement Capability exists so an operator can grant it; no agent holds it by default.
  await ensure(PEER_ENDORSE_CAPABILITY, PEER_ENDORSE_RECORD);

  if (!(await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, FIELD_RESEARCHER_AGENT_NAME) }))) {
    await createAgentDefinition(
      tx,
      {
        name: FIELD_RESEARCHER_AGENT_NAME,
        role: "Research analyst",
        objective: "Gather real evidence on a question from public sources, and say plainly what the evidence does and does not show.",
        instructions:
          "Prefer the scholarly and encyclopedic sources; they are cheap and citable. Use the live web only when the answer must be current " +
          "or the other sources cannot hold it. Cite every source with its URL. Never present your own knowledge as something you researched.",
        grants: [
          { capabilityId: searchId, permissions: ["READ" as CapabilityPermission], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED },
          { capabilityId: webId, permissions: ["READ" as CapabilityPermission], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED },
        ],
      },
      SEED_ACTOR
    );
    created = true;
  }

  return created;
}

// ---------------------------------------------------------------------------
// seedKeeper
// ---------------------------------------------------------------------------

export const KEEPER_PROJECT_NAME = "Keeper";
export const KEEPER_AGENT_NAME = "Keeper";
export const KEEPER_TASK_DEFINITION_NAME = "Keeper Answer";
export const KEEPER_WORKFLOW_NAME = "Keeper Think";

/** Keeper Think's Context Budget: a small snapshot, a few guide cards, a short answer. Documented placeholders. */
export const KEEPER_ANSWER_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 6_000,
  maxArtifactTokens: 2_500,
  maxRetrievedItems: 4,
  maxToolSchemaTokens: 0,
  compressionThreshold: 2_500,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 1_200,
};

/**
 * The Keeper as ordinary Definitions (no special case in the runtime): the READ-only
 * `system.inspect` and `docs.retrieve` Capabilities with their bindings, the "Keeper"
 * Agent (CHEAP tier; READ Grants only, autonomous because they only read), the
 * `keeper_answer` Task Definition, the "Keeper" Project that holds Think questions, and
 * the one-step "Keeper Think" Workflow. Each is created only if missing.
 *
 * R2 observability: + the READ-only `system.keep_stats` Capability. A Keeper whose latest version lacks its
 * Grant gets a new version holding all three READ Grants (an existing version is never re-authorized), and
 * Keeper Think gets a new version pinning it. The Manager is never granted it.
 */
export async function seedKeeper(tx: DrizzleTransaction): Promise<boolean> {
  let created = false;
  const ensureCapability = async (contract: typeof SYSTEM_INSPECT_CAPABILITY, fn: string) => {
    const existing = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, contract.id) });
    if (existing) return existing.id;
    const c = await createCapability(
      tx,
      { name: contract.id, description: contract.description, staticRiskTag: contract.staticRiskTag, costProfile: contract.costProfile },
      SEED_ACTOR
    );
    await createToolBinding(tx, { capabilityId: c.id, kind: "internal", config: { function: fn }, trustLevel: 2 }, SEED_ACTOR);
    created = true;
    return c.id;
  };
  const inspectId = await ensureCapability(SYSTEM_INSPECT_CAPABILITY, SYSTEM_INSPECT_READ);
  const docsId = await ensureCapability(DOCS_RETRIEVE_CAPABILITY, DOCS_RETRIEVE_GUIDE);

  let task = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.name, KEEPER_TASK_DEFINITION_NAME) });
  if (!task) {
    const t = await createTaskDefinition(tx, { name: KEEPER_TASK_DEFINITION_NAME, kind: KEEPER_ANSWER_KIND, defaultContextBudget: KEEPER_ANSWER_CONTEXT_BUDGET }, SEED_ACTOR);
    task = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, t.id) });
    created = true;
  }

  const statsId = await ensureCapability(KEEP_STATS_CAPABILITY, KEEP_STATS_READ);
  const keeperGrants = [inspectId, docsId, statsId].map((capabilityId) => ({
    capabilityId,
    permissions: ["READ"],
    autonomyState: "AUTONOMOUS",
    maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
  }));
  const keeperVersions = await tx.query.agentDefinitions.findMany({ where: eq(agentDefinitions.name, KEEPER_AGENT_NAME) });
  let agent: (typeof keeperVersions)[number] | undefined = [...keeperVersions].sort((x, y) => y.version - x.version)[0];
  const holdsStats =
    agent && (await tx.query.capabilityGrants.findFirst({ where: and(eq(capabilityGrants.agentDefinitionId, agent.id), eq(capabilityGrants.capabilityId, statsId), isNull(capabilityGrants.revokedAt)) }));
  if (!holdsStats) {
    const a = await createAgentDefinition(
      tx,
      {
        name: KEEPER_AGENT_NAME,
        ...(agent ? { previousVersion: agent.version } : {}),
        role: agent?.role ?? "The Command Keep's guide",
        objective: agent?.objective ?? "Help the operator understand and operate the Command Keep, from its real records.",
        instructions: agent?.instructions ?? "Explain plainly and briefly. Read state only through your capabilities. Never claim to change anything; propose instead.",
        executionProfile: agent?.executionProfile ?? { preferredTier: "CHEAP" },
        grants: keeperGrants,
      },
      SEED_ACTOR
    );
    agent = await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, a.id) });
    created = true;
  }

  if (!(await tx.query.projects.findFirst({ where: eq(projects.name, KEEPER_PROJECT_NAME) }))) {
    await tx.insert(projects).values({ name: KEEPER_PROJECT_NAME, description: "Questions the operator asked the Keeper to think about." });
    created = true;
  }

  const thinkVersions = await tx.query.workflowDefinitions.findMany({ where: eq(workflowDefinitions.name, KEEPER_WORKFLOW_NAME) });
  const latestThink = [...thinkVersions].sort((x, y) => y.version - x.version)[0];
  const pinsLatestKeeper = latestThink && isLinearGraphDefinition(latestThink.graphDefinition) && latestThink.graphDefinition.steps[0]?.agentDefinitionId === agent!.id;
  if (!pinsLatestKeeper) {
    await createWorkflowDefinition(
      tx,
      {
        name: KEEPER_WORKFLOW_NAME,
        ...(latestThink ? { previousVersion: latestThink.version } : {}),
        graphDefinition: {
          kind: "linear",
          description: "The Keeper thinks about one operator question, reading state and guide cards only.",
          steps: [
            { stepId: "answer", label: "Answer", taskDefinitionId: task!.id, taskDefinitionVersion: task!.version, agentDefinitionId: agent!.id, agentDefinitionVersion: agent!.version },
          ],
        },
      },
      SEED_ACTOR
    );
    created = true;
  }
  return created;
}

/**
 * `seedResearchWorkflow` — Unit 8's seed data: everything Phase 18.2's
 * workflow 1 ("Research -> Report") needs to run as a standalone Task
 * Instance (via Unit 6's `createStandaloneTaskInstance`, not the Workflow
 * Interpreter).
 *
 * Inserts, in dependency order:
 *   1. `capabilities` — one row for `RESEARCH_RETRIEVE_CAPABILITY`. The
 *      capability's logical id ("research.retrieve") is stored in the
 *      `name` column — the MVP schema (`src/db/schema.ts`) has no separate
 *      slug/key column, and `capabilities.id` is a DB-generated uuid.
 *   2. `tool_bindings` — one row pointing at that capability. `kind:
 *      "internal"` (an in-process implementation, not a real external API —
 *      see `../capabilities/researchRetrieve/toolBinding.ts`'s header).
 *      `trustLevel: 2` is an MVP placeholder consistent with Unit 6's
 *      `mapTrustLevel` scheme (`trustLevel >= 2` -> "first_party", the most
 *      trusted category) — reasonable for an in-process, first-party-owned
 *      implementation with no external trust boundary.
 *   3. `projects` / `goals` — one minimal Project and one Goal under it.
 *   4. `agent_definitions` — the "Researcher" Agent Definition.
 *   5. `capability_grants` — Researcher -> `research.retrieve` at `READ`,
 *      `autonomyState: "AUTONOMOUS"`. Valid per Unit 3's
 *      `validateCapabilityGrant`: the structural autonomy ceiling (Phase
 *      9.4) only restricts SPEND/TRADE/PUBLISH/DELETE, never READ. This
 *      function calls `validateCapabilityGrant` itself, BEFORE inserting the
 *      row, and throws if it ever reports invalid — fail-closed, not just a
 *      test-time assertion.
 *   6. `task_definitions` — "Research-Report", carrying
 *      `DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET` (a real `ContextBudget`
 *      shape, not a placeholder `{}`) in `default_context_budget`.
 *
 * `MVP_MAX_TRUST_LEVEL_REQUIRED` (`capability_grants.max_trust_level_required`)
 * is the Grant's declared MINIMUM binding trust level. As of final-review
 * Finding 2 this field is load-bearing: `evaluatePolicy` compares it against
 * the resolved Tool Binding's `trust_level` and DENYs when the binding falls
 * short (Phase 6 / 9.2) — it is no longer the inert placeholder this header
 * previously described. The value 1 ("verified third-party") remains an MVP
 * choice, but it is now a real bar: both seeded bindings are `trustLevel: 2`
 * ("first party"), so both clear it, and lowering a binding below 1 without
 * lowering the Grant would correctly deny it.
 */
import {
  agentDefinitions,
  capabilities,
  capabilityGrants,
  goals,
  projects,
  taskDefinitions,
  toolBindings,
  workflowDefinitions,
} from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { validateCapabilityGrant } from "../governance/policy.js";
import type { CapabilityGrant, CapabilityPermission } from "../governance/policy.js";
import type { ContextBudget } from "../context/types.js";
import type { LinearGraphDefinition } from "../workflow/graphTypes.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "../capabilities/researchRetrieve/capability.js";
import { PUBLISH_REPORT_CAPABILITY } from "../capabilities/publishReport/capability.js";
import { RESEARCH_RETRIEVE_SYNTHETIC } from "../capabilities/researchRetrieve/adapter.js";
import { PUBLISH_REPORT_FILESYSTEM } from "../capabilities/publishReport/adapter.js";

/**
 * MVP default Context Budget for the "Research-Report" Task Definition.
 * Values are documented placeholders (no product-specified sizing exists
 * yet), chosen to comfortably fit one small tool-result artifact (tier 2)
 * alongside the task's own input (tier 1) for a CHEAP-tier LLM call:
 *   - `maxInputTokens: 8_000` / `expectedOutputTokens: 500`: generous for a
 *     short synthesized report, small enough to keep the CHEAP-tier Pass-1
 *     cost estimate (`maxInputTokens * inputPerToken + expectedOutputTokens
 *     * outputPerToken`) trivially cheap (~0.0105 at CHEAP's current
 *     0.000001 input / 0.000005 output per token).
 *   - `maxArtifactTokens: 2_000` / `compressionThreshold: 2_000`: the tool's
 *     synthesized result set is tiny (a couple hundred tokens at most), so
 *     this is headroom, not a tight constraint.
 *   - `maxRetrievedItems: 10`: this workflow only ever produces one
 *     candidate artifact (the tool's result), so this is a non-binding cap.
 *   - `maxToolSchemaTokens: 1_000`: this workflow's LLM step passes no
 *     `candidateToolCapabilityIds` (Ruling — the LLM synthesizes from the
 *     already-persisted artifact, it does not itself call tools), so this is
 *     also non-binding; kept non-zero for schema completeness only.
 *   - `freshnessRequirementSeconds: 0`: no staleness requirement — the
 *     artifact is produced and consumed within the same Run.
 */
/**
 * The trust bar both seeded V1 Grants declare (see this module's header). A
 * single constant, not a literal repeated per call site, because the same
 * value must reach BOTH the `CapabilityGrant` passed to
 * `validateCapabilityGrant` and the `capability_grants` row inserted — now
 * that Policy enforces it, the two drifting apart would mean validating a
 * different bar from the one actually stored.
 */
const MVP_MAX_TRUST_LEVEL_REQUIRED = 1;

export const DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 8_000,
  maxArtifactTokens: 2_000,
  maxRetrievedItems: 10,
  maxToolSchemaTokens: 1_000,
  compressionThreshold: 2_000,
  freshnessRequirementSeconds: 0,
  expectedOutputTokens: 500,
};

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
  const [capability] = await tx
    .insert(capabilities)
    .values({
      name: RESEARCH_RETRIEVE_CAPABILITY.id,
      description: RESEARCH_RETRIEVE_CAPABILITY.description,
      staticRiskTag: RESEARCH_RETRIEVE_CAPABILITY.staticRiskTag,
      costProfile: RESEARCH_RETRIEVE_CAPABILITY.costProfile,
    })
    .returning();
  const capabilityId = capability!.id;

  const [toolBinding] = await tx
    .insert(toolBindings)
    .values({
      capabilityId,
      kind: "internal",
      config: { function: RESEARCH_RETRIEVE_SYNTHETIC },
      trustLevel: 2,
      version: 1,
    })
    .returning();
  const toolBindingId = toolBinding!.id;

  const [project] = await tx
    .insert(projects)
    .values({ name: "Research Workflow", description: "Unit 8 standalone research -> report workflow" })
    .returning();
  const projectId = project!.id;

  const [goal] = await tx
    .insert(goals)
    .values({
      projectId,
      title: "Produce a research report",
      description: "Retrieve information on a topic and synthesize it into a report.",
      status: "active",
    })
    .returning();
  const goalId = goal!.id;

  const [agentDefinition] = await tx
    .insert(agentDefinitions)
    .values({
      name: "Researcher",
      version: 1,
      role: "Research Analyst",
      objective: "Retrieve relevant information for a query and synthesize it into a concise report.",
      instructions: "Use the research.retrieve capability to gather information, then synthesize a report from it.",
      memoryPolicy: {},
      escalationPolicy: {},
    })
    .returning();
  const agentDefinitionId = agentDefinition!.id;
  const agentDefinitionVersion = agentDefinition!.version;

  // Fail-closed: validate BEFORE inserting, not just in a test after the
  // fact. Constructed as the exact `CapabilityGrant` shape Unit 3's
  // `validateCapabilityGrant` expects (policy.ts's type, not the raw DB row
  // shape — `permissions` there is untyped `string[]`).
  const grantToValidate: CapabilityGrant = {
    agentDefinitionId,
    agentDefinitionVersion,
    capabilityId,
    permissions: RESEARCH_RETRIEVE_PERMISSIONS,
    maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
    autonomyState: RESEARCH_RETRIEVE_AUTONOMY_STATE,
  };
  const validation = validateCapabilityGrant(grantToValidate);
  if (!validation.valid) {
    throw new Error(`seedResearchWorkflow: seeded Grant failed validateCapabilityGrant: ${validation.reason}`);
  }

  const [capabilityGrant] = await tx
    .insert(capabilityGrants)
    .values({
      agentDefinitionId,
      agentDefinitionVersion,
      capabilityId,
      permissions: RESEARCH_RETRIEVE_PERMISSIONS,
      scope: {},
      maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
      autonomyState: RESEARCH_RETRIEVE_AUTONOMY_STATE,
    })
    .returning();
  const capabilityGrantId = capabilityGrant!.id;

  const [taskDefinition] = await tx
    .insert(taskDefinitions)
    .values({
      name: "Research-Report",
      kind: "standalone",
      inputSchema: {},
      outputSchema: {},
      defaultContextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
      version: 1,
    })
    .returning();
  const taskDefinitionId = taskDefinition!.id;
  const taskDefinitionVersion = taskDefinition!.version;

  return {
    projectId,
    goalId,
    agentDefinitionId,
    agentDefinitionVersion,
    taskDefinitionId,
    taskDefinitionVersion,
    capabilityId,
    toolBindingId,
    capabilityGrantId,
  };
}

// ---------------------------------------------------------------------------
// seedPublishWorkflow — Unit 9 addition (extends, never modifies, the above)
// ---------------------------------------------------------------------------

/**
 * `seedPublishWorkflow` — Unit 9's seed data for Phase 18.2's Workflow 2
 * ("Research -> Report -> Review-and-Publish"), a two-step Workflow
 * Definition driven by Unit 7's Workflow Interpreter (`startWorkflowRun`/
 * `advanceWorkflowRun`), unlike Unit 8's standalone Task Instance.
 *
 * Per Ruling 7 (task-9-brief.md): REUSES Unit 8's exact "Research-Report"
 * Task Definition (and its Researcher Agent Definition / `research.retrieve`
 * Capability / Grant) as Workflow 2's step 0 — by calling
 * `seedResearchWorkflow(tx)` internally and reusing its returned ids
 * verbatim, NOT by re-inserting a second, parallel copy of those rows. This
 * function is a strict ADDITION alongside `seedResearchWorkflow`
 * (unmodified above) rather than a replacement of it, per the brief's
 * explicit "Modify: add... do not replace" instruction.
 *
 * Additionally inserts, in dependency order:
 *   1. `capabilities` / `tool_bindings` for `PUBLISH_REPORT_CAPABILITY`.
 *      `kind: "internal"` — same reasoning as Unit 8's `research.retrieve`
 *      binding (`./seed.ts`'s own comment on that row): this is an
 *      in-process, first-party-owned proof binding
 *      (`../capabilities/publishReport/toolBinding.ts`), not a real external
 *      API integration, so `trustLevel: 2` ("first_party") is reused too.
 *   2. `agent_definitions` — the "Publisher" Agent Definition.
 *   3. `capability_grants` — Publisher -> `publish.report` at `PUBLISH`,
 *      `autonomyState: "ALWAYS_APPROVE"`. Validated via
 *      `validateCapabilityGrant` BEFORE inserting (fail-closed, same
 *      convention as `seedResearchWorkflow` above) — `PUBLISH` +
 *      `ALWAYS_APPROVE` passes Phase 9.4's structural ceiling (which only
 *      rejects `AUTONOMOUS` for SPEND/TRADE/PUBLISH/DELETE); `AUTONOMOUS`
 *      would be rejected, which is exactly what keeps this Grant out of
 *      scope for anything but `ALWAYS_APPROVE` (Out of scope, brief).
 *   4. `task_definitions` — "Review-and-Publish" (Ruling 4: this Task is
 *      `publish.report`-only, no LLM step of its own — the "review" is the
 *      Grant's Approval gate itself).
 *   5. `workflow_definitions` — a two-step `LinearGraphDefinition`
 *      (`src/workflow/graphTypes.ts`) referencing "Research-Report" (reused
 *      from `seedResearchWorkflow`) as step 0 and "Review-and-Publish" as
 *      step 1, in order.
 *
 * Documented cosmetic note (not a functional issue): the reused
 * "Research-Report" `task_definitions.kind` column still reads
 * `"standalone"` (Unit 8's own label, describing how IT was originally
 * exercised) even though this workflow now also drives it via
 * `createWorkflowTaskInstance`. `kind` is a free-text label nothing in this
 * codebase branches on (confirmed by grep) — changing it would mean
 * mutating a row Unit 8's own frozen test asserts against
 * (`taskDefinition?.kind` is never asserted there, but `seedResearchWorkflow`
 * itself is frozen/unmodified per this unit's constraints), so it is left
 * exactly as Unit 8 seeded it.
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

  const [publishCapability] = await tx
    .insert(capabilities)
    .values({
      name: PUBLISH_REPORT_CAPABILITY.id,
      description: PUBLISH_REPORT_CAPABILITY.description,
      staticRiskTag: PUBLISH_REPORT_CAPABILITY.staticRiskTag,
      costProfile: PUBLISH_REPORT_CAPABILITY.costProfile,
    })
    .returning();
  const publishCapabilityId = publishCapability!.id;

  const [publishToolBinding] = await tx
    .insert(toolBindings)
    .values({
      capabilityId: publishCapabilityId,
      kind: "internal",
      config: { function: PUBLISH_REPORT_FILESYSTEM },
      trustLevel: 2,
      version: 1,
    })
    .returning();
  const publishToolBindingId = publishToolBinding!.id;

  const [publisherAgentDefinition] = await tx
    .insert(agentDefinitions)
    .values({
      name: "Publisher",
      version: 1,
      role: "Publishing Reviewer",
      objective: "Review a synthesized report and publish it to the proof-of-governance output location.",
      instructions: "Use the publish.report capability to publish the report Artifact produced by the Research-Report task.",
      memoryPolicy: {},
      escalationPolicy: {},
    })
    .returning();
  const publisherAgentDefinitionId = publisherAgentDefinition!.id;
  const publisherAgentDefinitionVersion = publisherAgentDefinition!.version;

  const grantToValidate: CapabilityGrant = {
    agentDefinitionId: publisherAgentDefinitionId,
    agentDefinitionVersion: publisherAgentDefinitionVersion,
    capabilityId: publishCapabilityId,
    permissions: PUBLISH_REPORT_PERMISSIONS,
    maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
    autonomyState: PUBLISH_REPORT_AUTONOMY_STATE,
  };
  const validation = validateCapabilityGrant(grantToValidate);
  if (!validation.valid) {
    throw new Error(`seedPublishWorkflow: seeded Grant failed validateCapabilityGrant: ${validation.reason}`);
  }

  const [publishCapabilityGrant] = await tx
    .insert(capabilityGrants)
    .values({
      agentDefinitionId: publisherAgentDefinitionId,
      agentDefinitionVersion: publisherAgentDefinitionVersion,
      capabilityId: publishCapabilityId,
      permissions: PUBLISH_REPORT_PERMISSIONS,
      scope: {},
      maxTrustLevelRequired: MVP_MAX_TRUST_LEVEL_REQUIRED,
      autonomyState: PUBLISH_REPORT_AUTONOMY_STATE,
    })
    .returning();
  const publishCapabilityGrantId = publishCapabilityGrant!.id;

  const [reviewAndPublishTaskDefinition] = await tx
    .insert(taskDefinitions)
    .values({
      name: "Review-and-Publish",
      kind: "workflow-step",
      inputSchema: {},
      outputSchema: {},
      defaultContextBudget: {},
      version: 1,
    })
    .returning();
  const reviewAndPublishTaskDefinitionId = reviewAndPublishTaskDefinition!.id;
  const reviewAndPublishTaskDefinitionVersion = reviewAndPublishTaskDefinition!.version;

  const graphDefinition: LinearGraphDefinition = {
    kind: "linear",
    steps: [
      { taskDefinitionId: research.taskDefinitionId, taskDefinitionVersion: research.taskDefinitionVersion },
      { taskDefinitionId: reviewAndPublishTaskDefinitionId, taskDefinitionVersion: reviewAndPublishTaskDefinitionVersion },
    ],
  };

  const [workflowDefinition] = await tx
    .insert(workflowDefinitions)
    .values({
      name: "Research-and-Publish",
      version: 1,
      graphDefinition,
    })
    .returning();
  const workflowDefinitionId = workflowDefinition!.id;
  const workflowDefinitionVersion = workflowDefinition!.version;

  return {
    ...research,
    publishCapabilityId,
    publishToolBindingId,
    publisherAgentDefinitionId,
    publisherAgentDefinitionVersion,
    publishCapabilityGrantId,
    reviewAndPublishTaskDefinitionId,
    reviewAndPublishTaskDefinitionVersion,
    workflowDefinitionId,
    workflowDefinitionVersion,
  };
}

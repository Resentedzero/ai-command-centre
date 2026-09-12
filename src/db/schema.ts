/**
 * Drizzle table definitions — MVP subset of Phase 12's data model.
 *
 * Scope: exactly the tables named in Unit 1's brief. Excluded per Phase 18.1
 * (deferred): `memory_items`, `agent_performance`, `agent_xp_projection`.
 * Also excluded: `policies` (Phase 12 lists it, but it is out of this unit's
 * scope per the brief's table list — no policy engine exists yet).
 *
 * Column shapes follow Phase 12 verbatim, with one deliberate addition: the
 * `events` table carries `idempotency_key`, `event_version`, and `producer`
 * in addition to Phase 12's list, because Phase 8.1's frozen envelope (as
 * specified by this unit's brief) requires them and Phase 12 predates that
 * detail. Everything else is a direct transcription — no speculative columns.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const genId = () => randomUUID();

// ---------------------------------------------------------------------------
// Enums (fixed vocabularies called out explicitly in the spec)
// ---------------------------------------------------------------------------

export const toolBindingKind = pgEnum("tool_binding_kind", [
  "internal",
  "direct_api",
  "mcp",
  "browser",
  "process",
  "webhook",
]);

export const invocationKind = pgEnum("invocation_kind", [
  "llm",
  "tool",
  "retrieval",
  "deterministic",
  "browser",
]);

export const budgetCounterScope = pgEnum("budget_counter_scope", [
  "run",
  "task_instance",
  "agent_definition",
  "goal",
  "day",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

// ---------------------------------------------------------------------------
// Definitions (versioned; human/config-authored; rarely change at runtime)
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const capabilities = pgTable("capabilities", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  name: text("name").notNull(),
  description: text("description"),
  staticRiskTag: text("static_risk_tag").notNull(),
  costProfile: jsonb("cost_profile").$type<Record<string, unknown>>(),
});

export const toolBindings = pgTable("tool_bindings", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  capabilityId: uuid("capability_id")
    .notNull()
    .references(() => capabilities.id),
  kind: toolBindingKind("kind").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>(),
  trustLevel: integer("trust_level").notNull(),
  version: integer("version").notNull(),
});

export const agentDefinitions = pgTable("agent_definitions", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  role: text("role").notNull(),
  objective: text("objective").notNull(),
  instructions: text("instructions").notNull(),
  memoryPolicy: jsonb("memory_policy").$type<Record<string, unknown>>(),
  escalationPolicy: jsonb("escalation_policy").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const capabilityGrants = pgTable("capability_grants", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  agentDefinitionId: uuid("agent_definition_id")
    .notNull()
    .references(() => agentDefinitions.id),
  agentDefinitionVersion: integer("agent_definition_version").notNull(),
  capabilityId: uuid("capability_id")
    .notNull()
    .references(() => capabilities.id),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  scope: jsonb("scope").$type<Record<string, unknown>>(),
  maxTrustLevelRequired: integer("max_trust_level_required").notNull(),
  autonomyState: text("autonomy_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskDefinitions = pgTable("task_definitions", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
  outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
  defaultContextBudget: jsonb("default_context_budget").$type<Record<string, unknown>>(),
  version: integer("version").notNull(),
});

export const workflowDefinitions = pgTable("workflow_definitions", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  graphDefinition: jsonb("graph_definition").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Runtime instances
// ---------------------------------------------------------------------------

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  workflowDefinitionId: uuid("workflow_definition_id")
    .notNull()
    .references(() => workflowDefinitions.id),
  workflowDefinitionVersion: integer("workflow_definition_version").notNull(),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => goals.id),
  status: text("status").notNull(),
  variables: jsonb("variables").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const taskInstances = pgTable("task_instances", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  taskDefinitionId: uuid("task_definition_id")
    .notNull()
    .references(() => taskDefinitions.id),
  taskDefinitionVersion: integer("task_definition_version").notNull(),
  workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  status: text("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  taskInstanceId: uuid("task_instance_id")
    .notNull()
    .references(() => taskInstances.id),
  agentDefinitionId: uuid("agent_definition_id").references(() => agentDefinitions.id),
  agentDefinitionVersion: integer("agent_definition_version"),
  status: text("status").notNull(),
  budgetEnvelope: jsonb("budget_envelope").$type<Record<string, unknown>>(),
  outcome: jsonb("outcome").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const invocations = pgTable("invocations", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  seqNo: integer("seq_no").notNull(),
  kind: invocationKind("kind").notNull(),
  costClass: text("cost_class").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Execution ledger
// ---------------------------------------------------------------------------

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().$defaultFn(genId),
    // Caller-supplied dedup key (Phase 3e/8.1's idempotency requirement) — the
    // actual unique constraint enforcing "re-emitting is a no-op".
    idempotencyKey: text("idempotency_key").notNull().unique(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    sequenceNo: integer("sequence_no").notNull(),
    causationId: uuid("causation_id"),
    goalId: uuid("goal_id"),
    workflowRunId: uuid("workflow_run_id"),
    taskInstanceId: uuid("task_instance_id"),
    runId: uuid("run_id"),
    invocationId: uuid("invocation_id"),
    actor: text("actor").notNull(),
    producer: text("producer").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    cacheHit: boolean("cache_hit"),
    costAmount: numeric("cost_amount"),
    modelId: text("model_id"),
  },
  (table) => [
    // sequenceNo is authoritative for ordering (Phase 8.1) — enforce
    // uniqueness per runId at the database level too, not just via
    // emitEvent's advisory lock, so no insert path can silently produce
    // duplicate sequence numbers for the same run. (NULL runId rows are not
    // covered by a plain unique index — Postgres treats NULLs as distinct —
    // so that shared "no run" bucket relies on emitEvent's advisory lock
    // alone; acceptable since real Runs always carry a runId.)
    uniqueIndex("events_run_id_sequence_no_idx")
      .on(table.runId, table.sequenceNo)
      .where(sql`${table.runId} is not null`),
  ]
);

export const budgetCounters = pgTable("budget_counters", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  scope: budgetCounterScope("scope").notNull(),
  scopeRefId: text("scope_ref_id").notNull(),
  limitAmount: numeric("limit_amount").notNull(),
  reservedAmount: numeric("reserved_amount").notNull().default("0"),
  consumedAmount: numeric("consumed_amount").notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  invocationId: uuid("invocation_id")
    .notNull()
    .references(() => invocations.id),
  proposedActionSnapshot: jsonb("proposed_action_snapshot").$type<Record<string, unknown>>().notNull(),
  riskTier: text("risk_tier").notNull(),
  status: approvalStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
  ttl: timestamp("ttl", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().$defaultFn(genId),
  type: text("type").notNull(),
  version: integer("version").notNull(),
  producingInvocationId: uuid("producing_invocation_id").references(() => invocations.id),
  hash: text("hash").notNull(),
  size: integer("size").notNull(),
  storageReference: text("storage_reference"),
  inlineContent: text("inline_content"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

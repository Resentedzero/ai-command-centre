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
  bigserial,
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
  // Unit 3 addition (pre-dispatch ruling): the concrete representation of
  // "revocation status" — a grant with revokedAt !== null is revoked.
  // `reauthorize` checks this immediately before execution (Phase 9.5).
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
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
  // Unit 3 additions (pre-dispatch ruling): which Capability/permission this
  // invocation exercises. Both null for LLM/deterministic/retrieval
  // invocations that never go through Policy at all. Together with
  // `runs.agentDefinitionId`/`agentDefinitionVersion`, this is what lets
  // `reauthorize(tx, invocationId)` find the governing Grant from just an
  // invocationId, with no other input.
  capabilityId: uuid("capability_id").references(() => capabilities.id),
  permission: text("permission"),
  // The CURRENT/mutable proposed action for this invocation — distinct from
  // `approvals.proposedActionSnapshot`, which is the FROZEN snapshot taken at
  // Approval-creation time and never changes after creation. `reauthorize`
  // compares these two; a difference means the action was mutated after
  // Approval creation (material-change invalidation, Phase 9.5).
  proposedActionSnapshot: jsonb("proposed_action_snapshot").$type<Record<string, unknown>>(),
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
    // Final-review Finding 3 addition. `sequence_no` above is monotonic ONLY
    // per `run_id` (Phase 8.1) and remains THE authoritative causal-ordering
    // field — this column does not replace it and nothing that reasons about
    // ordering WITHIN one run should use this instead.
    //
    // `global_seq` exists for exactly one purpose: a genuinely globally
    // monotonic value an SSE client can use as a replay/reconnect CURSOR
    // (Phase 15.3 — the stream is "a delivery mechanism, not a second source
    // of truth", so resuming needs a position that is total-ordered across
    // every run, which a per-run counter can never be). `events.id` is a uuid
    // and therefore not orderable, so a dedicated column is required.
    //
    // Assigned by a Postgres sequence, so it is unique and gap-tolerant by
    // construction — no application-side max+1 computation and no advisory
    // lock, unlike `sequence_no`.
    globalSeq: bigserial("global_seq", { mode: "number" }).notNull(),
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
    // The replay/reconnect cursor is read as `global_seq > N ORDER BY
    // global_seq ASC` (`../api/routes/events.ts`) — index it, and make the
    // "globally unique" half of "globally monotonic" a structural DB
    // invariant rather than something that merely happens to be true because
    // a sequence currently backs the column.
    uniqueIndex("events_global_seq_idx").on(table.globalSeq),
  ]
);

export const budgetCounters = pgTable(
  "budget_counters",
  {
    id: uuid("id").primaryKey().$defaultFn(genId),
    scope: budgetCounterScope("scope").notNull(),
    scopeRefId: text("scope_ref_id").notNull(),
    limitAmount: numeric("limit_amount").notNull(),
    reservedAmount: numeric("reserved_amount").notNull().default("0"),
    consumedAmount: numeric("consumed_amount").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one counter row per scope key (Unit 2 ruling). Without this,
    // two concurrent reserveBudget calls that both find "no row yet" for a
    // key could each attempt to work against/insert a distinct row for the
    // same key, breaking the single-row-per-scope invariant reserveBudget's
    // SELECT ... FOR UPDATE locking depends on for atomicity.
    uniqueIndex("budget_counters_scope_scope_ref_id_idx").on(table.scope, table.scopeRefId),
  ]
);

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export const approvals = pgTable(
  "approvals",
  {
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
  },
  (table) => [
    // Unit 3 fix-round-1 addition: exactly one Approval per invocation. An
    // Approval is bound to THE EXACT proposed-action snapshot for its
    // invocation (immutable once created) — without this, a second Approval
    // row for the same invocation would make reauthorize's lookup
    // nondeterministic (findFirst would pick an arbitrary one of several
    // matching rows). This makes "one Approval per invocation" a structural
    // invariant rather than a convention.
    uniqueIndex("approvals_invocation_id_idx").on(table.invocationId),
  ]
);

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

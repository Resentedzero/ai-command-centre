/**
 * Drizzle table definitions — MVP subset of Phase 12's data model.
 *
 * Scope: the tables named in Unit 1's brief, plus later additions (execution
 * stops, budget counters, quota state, `agent_performance` in V2,
 * `../projections/agentPerformance.ts`). Excluded per Phase 18.1 (deferred):
 * `memory_items`, `agent_xp_projection`. Also excluded: `policies` (Phase 12
 * lists it; Policy is code, `../governance/policy.ts`, ROADMAP_STATUS §6).
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
  primaryKey,
  check,
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

/**
 * Scopes at which execution can be halted (Phase 9.7 emergency stop).
 *
 * Deliberately its own enum rather than reusing `budget_counter_scope`: that
 * one's members are budget rollup levels (`day`, `task_instance`) and
 * `budget.ts` already narrows it to a different subset. Sharing an enum between
 * two unrelated vocabularies would make both harder to change.
 */
export const executionStopScope = pgEnum("execution_stop_scope", [
  "global",
  "agent_definition",
  "capability_grant",
  "goal",
  "workflow_run",
  "run",
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
  // The lowest model tier this Run's LLM Invocations may route to: set on a retry
  // after an output-validation failure (spec §10.4, `governance/retryPolicy.ts`).
  // Null for a first attempt. Read by the Model Router; never lowers a tier.
  minimumModelTier: text("minimum_model_tier"),
  // Which attempt of its Task Instance this Run is: 1, then 2 and 3 for retries.
  attempt: integer("attempt").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  // An unrecognized floor must not be read as "no floor": refuse it at the source.
  check("runs_minimum_model_tier_check", sql`${table.minimumModelTier} is null or ${table.minimumModelTier} in ('CHEAP', 'MID', 'STRONG')`),
]);

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
  // The Tool Binding this invocation was authorized against, persisted at
  // propose time (closes NEXT_PHASE_PLAN Appendix A #4). Without it, resuming
  // after an Approval could not re-check the binding's trust against the
  // Grant's bar — the caller-supplied `toolBindingId` on resume matched
  // nothing persisted. Null for non-tool invocations.
  toolBindingId: uuid("tool_binding_id").references(() => toolBindings.id),
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

// Immutable since migration 0016 (a trigger refuses UPDATE, DELETE and TRUNCATE).
// A backfill migration that must UPDATE events, as 0006 did, has to
// `DISABLE TRIGGER events_immutable` first, inside its own transaction.
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
    // Added 2026-09-13 (amended Phase 10.6/12): `cost_amount` is meaningless
    // without the unit it is denominated in, once more than one resource unit
    // exists. Nullable ONLY because non-usage events have no usage at all —
    // `emitEvent` requires it whenever `usage` is non-null, so a usage-bearing
    // row can never be missing it. Never default it to 'usd' on read: a null
    // here alongside usage would be a bug, not a dollar amount.
    costUnit: text("cost_unit"),
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

// ---------------------------------------------------------------------------
// Observability projections (async; Phase 12, spec §8.3, §8.8)
// ---------------------------------------------------------------------------

/**
 * `agent_performance` (V2): per Agent Definition version, Task Definition and
 * model tier. Rebuilt wholesale from Events by `../projections/agentPerformance.ts`;
 * never written by execution. Governance-facing but NOT consumed by Policy or the
 * Model Router before a minimum sample criterion is defined (spec Phase 19 V2).
 *
 * Phase 12 columns, with one amendment: `avg_cost` is a jsonb object keyed by
 * resource unit (exact decimal strings), because a single number would total
 * across units — the same correction migration 0006 made to `budget_counters`.
 * `model_tier` is "none" for Runs that made no model call.
 */
export const agentPerformance = pgTable(
  "agent_performance",
  {
    agentDefinitionId: uuid("agent_definition_id")
      .notNull()
      .references(() => agentDefinitions.id),
    agentDefinitionVersion: integer("agent_definition_version").notNull(),
    taskDefinitionId: uuid("task_definition_id")
      .notNull()
      .references(() => taskDefinitions.id),
    modelTier: text("model_tier").notNull(),
    successRate: numeric("success_rate").notNull(),
    avgCost: jsonb("avg_cost").$type<Record<string, string>>().notNull(),
    avgRetries: numeric("avg_retries").notNull(),
    sampleCount: integer("sample_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "agent_performance_pk", columns: [table.agentDefinitionId, table.agentDefinitionVersion, table.taskDefinitionId, table.modelTier] }),
  ]
);

export const budgetCounters = pgTable(
  "budget_counters",
  {
    id: uuid("id").primaryKey().$defaultFn(genId),
    scope: budgetCounterScope("scope").notNull(),
    scopeRefId: text("scope_ref_id").notNull(),
    // Added 2026-09-13 (amended Phase 12). One counter per scope key PER UNIT,
    // so dollars and subscription tokens are tracked independently and never
    // summed. Defaulted to 'usd' so the migration backfills pre-existing rows
    // to the only unit that existed before this column.
    resourceUnit: text("resource_unit").notNull().default("usd"),
    limitAmount: numeric("limit_amount").notNull(),
    reservedAmount: numeric("reserved_amount").notNull().default("0"),
    consumedAmount: numeric("consumed_amount").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one counter row per scope key PER RESOURCE UNIT. Without this,
    // two concurrent reserveBudget calls that both find "no row yet" for a
    // key could each attempt to work against/insert a distinct row for the
    // same key, breaking the single-row-per-scope invariant reserveBudget's
    // SELECT ... FOR UPDATE locking depends on for atomicity.
    //
    // `resource_unit` joined the key 2026-09-13 (amended Phase 12). The
    // locking guarantee is unchanged — FOR UPDATE still locks exactly one
    // row — but a scope may now hold a `usd` counter and a
    // `subscription_tokens` counter simultaneously, which must NOT contend
    // with or block each other.
    uniqueIndex("budget_counters_scope_scope_ref_id_resource_unit_idx").on(
      table.scope,
      table.scopeRefId,
      table.resourceUnit
    ),
  ]
);

// ---------------------------------------------------------------------------
// Provider state (projections)
// ---------------------------------------------------------------------------

/**
 * `subscription_quota_state` — the CURRENT projection of what a provider last
 * reported about its own quota windows (Phase 7A; design Part 3).
 *
 * This is NOT a history table and NOT a usage ledger. It holds exactly one row
 * per provider, replaced whenever a newer observation arrives. History lives in
 * the `events` table; this row is a derived read-model, never a source of truth.
 *
 * What it deliberately does NOT store, because none of it is knowable from the
 * telemetry (design Part 3.1 — utilization is a GAUGE, not a counter): tokens
 * remaining, window capacity, cumulative usage, utilization deltas, or any
 * conversion between utilization and `subscription_tokens`. The measured
 * justification is that utilization was observed to DECREASE within a single
 * second (0.47 -> 0.48 -> 0.47), so nothing monotonic may be derived from it.
 *
 * Keyed by `provider` (a natural primary key) rather than the surrogate uuid
 * used elsewhere in this file: "exactly one current-state row per provider" is
 * the entire invariant, and a natural PK makes it structural instead of
 * requiring a separate unique index over a column that nothing references.
 */
export const subscriptionQuotaState = pgTable("subscription_quota_state", {
  provider: text("provider").primaryKey(),
  // Both windows are nullable: a provider may report one window and omit the
  // other, and an omitted field is recorded as absent rather than invented
  // (design Part 3.2). `numeric` rather than a float so the value is stored
  // exactly as observed, with no binary-floating-point drift.
  fiveHourUtilization: numeric("five_hour_utilization"),
  fiveHourResetAt: timestamp("five_hour_reset_at", { withTimezone: true }),
  sevenDayUtilization: numeric("seven_day_utilization"),
  sevenDayResetAt: timestamp("seven_day_reset_at", { withTimezone: true }),
  // When the runtime RECEIVED this reading — a LOCAL RECEIPT timestamp, not a
  // provider-supplied one: the CLI attaches no time to `rate_limit_event`. The
  // adapter stamps each line as it arrives on the pipe (Phase 7B), never at
  // subprocess close, so a reading emitted early in a long invocation is not
  // recorded as fresher than it is.
  //
  // This is the ordering key ("newer replaces older") and the only input a
  // future freshness policy needs. No staleness threshold is stored here — that
  // is policy, and Phase 7A deliberately does not invent one.
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  // Nullable: observed as "rejected" in every Phase 4/5 sample, but the
  // provider is not contractually obliged to send it.
  overageStatus: text("overage_status"),
  // Which mechanism produced the observation (e.g. "rate_limit_event"), so a
  // second future source can be added without the reading becoming ambiguous.
  source: text("source").notNull(),
  // The immutable Event this row was projected FROM. Not one of the nine
  // conceptual fields in the design, and added deliberately: it makes the
  // event -> projection direction structural and auditable (design Part 10), and
  // turns "which fact produced the state I am looking at?" into a lookup rather
  // than a timestamp-correlation guess. The foreign key is the point — a link
  // the database does not enforce would be a weaker version of exactly the
  // guarantee this column exists to provide.
  observationEventId: uuid("observation_event_id")
    .notNull()
    .references(() => events.id),
});

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

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

/**
 * `execution_stops` — the Phase 9.7 emergency stop. CONTROL-PLANE STATE, not an
 * event projection.
 *
 * Enforcement reads this table directly and synchronously, inside the
 * Executor's own transaction, immediately before every Invocation. That is only
 * sound because this database runs at Postgres's default READ COMMITTED
 * (`src/db/client.ts` sets no isolation level, and no route passes transaction
 * config): each statement takes a fresh snapshot, so a stop COMMITTED on another
 * connection mid-run IS visible to the next check inside an already-open
 * Executor transaction. **Do not raise the isolation level without revisiting
 * this** — under REPEATABLE READ an in-flight run would never see a stop.
 *
 * A stop is engaged by INSERTing a row and lifted by setting `lifted_at`,
 * following `capability_grants.revoked_at`'s precedent: lifecycle is a nullable
 * timestamp, never a mutable status column. Rows are therefore an append-only
 * audit of who stopped what, when, and why.
 */
export const executionStops = pgTable(
  "execution_stops",
  {
    id: uuid("id").primaryKey().$defaultFn(genId),
    scope: executionStopScope("scope").notNull(),
    /**
     * What the scope points at: an `agent_definitions.id`, a
     * `capability_grants.id`, a `goals.id`, a `workflow_runs.id`, or a
     * `runs.id`.
     *
     * For `global` this is the sentinel `"*"` rather than NULL — deliberately.
     * Postgres treats NULLs as distinct, so a partial unique index could not
     * prevent two simultaneous active global stops if this were nullable.
     * `GLOBAL_STOP_REF` in `src/governance/executionStop.ts` is the only
     * producer of that value.
     *
     * No foreign key: the scope determines which table it refers to, and a stop
     * must remain valid as an audit record even if its target is later removed.
     */
    scopeRefId: text("scope_ref_id").notNull(),
    /** Free text from the human engaging the stop. Never interpreted by code. */
    reason: text("reason"),
    engagedAt: timestamp("engaged_at", { withTimezone: true }).notNull().defaultNow(),
    engagedBy: text("engaged_by").notNull(),
    /** NULL means ACTIVE. Set to lift; the row is never deleted. */
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: text("lifted_by"),
  },
  (table) => [
    // At most one ACTIVE stop per scope key. Without this, "lift the stop on
    // agent X" would be nondeterministic with several active rows, and the
    // enforcement lookup could not answer "is this scope stopped?" from a
    // single row. Partial, so the full history of lifted stops is retained.
    uniqueIndex("execution_stops_active_scope_idx")
      .on(table.scope, table.scopeRefId)
      .where(sql`${table.liftedAt} is null`),
  ]
);

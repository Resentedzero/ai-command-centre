/**
 * Registry writes (roadmap V1.1; spec §15.1 screen 6, §9.2, §9.4, §18.3).
 *
 * Creates Capabilities, Tool Bindings, Agent / Task / Workflow Definitions and
 * Capability Grants as data, so extending the system needs no SQL. Each function
 * runs inside the caller's transaction, validates fail-closed, inserts one row
 * and emits one event in that same transaction.
 *
 * NOTHING IS EVER UPDATED. Editing a Definition creates a new version: a new row
 * with the same `name` (the logical identity, as `capabilities.name` already is)
 * and `version = latest + 1`. Grants, Runs and graph steps pin `(id, version)`, so
 * old versions keep working exactly as before. A new version has no Grants until
 * one is created for it. Changing a Grant's autonomy is revoking it and creating
 * another, two individually logged human acts (spec §9.4); there is no bulk path.
 *
 * EXPLICIT VERSIONING. A write names the version it supersedes
 * (`previousVersion`). Omitted, the name must be new; given, it must equal the
 * latest version. Anything else is a 409, so two operators cannot silently
 * overwrite each other's edit and a name collision never becomes a version.
 * Allocation is serialized per name by a transaction-scoped advisory lock in a
 * lock class of its own.
 *
 * WRITE-TIME CHECKS mirror the run-time ones rather than duplicating them:
 * - Tool Binding: `adapterFor` (the check resolution applies), trust level 0–2.
 * - Task Definition: a registered plan for `kind`; a supplied context budget must
 *   be complete (`requireContextBudget`). Plan-specific parameters are still
 *   checked when the plan runs.
 * - Workflow Definition: a linear graph whose every step names an existing Task
 *   Definition version with a registered plan and an existing Agent version.
 * - Capability Grant: only for an Agent version not yet in use (bound by no Run,
 *   named by no Workflow Definition), because "a Grant is static, versioned alongside
 *   its Agent Definition — changing authorization is a new Agent Definition version,
 *   never a silent runtime mutation" (spec §9.2). Workflow creates share-lock their
 *   step Agents and Grant creates lock the Agent row, so the two cannot interleave.
 *   Also `validateCapabilityGrant` (the §9.4 autonomy ceiling); no
 *   `scope` (stored but never evaluated, so accepting one would promise a
 *   restriction nothing enforces); no unrevoked Grant on the same Agent version and
 *   Capability sharing a permission, because `resolveCapabilityGrant` would pick
 *   between them arbitrarily.
 */
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  agentDefinitions,
  capabilities,
  capabilityGrants,
  runs,
  taskDefinitions,
  toolBindings,
  workflowDefinitions,
} from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import { validateCapabilityGrant, type CapabilityGrant, type CapabilityPermission } from "../governance/policy.js";
import { TIER_ORDER, type RiskTier } from "../governance/risk.js";
import { adapterFor } from "../capabilities/toolAdapters.js";
import { hasTaskPlan, requireContextBudget } from "../capabilities/taskPlans.js";
import { isLinearGraphDefinition } from "../workflow/graphTypes.js";
import { parseExecutionProfile } from "./executionProfile.js";

/** A refused write. `status` is the HTTP status the route returns. */
export class RegistryWriteError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string
  ) {
    super(message);
  }
}

export type Created = {
  id: string;
  name: string;
  version: number | null;
  eventIdempotencyKey: string;
  /** Further events the same write committed (an Agent version's Grants), in commit order. */
  additionalEventIdempotencyKeys?: string[];
};

type Body = Record<string, unknown>;

// Its own class: executorInstanceLock.ts holds (20260912, 1) for the process's life, so a
// registry key hashing to 1 in that class would wait forever.
const LOCK_CLASS_ID = 20260914;
const PERMISSIONS: readonly CapabilityPermission[] = ["READ", "WRITE", "CREATE", "PUBLISH", "SPEND", "TRADE", "DELETE", "EXECUTE", "SEND"];
const AUTONOMY_STATES: readonly CapabilityGrant["autonomyState"][] = ["ALWAYS_APPROVE", "CONDITIONAL", "AUTONOMOUS"];
export const GRANT_PERMISSIONS = PERMISSIONS;
export const GRANT_AUTONOMY_STATES = AUTONOMY_STATES;
const INT4_MAX = 2_147_483_647;
const MAX_GRAPH_STEPS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(message: string): never {
  throw new RegistryWriteError(400, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The longest free-text field any API write accepts. */
export const MAX_TEXT_LENGTH = 10_000;

function requireText(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) refuse(`"${field}" must be a non-empty string.`);
  // A name is an exact-match identity: " publish.report" would be a different Capability.
  if (value !== value.trim()) refuse(`"${field}" must not start or end with whitespace.`);
  return value;
}

function optionalText(body: Body, field: string): string | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requireText(body, field);
}

function optionalObject(body: Body, field: string): Record<string, unknown> {
  const value = body[field];
  if (value === undefined) return {};
  if (!isPlainObject(value)) refuse(`"${field}" must be an object.`);
  return value;
}

function requireInteger(body: Body, field: string, min: number, maxValue: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > maxValue) {
    refuse(`"${field}" must be an integer from ${min} to ${maxValue}.`);
  }
  return value;
}

function requireUuid(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) refuse(`"${field}" must be a UUID.`);
  return value;
}

/** Serializes writes that allocate under `key` until this transaction ends. */
async function lock(tx: DrizzleTransaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS_ID}::int, hashtext(${`registry:${key}`}))`);
}

/** The version this write creates, given the latest one and the version the caller says it supersedes. */
async function nextVersion(
  tx: DrizzleTransaction,
  table: PgTable,
  versionColumn: PgColumn,
  identityColumn: PgColumn,
  identity: string,
  body: Body,
  what: string
): Promise<number> {
  const previous = body.previousVersion;
  if (previous !== undefined && (typeof previous !== "number" || !Number.isInteger(previous) || previous < 0 || previous > INT4_MAX)) {
    refuse(`"previousVersion" must be an integer from 0 to ${INT4_MAX}.`);
  }
  const [row] = await tx.select({ latest: max(versionColumn) }).from(table).where(eq(identityColumn, identity));
  const latest = (row?.latest as number | null | undefined) ?? null;
  if (latest === null && previous !== undefined) {
    throw new RegistryWriteError(409, `${what} has no version ${previous}; omit "previousVersion" to create version 1.`);
  }
  if (latest !== null && previous !== latest) {
    throw new RegistryWriteError(
      409,
      `${what} is at version ${latest}; a new version must name "previousVersion": ${latest}` +
        (previous === undefined ? "." : ` (got ${previous}).`)
    );
  }
  return latest === null ? 1 : latest + 1;
}

async function emitCreated(
  tx: DrizzleTransaction,
  actor: string,
  eventType: string,
  id: string,
  payload: Record<string, unknown>
): Promise<string> {
  const idempotencyKey = `${eventType}:${id}`;
  await emitEvent(tx, {
    idempotencyKey,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
    actor,
    producer: "registry",
    payload,
    usage: null,
  });
  return idempotencyKey;
}

async function definitionCreated(
  tx: DrizzleTransaction,
  actor: string,
  definitionType: string,
  row: { id: string; name: string; version: number | null },
  details: Record<string, unknown> = {}
): Promise<Created> {
  const eventIdempotencyKey = await emitCreated(tx, actor, "definition_version_created", row.id, {
    definitionType,
    id: row.id,
    name: row.name,
    version: row.version,
    ...details,
  });
  return { id: row.id, name: row.name, version: row.version, eventIdempotencyKey };
}

export async function createCapability(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const name = requireText(body, "name");
  const staticRiskTag = body.staticRiskTag;
  if (typeof staticRiskTag !== "string" || !TIER_ORDER.includes(staticRiskTag as RiskTier)) {
    refuse(`"staticRiskTag" must be one of ${TIER_ORDER.join(", ")}.`);
  }
  const description = optionalText(body, "description");
  const costProfile = optionalObject(body, "costProfile");

  await lock(tx, `capabilities:${name}`);
  if (await tx.query.capabilities.findFirst({ where: eq(capabilities.name, name) })) {
    throw new RegistryWriteError(409, `A capability named "${name}" already exists; capability names are unique.`);
  }
  const [row] = await tx.insert(capabilities).values({ name, description, staticRiskTag, costProfile }).returning();
  return definitionCreated(tx, actor, "capability", { id: row!.id, name, version: null });
}

export async function createToolBinding(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const capabilityId = requireUuid(body, "capabilityId");
  const kind = body.kind;
  if (typeof kind !== "string") refuse(`"kind" must be a string.`);
  if (!isPlainObject(body.config)) refuse(`"config" must be an object.`);
  const config = body.config;
  const trustLevel = requireInteger(body, "trustLevel", 0, 2);

  const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.id, capabilityId) });
  if (!capability) refuse(`No capability found for "capabilityId" ${capabilityId}.`);
  try {
    adapterFor({ kind: kind as typeof toolBindings.$inferInsert.kind, config }, capability.name);
  } catch (error) {
    refuse((error as Error).message);
  }

  await lock(tx, `tool_bindings:${capabilityId}`);
  const version = await nextVersion(tx, toolBindings, toolBindings.version, toolBindings.capabilityId, capabilityId, body, `Capability "${capability.name}"'s Tool Binding`);
  const [row] = await tx
    .insert(toolBindings)
    .values({ capabilityId, kind: kind as typeof toolBindings.$inferInsert.kind, config, trustLevel, version })
    .returning();
  // What governs the binding (which code, how trusted) without its config (CAPABILITY_PLATFORM §6).
  return definitionCreated(tx, actor, "tool_binding", { id: row!.id, name: capability.name, version }, {
    capabilityId,
    kind,
    function: config.function,
    trustLevel,
  });
}

/** The most Grants one Agent Definition write may create alongside the version. */
export const MAX_GRANTS_PER_AGENT_WRITE = 50;

/**
 * Creates an Agent Definition version and, optionally, its Capability Grants in the
 * same transaction (V1.1 Agent Builder), so an agent never exists half-granted. Each
 * Grant goes through `createCapabilityGrant` unchanged (every check, its own
 * `capability_granted` event); any refusal rolls back the version too. A new version
 * inherits no Grants: the caller lists the ones it should have.
 */
export async function createAgentDefinition(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const name = requireText(body, "name");
  const profile = parseExecutionProfile(body.executionProfile);
  if (!profile.ok) refuse(profile.reason);
  const grants = body.grants;
  if (grants !== undefined && (!Array.isArray(grants) || grants.length > MAX_GRANTS_PER_AGENT_WRITE || !grants.every(isPlainObject))) {
    refuse(`"grants" must be a list of at most ${MAX_GRANTS_PER_AGENT_WRITE} grant objects.`);
  }
  const values = {
    name,
    role: requireText(body, "role"),
    objective: requireText(body, "objective"),
    instructions: requireText(body, "instructions"),
    memoryPolicy: optionalObject(body, "memoryPolicy"),
    escalationPolicy: optionalObject(body, "escalationPolicy"),
    executionProfile: profile.profile as Record<string, unknown>,
  };
  await lock(tx, `agent_definitions:${name}`);
  const version = await nextVersion(tx, agentDefinitions, agentDefinitions.version, agentDefinitions.name, name, body, `Agent Definition "${name}"`);
  const [row] = await tx.insert(agentDefinitions).values({ ...values, version }).returning();
  const created = await definitionCreated(tx, actor, "agent_definition", { id: row!.id, name, version });

  const grantEventKeys: string[] = [];
  for (const [index, grant] of ((grants as Body[] | undefined) ?? []).entries()) {
    for (const pinned of ["agentDefinitionId", "agentDefinitionVersion"]) {
      if (grant[pinned] !== undefined) refuse(`grants[${index}]: "${pinned}" is set by the new version and must be omitted.`);
    }
    try {
      const g = await createCapabilityGrant(tx, { ...grant, agentDefinitionId: row!.id, agentDefinitionVersion: version }, actor);
      grantEventKeys.push(g.eventIdempotencyKey);
    } catch (error) {
      if (error instanceof RegistryWriteError) throw new RegistryWriteError(error.status, `grants[${index}]: ${error.message}`);
      throw error;
    }
  }
  return { ...created, additionalEventIdempotencyKeys: grantEventKeys };
}

export async function createTaskDefinition(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const name = requireText(body, "name");
  const kind = requireText(body, "kind");
  if (!hasTaskPlan(kind)) refuse(`No task plan is registered for kind "${kind}".`);
  const defaultContextBudget = optionalObject(body, "defaultContextBudget");
  if (Object.keys(defaultContextBudget).length > 0) {
    try {
      requireContextBudget(defaultContextBudget, name);
    } catch (error) {
      refuse((error as Error).message);
    }
  }
  const values = {
    name,
    kind,
    inputSchema: optionalObject(body, "inputSchema"),
    outputSchema: optionalObject(body, "outputSchema"),
    defaultContextBudget,
  };
  await lock(tx, `task_definitions:${name}`);
  const version = await nextVersion(tx, taskDefinitions, taskDefinitions.version, taskDefinitions.name, name, body, `Task Definition "${name}"`);
  const [row] = await tx.insert(taskDefinitions).values({ ...values, version }).returning();
  return definitionCreated(tx, actor, "task_definition", { id: row!.id, name, version });
}

export async function createWorkflowDefinition(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const name = requireText(body, "name");
  const graphDefinition = body.graphDefinition;
  if (!isLinearGraphDefinition(graphDefinition)) refuse(`"graphDefinition" must be a linear graph with at least one valid step.`);
  if (graphDefinition.steps.length > MAX_GRAPH_STEPS) refuse(`"graphDefinition" may have at most ${MAX_GRAPH_STEPS} steps.`);

  for (const [index, step] of graphDefinition.steps.entries()) {
    const at = `step ${index}`;
    if (!UUID_PATTERN.test(step.taskDefinitionId)) refuse(`${at}: taskDefinitionId must be a UUID.`);
    for (const version of [step.taskDefinitionVersion, step.agentDefinitionVersion ?? 1]) {
      if (!Number.isInteger(version) || version < 1 || version > INT4_MAX) refuse(`${at}: versions must be integers from 1 to ${INT4_MAX}.`);
    }
    if (step.agentDefinitionId === undefined || !UUID_PATTERN.test(step.agentDefinitionId)) {
      refuse(`${at}: every step must bind an Agent Definition (agentDefinitionId and agentDefinitionVersion).`);
    }
    const taskDefinition = await tx.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.id, step.taskDefinitionId), eq(taskDefinitions.version, step.taskDefinitionVersion)),
    });
    if (!taskDefinition) refuse(`${at}: no Task Definition ${step.taskDefinitionId} version ${step.taskDefinitionVersion}.`);
    if (!hasTaskPlan(taskDefinition.kind)) refuse(`${at}: Task Definition kind "${taskDefinition.kind}" has no registered plan.`);
    // FOR SHARE: a Grant cannot be added to this Agent version while this graph starts naming it.
    const [agent] = await tx
      .select({ id: agentDefinitions.id })
      .from(agentDefinitions)
      .where(and(eq(agentDefinitions.id, step.agentDefinitionId), eq(agentDefinitions.version, step.agentDefinitionVersion!)))
      .for("share");
    if (!agent) refuse(`${at}: no Agent Definition ${step.agentDefinitionId} version ${step.agentDefinitionVersion}.`);
  }

  await lock(tx, `workflow_definitions:${name}`);
  const version = await nextVersion(tx, workflowDefinitions, workflowDefinitions.version, workflowDefinitions.name, name, body, `Workflow Definition "${name}"`);
  const [row] = await tx.insert(workflowDefinitions).values({ name, version, graphDefinition }).returning();
  return definitionCreated(tx, actor, "workflow_definition", { id: row!.id, name, version });
}

export async function createCapabilityGrant(tx: DrizzleTransaction, body: Body, actor: string): Promise<Created> {
  const agentDefinitionId = requireUuid(body, "agentDefinitionId");
  const agentDefinitionVersion = requireInteger(body, "agentDefinitionVersion", 1, INT4_MAX);
  const capabilityId = requireUuid(body, "capabilityId");
  const maxTrustLevelRequired = requireInteger(body, "maxTrustLevelRequired", 0, 2);

  const permissions = body.permissions;
  if (
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    !permissions.every((p) => PERMISSIONS.includes(p as CapabilityPermission)) ||
    new Set(permissions).size !== permissions.length
  ) {
    refuse(`"permissions" must be a non-empty list of distinct permissions from ${PERMISSIONS.join(", ")}.`);
  }
  // Spec §9.4: a new Grant defaults to ALWAYS_APPROVE; any other state is named explicitly.
  const autonomyState = body.autonomyState ?? "ALWAYS_APPROVE";
  if (!AUTONOMY_STATES.includes(autonomyState as CapabilityGrant["autonomyState"])) {
    refuse(`"autonomyState" must be one of ${AUTONOMY_STATES.join(", ")}.`);
  }
  if (body.scope !== undefined && !(isPlainObject(body.scope) && Object.keys(body.scope).length === 0)) {
    refuse(`"scope" is not supported: Grant scope is stored but never evaluated, so a scoped Grant would not be restricted.`);
  }

  const grant: CapabilityGrant = {
    agentDefinitionId,
    agentDefinitionVersion,
    capabilityId,
    permissions: permissions as CapabilityPermission[],
    maxTrustLevelRequired,
    autonomyState: autonomyState as CapabilityGrant["autonomyState"],
  };
  const validation = validateCapabilityGrant(grant);
  if (!validation.valid) refuse(validation.reason);

  // FOR NO KEY UPDATE conflicts with a Workflow create's FOR SHARE, not with the key-share locks Runs' foreign keys take.
  const [agent] = await tx
    .select()
    .from(agentDefinitions)
    .where(and(eq(agentDefinitions.id, agentDefinitionId), eq(agentDefinitions.version, agentDefinitionVersion)))
    .for("no key update");
  if (!agent) refuse(`No Agent Definition ${agentDefinitionId} version ${agentDefinitionVersion}.`);
  const [boundRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentDefinitionId, agentDefinitionId), eq(runs.agentDefinitionVersion, agentDefinitionVersion)))
    .limit(1);
  const [namingWorkflow] = await tx
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(sql`${workflowDefinitions.graphDefinition}->'steps' @> ${JSON.stringify([{ agentDefinitionId, agentDefinitionVersion }])}::jsonb`)
    .limit(1);
  if (boundRun || namingWorkflow) {
    const use = boundRun ? "bound by a Run" : `named by Workflow Definition ${namingWorkflow!.id}`;
    throw new RegistryWriteError(
      409,
      `Agent Definition "${agent.name}" version ${agentDefinitionVersion} is already in use (${use}). ` +
        "Changing authorization is a new Agent Definition version (spec §9.2); revocation remains available."
    );
  }
  const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.id, capabilityId) });
  if (!capability) refuse(`No capability found for "capabilityId" ${capabilityId}.`);

  await lock(tx, `capability_grants:${agentDefinitionId}:${agentDefinitionVersion}:${capabilityId}`);
  const live = await tx.query.capabilityGrants.findMany({
    where: and(
      eq(capabilityGrants.agentDefinitionId, agentDefinitionId),
      eq(capabilityGrants.agentDefinitionVersion, agentDefinitionVersion),
      eq(capabilityGrants.capabilityId, capabilityId),
      isNull(capabilityGrants.revokedAt)
    ),
  });
  const overlapping = live.find((g) => Array.isArray(g.permissions) && g.permissions.some((p) => grant.permissions.includes(p as CapabilityPermission)));
  if (overlapping) {
    throw new RegistryWriteError(
      409,
      `Unrevoked Grant ${overlapping.id} already covers ${overlapping.permissions.join(", ")} for this Agent version and capability; revoke it first.`
    );
  }

  const [row] = await tx
    .insert(capabilityGrants)
    .values({ ...grant, scope: {} })
    .returning();
  const eventIdempotencyKey = await emitCreated(tx, actor, "capability_granted", row!.id, {
    grantId: row!.id,
    agentDefinitionId,
    agentDefinitionVersion,
    capabilityId,
    permissions: grant.permissions,
    autonomyState: grant.autonomyState,
    maxTrustLevelRequired,
  });
  return { id: row!.id, name: `${agent.name}@${agentDefinitionVersion} -> ${capability.name}`, version: null, eventIdempotencyKey };
}

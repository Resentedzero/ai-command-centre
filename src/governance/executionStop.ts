/**
 * Emergency stop — frozen spec Phase 9.7.
 *
 * "An immediate, synchronous state flip (a Postgres row update, not a queued
 * event)", checked by the Executor before EVERY Invocation, including free and
 * deterministic ones.
 *
 * WHY THIS IS SOUND
 * -----------------
 * The Executor advances a Run in short transactions (Phase 9), each of which
 * may propose and execute several Invocations, so a stop must be visible to a
 * `SELECT` issued inside a transaction that was already open when the stop
 * committed on another connection. It is: this database
 * runs at Postgres's default READ COMMITTED (`src/db/client.ts` sets no
 * isolation level and no route passes transaction config), where every
 * statement takes a fresh snapshot.
 *
 * **If anyone raises the isolation level, this control silently stops working**
 * — an in-flight Run would keep its original snapshot and never observe the
 * stop. `tests/governance/executionStop.test.ts` pins the behaviour with two
 * concurrent connections so that regression fails loudly.
 *
 * THE STATE FLIP MUST COMMIT ON ITS OWN
 * -------------------------------------
 * `engageStop` and `liftStop` perform ONLY the row write. The audit event is
 * emitted separately, by `recordStopEvent`, in a transaction of its own.
 *
 * That split is load-bearing, not tidiness. `emitEvent` takes
 * `pg_advisory_xact_lock(hashtext(runId))` for the event's `correlation.runId`
 * (`src/events/emit.ts`), and a Run's open transaction already holds exactly
 * that lock until it commits — it wrote `invocation_started` for itself. An engage transaction that
 * inserted the stop AND emitted an event tagged with the target Run would wait
 * on that lock, so the stop could not commit until the very Run it was meant to
 * halt had finished. So:
 *
 *   1. the stop row is committed in a transaction that takes no event lock, and
 *      is visible to the Run's next check immediately; and
 *   2. stop events carry NO run correlation (the target lives in the payload),
 *      so even the follow-up event transaction never contends with a Run.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not an event projection, and not derived from one: enforcement reads this
 * table, never the event log. A missing event never means a missing stop.
 *
 * It also does not widen anything. `assertNotStopped` either returns or throws;
 * there is no branch that authorizes work, so a stop can only ever subtract
 * from what Policy, Approval and Budget already permitted.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { capabilityGrants, events, executionStops, runs } from "../db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../events/emit.js";

/** Scopes at which execution can be halted. Mirrors the `execution_stop_scope` enum. */
export type ExecutionStopScope =
  | "global"
  | "agent_definition"
  | "capability_grant"
  | "goal"
  | "workflow_run"
  | "run";

/**
 * `scope_ref_id` for the global scope.
 *
 * A sentinel rather than NULL so the partial unique index actually constrains
 * it — Postgres treats NULLs as distinct, so a nullable column would permit two
 * simultaneous active global stops.
 */
export const GLOBAL_STOP_REF = "*";

export const EXECUTION_STOP_ENGAGED = "execution_stop_engaged";
export const EXECUTION_STOP_LIFTED = "execution_stop_lifted";
export const EXECUTION_STOP_EVENT_VERSION = 1;

/**
 * The actor recorded for control-plane stop actions.
 *
 * Hardcoded server-side, exactly like `V1_RESOLUTION_ACTOR` in
 * `./approvals.ts`, and for the same reason: there is no authentication
 * middleware in this system, so a caller-supplied identity would write an
 * attacker-chosen string into an immutable audit record. Engaging a stop is a
 * human governance action; its actor is never read from a request body.
 */
export const V1_STOP_ACTOR = "human:operator";

/** Every non-global target (`agent_definitions`, `capability_grants`, `goals`, `workflow_runs`, `runs`) is a uuid primary key. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scope/target pair that a stop may match. */
export type StopScopeKey = { scope: ExecutionStopScope; scopeRefId: string };

export type ActiveStop = {
  id: string;
  scope: ExecutionStopScope;
  scopeRefId: string;
  reason: string | null;
};

/**
 * Thrown when execution is halted. Carries the matching stop so the Executor can
 * record WHICH stop blocked the work, not merely that something did.
 *
 * `lookupFailed` distinguishes "an operator stop is active" from "the stop
 * lookup itself errored". Both refuse. They differ in what the caller may do
 * next: a lookup failure has usually aborted the Postgres transaction, so no
 * cleanup write can succeed, and recording it as an operator stop would invent
 * an audit entry that never existed.
 */
export class ExecutionStoppedError extends Error {
  constructor(
    readonly stop: ActiveStop,
    readonly lookupFailed = false
  ) {
    super(
      lookupFailed
        ? `Execution halted: ${stop.reason}`
        : `Execution halted by an active ${stop.scope} stop (${stop.scopeRefId})` +
            (stop.reason ? `: ${stop.reason}` : ".")
    );
    this.name = "ExecutionStoppedError";
  }
}

/**
 * Normalizes and validates a stop target.
 *
 * `global` always resolves to the sentinel. Every other scope names a uuid
 * primary key, so anything that is not a uuid — including the global sentinel
 * itself — is rejected. Otherwise a typo would create a stop that matches
 * nothing while returning success, and an operator would believe something was
 * stopped when nothing was.
 */
export function normalizeStopTarget(scope: ExecutionStopScope, scopeRefId?: string | null): string {
  if (scope === "global") return GLOBAL_STOP_REF;

  const ref = (scopeRefId ?? "").trim();
  if (ref === "") {
    throw new Error(`scope "${scope}" requires a scopeRefId naming what to stop.`);
  }
  if (!UUID_PATTERN.test(ref)) {
    throw new Error(`scope "${scope}" requires a uuid scopeRefId; received "${ref}".`);
  }
  return ref.toLowerCase();
}

/**
 * The scope keys applicable to one Invocation.
 *
 * `global` is ALWAYS included — it is the only scope that covers every
 * invocation kind. The others apply only when their identifier exists:
 *
 *   - `agent_definition` — `runs.agent_definition_id` is nullable, and
 *     workflow-created runs start unbound. An unbound run cannot be stopped by
 *     agent scope; that is a property of the data model, not a gap here.
 *   - `capability_grant` — only Tool Invocations resolve a Grant at all, so
 *     only they can be stopped at that scope.
 *   - `goal` / `workflow_run` — null for standalone Task Instances, which belong
 *     to no Workflow Run. Spec 9.7 names "per-Goal/Workflow-Run"; both are
 *     provided, because one Goal may own several Workflow Runs and an operator
 *     may need to halt all of them at once.
 *
 * Undefined/null identifiers are dropped rather than matched against a
 * placeholder: a stop must never match an invocation merely because both lack
 * an identifier.
 */
export function stopScopeKeys(input: {
  agentDefinitionId?: string | null;
  capabilityGrantId?: string | null;
  goalId?: string | null;
  workflowRunId?: string | null;
  runId?: string | null;
}): StopScopeKey[] {
  const keys: StopScopeKey[] = [{ scope: "global", scopeRefId: GLOBAL_STOP_REF }];

  if (input.agentDefinitionId) keys.push({ scope: "agent_definition", scopeRefId: input.agentDefinitionId.toLowerCase() });
  if (input.capabilityGrantId) keys.push({ scope: "capability_grant", scopeRefId: input.capabilityGrantId.toLowerCase() });
  if (input.goalId) keys.push({ scope: "goal", scopeRefId: input.goalId.toLowerCase() });
  if (input.workflowRunId) keys.push({ scope: "workflow_run", scopeRefId: input.workflowRunId.toLowerCase() });
  if (input.runId) keys.push({ scope: "run", scopeRefId: input.runId.toLowerCase() });

  return keys;
}

/**
 * Returns every ACTIVE stop matching any of the supplied scope keys.
 *
 * One query for all scopes. Every active stop is returned rather than the first
 * match, so an operator sees all of them — multiple simultaneous stops are
 * expected and all are respected.
 */
export async function findActiveStops(
  tx: DrizzleTransaction,
  keys: StopScopeKey[]
): Promise<ActiveStop[]> {
  if (keys.length === 0) return [];

  const rows = await tx
    .select({
      id: executionStops.id,
      scope: executionStops.scope,
      scopeRefId: executionStops.scopeRefId,
      reason: executionStops.reason,
    })
    .from(executionStops)
    .where(
      and(
        isNull(executionStops.liftedAt),
        inArray(
          executionStops.scopeRefId,
          keys.map((k) => k.scopeRefId)
        )
      )
    );

  // The IN filter above is on scope_ref_id alone (one round trip); pair it back
  // to the exact scope here so a run id can never be matched by, say, an
  // agent-scoped stop that happened to share an identifier.
  const allowed = new Set(keys.map((k) => `${k.scope}:${k.scopeRefId}`));
  return rows.filter((r) => allowed.has(`${r.scope}:${r.scopeRefId}`));
}

/**
 * THE ENFORCEMENT POINT. Throws `ExecutionStoppedError` if any applicable stop
 * is active.
 *
 * FAILS CLOSED. If the lookup itself errors — connection lost, table missing,
 * anything — this throws rather than returning, with `lookupFailed: true`. A
 * containment control that degrades to "allow" when its own storage is
 * unreachable is not a containment control.
 */
export async function assertNotStopped(
  tx: DrizzleTransaction,
  input: Parameters<typeof stopScopeKeys>[0]
): Promise<void> {
  let active: ActiveStop[];
  try {
    active = await findActiveStops(tx, stopScopeKeys(input));
  } catch (error) {
    throw new ExecutionStoppedError(
      {
        id: "unknown",
        scope: "global",
        scopeRefId: GLOBAL_STOP_REF,
        reason:
          "the execution-stop lookup itself failed, so containment state is UNKNOWN;" +
          ` refusing to dispatch (fail closed). Cause: ${error instanceof Error ? error.message : String(error)}`,
      },
      true
    );
  }

  if (active.length > 0) {
    throw new ExecutionStoppedError(active[0]!);
  }
}

/**
 * The capability_grant-scope check for a Tool Invocation, covering EVERY
 * unrevoked Grant that authorizes the action — not merely the one
 * `resolveCapabilityGrant` happened to pick.
 *
 * Several Grants can cover the same (agent definition, version, capability,
 * permission): `capability_grants` has no unique index on that key and the
 * resolver takes the first match in unspecified order. A stop on ANY covering
 * Grant must therefore block, or an operator could not reliably halt a
 * capability without stopping every Grant that happens to cover it.
 *
 * Re-reads the Run's CURRENT agent binding, exactly as `resolveCapabilityGrant`
 * does, and is called on BOTH tool paths — fresh dispatch and resume after
 * approval. Without the resume call, a Grant-scoped stop engaged while an
 * invocation waited for approval would be bypassed the moment someone approved.
 *
 * FAILS CLOSED: a failing lookup throws `ExecutionStoppedError` with
 * `lookupFailed`, like `assertNotStopped`.
 */
export async function assertCapabilityGrantsNotStopped(
  tx: DrizzleTransaction,
  input: { runId: string; capabilityId: string; permission: string }
): Promise<void> {
  let active: ActiveStop[];
  try {
    const run = await tx.query.runs.findFirst({ where: eq(runs.id, input.runId) });
    if (!run?.agentDefinitionId || run.agentDefinitionVersion === null) {
      // Unbound: no Grant can cover it, and Policy/reauthorize refuse it.
      return;
    }

    const covering = await tx
      .select({ id: capabilityGrants.id, permissions: capabilityGrants.permissions })
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.agentDefinitionId, run.agentDefinitionId),
          eq(capabilityGrants.agentDefinitionVersion, run.agentDefinitionVersion),
          eq(capabilityGrants.capabilityId, input.capabilityId),
          isNull(capabilityGrants.revokedAt)
        )
      );

    const keys = covering
      .filter((g) => Array.isArray(g.permissions) && g.permissions.includes(input.permission))
      .map((g) => ({ scope: "capability_grant" as const, scopeRefId: g.id.toLowerCase() }));

    active = await findActiveStops(tx, keys);
  } catch (error) {
    throw new ExecutionStoppedError(
      {
        id: "unknown",
        scope: "global",
        scopeRefId: GLOBAL_STOP_REF,
        reason:
          "the capability_grant stop lookup itself failed, so containment state is UNKNOWN;" +
          ` refusing to dispatch (fail closed). Cause: ${error instanceof Error ? error.message : String(error)}`,
      },
      true
    );
  }

  if (active.length > 0) {
    throw new ExecutionStoppedError(active[0]!);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Engages a stop — the STATE FLIP ONLY. Emit the audit event separately with
 * `recordStopEvent`, in its own transaction (see this module's header for why).
 *
 * Idempotent per scope key, including under CONCURRENT engages: the insert runs
 * inside a savepoint, so if a simultaneous engage wins the partial unique index,
 * the violation rolls back only the savepoint and the already-active stop is
 * returned. Without the savepoint, a unique violation would abort the whole
 * transaction and surface to the operator as a server error even though the
 * stop they asked for was, in fact, active.
 */
export async function engageStop(
  tx: DrizzleTransaction,
  input: { scope: ExecutionStopScope; scopeRefId?: string | null; reason?: string | null }
): Promise<ActiveStop> {
  const scopeRefId = normalizeStopTarget(input.scope, input.scopeRefId);

  const existing = await findActiveStops(tx, [{ scope: input.scope, scopeRefId }]);
  if (existing.length > 0) return existing[0]!;

  try {
    const [row] = await tx.transaction((sp) =>
      sp
        .insert(executionStops)
        .values({ scope: input.scope, scopeRefId, reason: input.reason ?? null, engagedBy: V1_STOP_ACTOR })
        .returning()
    );
    return { id: row!.id, scope: input.scope, scopeRefId, reason: row!.reason };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findActiveStops(tx, [{ scope: input.scope, scopeRefId }]);
    if (winner.length === 0) throw error;
    return winner[0]!;
  }
}

/**
 * Lifts a stop — the STATE FLIP ONLY. Returns the lifted row, or null when
 * nothing was active.
 *
 * The conditional UPDATE carries the concurrency guarantee, matching
 * `resolveApproval`'s shape in `./approvals.ts`, so two simultaneous lifts
 * cannot both claim to have lifted the same stop.
 *
 * Lifting is forward-only: it never retroactively authorizes work that was
 * already refused, because refusal already failed those invocations.
 */
export async function liftStop(
  tx: DrizzleTransaction,
  input: { scope: ExecutionStopScope; scopeRefId?: string | null }
): Promise<ActiveStop | null> {
  const scopeRefId = normalizeStopTarget(input.scope, input.scopeRefId);

  const [row] = await tx
    .update(executionStops)
    .set({ liftedAt: new Date(), liftedBy: V1_STOP_ACTOR })
    .where(
      and(
        eq(executionStops.scope, input.scope),
        eq(executionStops.scopeRefId, scopeRefId),
        isNull(executionStops.liftedAt)
      )
    )
    .returning();

  return row ? { id: row.id, scope: input.scope, scopeRefId, reason: row.reason } : null;
}

/**
 * Records a stop's engage or lift as an immutable audit event.
 *
 * Call AFTER the state flip has committed, in a separate transaction.
 * Idempotent: keyed on the stop row's id, so re-recording is a no-op.
 *
 * Correlation is deliberately all-null. The target is carried in the payload
 * instead: tagging the event with a `runId` would make it wait on that Run's
 * advisory lock (see this module's header), which is exactly the contention the
 * split exists to avoid.
 */
export async function recordStopEvent(
  tx: DrizzleTransaction,
  stop: ActiveStop,
  kind: "engaged" | "lifted"
): Promise<void> {
  const eventType = kind === "engaged" ? EXECUTION_STOP_ENGAGED : EXECUTION_STOP_LIFTED;

  await emitEvent(tx, {
    idempotencyKey: `${eventType}:${stop.id}`,
    eventType,
    eventVersion: EXECUTION_STOP_EVENT_VERSION,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
    actor: V1_STOP_ACTOR,
    producer: "governance",
    payload: {
      stopId: stop.id,
      scope: stop.scope,
      scopeRefId: stop.scopeRefId,
      ...(kind === "engaged" ? { reason: stop.reason } : {}),
    },
    usage: null,
  });
}

/**
 * Writes the audit event of every stop whose state flip committed but whose
 * event did not — the process died between the two transactions the routes use
 * (see this module's header). Returns how many events were written.
 *
 * Idempotent, like `recordStopEvent`. Run at startup, before requests: a lift is
 * the case that could not heal itself, because retrying it answers 404.
 */
export async function backfillStopEvents(tx: DrizzleTransaction): Promise<number> {
  const rows = await tx.select().from(executionStops);
  let written = 0;
  for (const row of rows) {
    const stop: ActiveStop = { id: row.id, scope: row.scope, scopeRefId: row.scopeRefId, reason: row.reason };
    const kinds: ("engaged" | "lifted")[] = row.liftedAt ? ["engaged", "lifted"] : ["engaged"];
    for (const kind of kinds) {
      const eventType = kind === "engaged" ? EXECUTION_STOP_ENGAGED : EXECUTION_STOP_LIFTED;
      const existing = await tx.query.events.findFirst({ where: eq(events.idempotencyKey, `${eventType}:${row.id}`) });
      if (existing) continue;
      await recordStopEvent(tx, stop, kind);
      written++;
    }
  }
  return written;
}

/** Lists active stops, for the control-plane read surface. */
export async function listActiveStops(tx: DrizzleTransaction): Promise<ActiveStop[]> {
  return tx
    .select({
      id: executionStops.id,
      scope: executionStops.scope,
      scopeRefId: executionStops.scopeRefId,
      reason: executionStops.reason,
    })
    .from(executionStops)
    .where(isNull(executionStops.liftedAt));
}

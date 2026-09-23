/**
 * The Manager (R2 management layer): contracts, limits, the plan schema and the deterministic checks
 * every Manager decision passes before it becomes work.
 *
 * THE MANAGER IS AN ORDINARY AGENT. It holds two Capabilities, granted like any other:
 * - `manager.inspect_workforce` (READ): a compact roster of the existing agents, built by code.
 * - `manager.delegate` (CREATE): turn a VALIDATED plan into a Workflow Run on the mission's Goal.
 * Nothing here can create an agent, grant or revoke a Capability, touch a budget, a Policy, an
 * approval, a stop, progression or provenance: this module imports none of those writers
 * (enforced by `tests/execution/structuralInvariants.test.ts`). The delegated steps are ordinary
 * `agent_objective` steps, so the Registry re-checks that each agent holds a Grant for every tool it
 * is given, and every call they make is governed as usual.
 *
 * THE MODEL PROPOSES, CODE DECIDES. The Manager's planning and review calls return strict JSON. What
 * becomes work is only what `validateTasks` accepts against the database as it is now: known agents
 * (never the Manager itself), not stopped, not busy, thinking actions from the fixed list, tools the
 * agent holds and a loop can use, earlier-step dependencies only, bounded text, bounded counts.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { agentDefinitions, artifacts, capabilities, capabilityGrants, executionStops, goals, invocations, runs, taskDefinitions, taskInstances, workflowDefinitions, workflowRuns } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { emitLifecycleEvent, NO_CORRELATION, type Correlation } from "../../events/lifecycle.js";
import { isLinearGraphDefinition, type LinearGraphDefinition, type LinearGraphStep } from "../../workflow/graphTypes.js";
import { loopActionFor } from "../shared/loopActions.js";
import { KEEP_STATS_CAPABILITY, asksForKeepStats } from "../keepStats/capability.js";

export { MANAGER_DELEGATE_CAPABILITY, MANAGER_DELEGATE_PERMISSION, MANAGER_INSPECT_WORKFORCE_CAPABILITY, MISSION_LIMITS } from "./capability.js";
import { MISSION_LIMITS } from "./capability.js";

export const MANAGER_REVIEW_STEP_ID = "manager_review";
/** Step ids a delegated task may never take: the plan step and the review step. */
export const RESERVED_STEP_IDS = ["plan", MANAGER_REVIEW_STEP_ID] as const;

export { MISSION_REASONS, RECOVERABLE_REASONS, type Blocker, type MissionReason } from "./capability.js";
import type { Blocker, MissionReason } from "./capability.js";
import { MEETING_REQUEST_SCHEMA } from "./meeting.js";
import { availabilityInputs, inMeetingNow } from "../../workplace/workplace.js";
import { availableAt, nextAvailableFrom } from "../../workplace/availability.js";
import { formatWall } from "../../workplace/zonedTime.js";



export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" },
          agentName: { type: "string" },
          brief: { type: "string" },
          expectedOutput: { type: "string" },
          completionCriteria: { type: "string" },
          intents: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["stepId", "agentName", "brief", "expectedOutput", "completionCriteria", "intents", "tools", "dependsOn"],
        additionalProperties: false,
      },
    },
    escalation: {
      type: "object",
      properties: { needed: { type: "boolean" }, reason: { type: "string" } },
      required: ["needed", "reason"],
      additionalProperties: false,
    },
    meeting: MEETING_REQUEST_SCHEMA,
  },
  required: ["summary", "assumptions", "tasks", "escalation", "meeting"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

export type PlannedTask = {
  stepId: string;
  agentName: string;
  brief: string;
  expectedOutput: string;
  completionCriteria: string;
  intents: string[];
  tools: string[];
  dependsOn: string[];
};

export type ValidatedTask = PlannedTask & { agentDefinitionId: string; agentDefinitionVersion: number };

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

export async function readArtifactJson(tx: DrizzleTransaction, artifactId: string): Promise<Record<string, unknown> | null> {
  const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
  try {
    const v: unknown = JSON.parse(row?.inlineContent ?? "null");
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The run, task instance, workflow run and goal around a task instance, for correlation and limits. */
export async function missionScope(tx: DrizzleTransaction, taskInstanceId: string, runId: string) {
  const ti = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) });
  const wr = ti?.workflowRunId ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, ti.workflowRunId) }) : undefined;
  const goal = wr ? await tx.query.goals.findFirst({ where: eq(goals.id, wr.goalId) }) : undefined;
  if (!ti || !wr || !goal) throw new Error("manager: the mission's Goal was not found (fail closed).");
  const correlation: Correlation = { ...NO_CORRELATION, goalId: goal.id, workflowRunId: wr.id, taskInstanceId: ti.id, runId };
  return { goal, workflowRun: wr, correlation };
}

type Agent = { id: string; name: string; version: number; role: string; objective: string; executionProfile: unknown };

/** The latest version of every persistent agent, by name. */
export async function latestAgents(tx: DrizzleTransaction): Promise<Agent[]> {
  const rows = await tx.select().from(agentDefinitions).orderBy(asc(agentDefinitions.name), asc(agentDefinitions.version));
  const latest = new Map<string, Agent>();
  for (const r of rows) latest.set(r.name, r);
  return [...latest.values()];
}

/** Unrevoked grants of one agent version, as capability name → permissions. */
export async function grantsOf(tx: DrizzleTransaction, agent: { id: string; version: number }): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ name: capabilities.name, permissions: capabilityGrants.permissions })
    .from(capabilityGrants)
    .innerJoin(capabilities, eq(capabilities.id, capabilityGrants.capabilityId))
    .where(and(eq(capabilityGrants.agentDefinitionId, agent.id), eq(capabilityGrants.agentDefinitionVersion, agent.version), isNull(capabilityGrants.revokedAt)));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.name, [...new Set([...(out.get(r.name) ?? []), ...r.permissions])]);
  return out;
}

/** Why an agent cannot take work now, from its records: a stop, unfinished runs of any version, or a step of an unfinished Workflow Run still waiting to start. Null when available. */
export async function unavailability(tx: DrizzleTransaction, name: string): Promise<string | null> {
  const why = await unavailabilityCode(tx, name);
  return why?.detail ?? null;
}

export async function unavailabilityCode(
  tx: DrizzleTransaction,
  name: string,
  opts: { ignoreMeetingId?: string; ignoreSchedule?: boolean } = {}
): Promise<Blocker | null> {
  const versions = await tx.select({ id: agentDefinitions.id }).from(agentDefinitions).where(eq(agentDefinitions.name, name));
  const ids = versions.map((v) => v.id);
  if (ids.length === 0) return { code: "validation_rejected", detail: "does not exist" };
  const stops = await tx
    .select({ scope: executionStops.scope, ref: executionStops.scopeRefId })
    .from(executionStops)
    .where(isNull(executionStops.liftedAt));
  if (stops.some((s) => s.scope === "global" || (s.scope === "agent_definition" && ids.map((id) => id.toLowerCase()).includes((s.ref ?? "").toLowerCase())))) return { code: "emergency_stopped", detail: "is stopped" };
  const meeting = await inMeetingNow(tx, name, new Date(), opts.ignoreMeetingId);
  if (meeting) return { code: "worker_unavailable", detail: `is in a meeting ("${meeting.title}") until ${meeting.endsAt}` };
  const busy = await tx.select({ id: runs.id }).from(runs).where(and(inArray(runs.agentDefinitionId, ids), notInArray(runs.status, ["completed", "failed"]))).limit(1);
  if (busy.length > 0) return { code: "worker_unavailable", detail: "is already working" };
  // Work already assigned but not started: a step of an unfinished Workflow Run naming this agent, with no finished run yet.
  const unfinished = await tx
    .select({ variables: workflowRuns.variables, graph: workflowDefinitions.graphDefinition })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId))
    .where(inArray(workflowRuns.status, ["in_progress", "paused"]));
  for (const wr of unfinished) {
    if (!isLinearGraphDefinition(wr.graph)) continue;
    const slots = ((wr.variables ?? {}) as { stepRunIds?: (string | null)[] }).stepRunIds ?? [];
    for (const [i, step] of wr.graph.steps.entries()) {
      if (!step.agentDefinitionId || !ids.includes(step.agentDefinitionId)) continue;
      const slot = slots[i] ?? null;
      const slotRun = slot ? await tx.query.runs.findFirst({ where: eq(runs.id, slot) }) : undefined;
      if (!slotRun || !["completed", "failed"].includes(slotRun.status)) return { code: "worker_unavailable", detail: "already has work assigned that has not finished" };
    }
  }
  // The diary, last: an agent inside a break or an "unavailable" entry, or outside its working hours when
  // the Keep forbids work outside them, may not be given NEW work. This gate only ever refuses a START —
  // it never touches work already running, and it is not a stop (which is checked far above, and wins).
  // `ignoreSchedule` is for convening a meeting the diary already agreed to: re-asking the diary whether
  // an agent may attend a meeting it is booked into would be double jeopardy.
  if (!opts.ignoreSchedule) {
    const now = new Date();
    const { clock, hours, commitments } = await availabilityInputs(tx, [name], { start: now, end: new Date(now.getTime() + 60_000) });
    const free = availableAt({ clock, hours: hours.get(name)!, commitments, agentName: name, at: now });
    if (!free.ok) {
      const next = nextAvailableFrom({ clock, hours: hours.get(name)!, commitments, agentName: name, from: now });
      // The Keep's own wall clock, not an ISO instant: the Manager reasons about "free from Monday 09:00",
      // and one short phrase is all the planning context needs.
      return { code: "worker_unavailable", detail: `is ${free.reason}${next ? `; free from ${formatWall(next, clock.timezone)}` : " for at least the next fortnight"}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The Registry's step id rule (letters, digits, "-", "_"), limited to 32 characters and starting with a letter. */
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null);
const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/**
 * Checks proposed tasks against the database as it is now. Returns the accepted tasks (with the
 * agent version they bind to) or every reason they were refused. Never partially accepts a plan.
 */
export async function validateTasks(
  tx: DrizzleTransaction,
  proposed: unknown,
  opts: { managerName: string; maxTasks: number; reservedStepIds?: string[] }
): Promise<{ ok: true; tasks: ValidatedTask[] } | { ok: false; errors: string[]; blockers: Blocker[] }> {
  const blockers: Blocker[] = [];
  const errors = { push: (detail: string, code: MissionReason = "validation_rejected") => blockers.push({ code, detail }) };
  const refused = () => ({ ok: false as const, errors: blockers.map((b) => b.detail), blockers });
  if (!Array.isArray(proposed) || proposed.length === 0) {
    errors.push("the plan has no tasks.");
    return refused();
  }
  if (proposed.length > opts.maxTasks) {
    errors.push(`the plan has ${proposed.length} tasks; at most ${opts.maxTasks} are allowed.`, "mission_limit_reached");
    return refused();
  }
  // Loaded lazily: the adapter registry loads this module, and these modules load the registry.
  const { THINKING_INTENTS } = await import("../agentObjective/buildInvocationSpecs.js");
  const agents = new Map((await latestAgents(tx)).map((a) => [a.name, a]));
  const reserved = [...RESERVED_STEP_IDS, ...(opts.reservedStepIds ?? [])];
  const seen = new Set<string>(reserved);
  const tasks: ValidatedTask[] = [];
  for (const [i, raw] of proposed.entries()) {
    const at = `task ${i + 1}`;
    const t = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const extra = Object.keys(t).filter((k) => !["stepId", "agentName", "brief", "expectedOutput", "completionCriteria", "intents", "tools", "dependsOn"].includes(k));
    if (extra.length > 0) errors.push(`${at}: unknown field(s) ${extra.join(", ")}.`);
    const stepId = typeof t.stepId === "string" && STEP_ID.test(t.stepId) ? t.stepId : null;
    if (!stepId) errors.push(`${at}: stepId must be 1-32 letters, digits, "-" or "_", starting with a letter.`);
    else if (seen.has(stepId)) errors.push(`${at}: stepId "${stepId}" is used twice or reserved.`);
    const brief = text(t.brief, MISSION_LIMITS.textChars);
    const expectedOutput = text(t.expectedOutput, MISSION_LIMITS.textChars);
    const completionCriteria = text(t.completionCriteria, MISSION_LIMITS.textChars);
    if (!brief || !expectedOutput || !completionCriteria) errors.push(`${at}: brief, expectedOutput and completionCriteria must each be 1-${MISSION_LIMITS.textChars} characters.`);
    const intents = strings(t.intents);
    const tools = strings(t.tools);
    const dependsOn = strings(t.dependsOn);
    if (!intents || !tools || !dependsOn) errors.push(`${at}: intents, tools and dependsOn must be lists of names.`);
    const name = typeof t.agentName === "string" ? t.agentName : "";
    const agent = agents.get(name);
    if (!agent) errors.push(`${at}: no agent named "${name}" exists; the Manager can only delegate to existing agents.`);
    else if (name === opts.managerName) errors.push(`${at}: the Manager cannot delegate work to itself.`);
    else {
      const why = await unavailabilityCode(tx, name);
      if (why) errors.push(`${at}: ${name} ${why.detail}.`, why.code);
    }
    for (const intent of intents ?? []) if (!(THINKING_INTENTS as readonly string[]).includes(intent)) errors.push(`${at}: "${intent}" is not a thinking action (${THINKING_INTENTS.join(", ")}).`);
    if (intents && tools && intents.length === 0 && tools.length === 0) errors.push(`${at}: a task needs at least one thinking action or tool.`);
    if (agent && tools) {
      const held = await grantsOf(tx, agent);
      for (const tool of tools) {
        const action = loopActionFor(tool);
        if (!action) errors.push(`${at}: "${tool}" is not a capability an agent's loop can use.`, "capability_unavailable");
        else if (!(held.get(tool) ?? []).includes(action.permission)) errors.push(`${at}: ${name} holds no Grant for "${tool}" (${action.permission}); the Manager cannot give it one.`, "capability_unavailable");
      }
    }
    for (const dep of dependsOn ?? []) if (!seen.has(dep) || dep === stepId || reserved.includes(dep)) errors.push(`${at}: dependsOn "${dep}" must name an earlier task of this plan.`);
    if (stepId) seen.add(stepId);
    if (agent && stepId && brief && expectedOutput && completionCriteria && intents && tools && dependsOn) {
      tasks.push({ stepId, agentName: name, brief, expectedOutput, completionCriteria, intents: [...new Set(intents)], tools: [...new Set(tools)], dependsOn: [...new Set(dependsOn)], agentDefinitionId: agent.id, agentDefinitionVersion: agent.version });
    }
  }
  return blockers.length > 0 ? refused() : { ok: true, tasks };
}

// ---------------------------------------------------------------------------
// Delegation: the Workflow the validated tasks run as
// ---------------------------------------------------------------------------

/** One `agent_objective` step per task, then the Manager's own review step over every task's deliverable. */
export function missionGraph(
  tasks: ValidatedTask[],
  refs: { objectiveTask: { id: string; version: number }; reviewTask: { id: string; version: number }; manager: { id: string; version: number } }
): LinearGraphDefinition {
  const steps: LinearGraphStep[] = tasks.map((t) => ({
    stepId: t.stepId,
    label: `${t.agentName}: ${t.brief.slice(0, 120)}`,
    taskDefinitionId: refs.objectiveTask.id,
    taskDefinitionVersion: refs.objectiveTask.version,
    agentDefinitionId: t.agentDefinitionId,
    agentDefinitionVersion: t.agentDefinitionVersion,
    parameters: {
      loop: { maxIterations: MISSION_LIMITS.maxWorkerIterations },
      intents: t.intents,
      tools: t.tools.map((capability) => ({ capability, maxCalls: MISSION_LIMITS.maxToolCalls })),
      brief: t.brief,
      completionCriteria: `${t.completionCriteria} Expected output: ${t.expectedOutput}`,
      inputs: t.dependsOn.map((fromStepId) => ({ fromStepId })),
    },
  }));
  steps.push({
    stepId: MANAGER_REVIEW_STEP_ID,
    label: "Manager review",
    taskDefinitionId: refs.reviewTask.id,
    taskDefinitionVersion: refs.reviewTask.version,
    agentDefinitionId: refs.manager.id,
    agentDefinitionVersion: refs.manager.version,
    parameters: {
      inputs: tasks.map((t) => ({ fromStepId: t.stepId })),
      tasks: tasks.map((t) => ({ stepId: t.stepId, agentName: t.agentName, expectedOutput: t.expectedOutput, completionCriteria: t.completionCriteria, tools: t.tools })),
    },
  });
  return { kind: "linear", description: "Work the Manager delegated for one mission, then the Manager's review.", steps };
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Starts the delegated Workflow Run on the mission's Goal. An existing Workflow Definition with exactly
 * this graph is reused; otherwise the Registry creates one (a new version under the same name when the
 * name exists). Returns what was started, for the record.
 */
export async function startDelegatedWork(
  tx: DrizzleTransaction,
  input: { goalId: string; graph: LinearGraphDefinition; agentNames: string[]; actor: string; correlation: Correlation; round: number }
): Promise<{ workflowRunId: string; workflowDefinitionId: string; reused: boolean; eventKeys: string[] }> {
  const { createWorkflowDefinition } = await import("../../definitions/registryWrites.js");
  const { startWorkflowRun } = await import("../../workflow/interpreter.js");
  // One savepoint: a throw anywhere below leaves no Workflow Definition, run or event behind beside a failed step.
  return tx.transaction(async (sp) => startDelegatedWorkIn(sp as unknown as DrizzleTransaction, input, createWorkflowDefinition, startWorkflowRun));
}

async function startDelegatedWorkIn(
  tx: DrizzleTransaction,
  input: { goalId: string; graph: LinearGraphDefinition; agentNames: string[]; actor: string; correlation: Correlation; round: number },
  createWorkflowDefinition: (typeof import("../../definitions/registryWrites.js"))["createWorkflowDefinition"],
  startWorkflowRun: (typeof import("../../workflow/interpreter.js"))["startWorkflowRun"]
): Promise<{ workflowRunId: string; workflowDefinitionId: string; reused: boolean; eventKeys: string[] }> {
  const name = `Mission · ${[...new Set(input.agentNames)].join(" + ")}`.slice(0, 200);
  const sameName = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.name, name));
  const match = sameName.find((w) => isLinearGraphDefinition(w.graphDefinition) && canonical(w.graphDefinition) === canonical(input.graph));
  let workflowDefinitionId = match?.id;
  const eventKeys: string[] = [];
  if (!workflowDefinitionId) {
    const created = await createWorkflowDefinition(
      tx,
      { name, ...(sameName.length > 0 ? { previousVersion: Math.max(...sameName.map((w) => w.version)) } : {}), graphDefinition: input.graph },
      input.actor
    );
    workflowDefinitionId = created.id;
    eventKeys.push(created.eventIdempotencyKey);
  }
  const { workflowRunId } = await startWorkflowRun(tx, workflowDefinitionId, input.goalId);
  const key = `manager_work_delegated:${workflowRunId}`;
  await emitLifecycleEvent(tx, {
    eventType: "manager_work_delegated",
    subjectId: input.goalId,
    idempotencyKey: key,
    correlation: input.correlation,
    producer: "manager",
    actor: input.actor,
    payload: { delegatedWorkflowRunId: workflowRunId, workflowDefinitionId, reusedWorkflowDefinition: Boolean(match), agents: input.agentNames, round: input.round },
  });
  eventKeys.push(key);
  return { workflowRunId, workflowDefinitionId, reused: Boolean(match), eventKeys };
}

export async function countMission(tx: DrizzleTransaction, goalId: string): Promise<{ workflowRuns: number; workerTasks: number }> {
  const wrs = await tx.select({ id: workflowRuns.id, def: workflowRuns.workflowDefinitionId }).from(workflowRuns).where(eq(workflowRuns.goalId, goalId));
  let workerTasks = 0;
  for (const wr of wrs) {
    const def = await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.id, wr.def) });
    if (!def || !isLinearGraphDefinition(def.graphDefinition)) continue;
    // Counted by what each step IS (its Task Definition kind), never by its id.
    for (const step of def.graphDefinition.steps) {
      const task = await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, step.taskDefinitionId) });
      if (task?.kind === "agent_objective") workerTasks++;
    }
  }
  return { workflowRuns: wrs.length, workerTasks };
}

/** The content hash as stored for an inline artifact (sha256 of its JSON text). */
export const contentHash = (inline: string) => createHash("sha256").update(inline).digest("hex");

// ---------------------------------------------------------------------------
// Facts: objectives whose answer must be system records, not prose
// ---------------------------------------------------------------------------

/** Capabilities whose results are system facts: a deliverable from a task using one must quote them. */
export const FACT_TOOLS: readonly string[] = [KEEP_STATS_CAPABILITY.id];

/**
 * A mission whose objective asks for the Keep's statistics can only be answered from `system.keep_stats`.
 * Checked by code on the plan, before any worker runs: a plan that gives no task that tool is refused as
 * `capability_unavailable` (the validator has already refused a tool the assigned agent holds no Grant for).
 */
export function missingFactTool(objective: string, tasks: { tools: string[] }[]): Blocker | null {
  if (!asksForKeepStats(objective) || tasks.some((t) => t.tools.includes(KEEP_STATS_CAPABILITY.id))) return null;
  return {
    code: "capability_unavailable",
    detail: `the objective asks for Command Keep statistics, which only "${KEEP_STATS_CAPABILITY.id}" can obtain, and no task uses it; an agent holding that Grant must be assigned it.`,
  };
}

/**
 * Does a worker's deliverable report system facts it actually obtained? Code checks, never a model:
 *  1. the worker's own completion evidence cites a verified result of the fact tool;
 *  2. that result is a real one: hash intact, produced by a completed tool Invocation of that Capability
 *     in the worker's own Run (a forged or copied artifact fails here);
 *  3. the deliverable's text quotes the result's values (at least three distinct metric values, or all of
 *     them when fewer are distinct), and contains no number of three or more digits the result lacks.
 * Small invented numbers cannot be told apart from quoted ones; that limit is stated in the plan doc.
 */
export async function checkReportedFacts(
  tx: DrizzleTransaction,
  producerRunId: string,
  doc: Record<string, unknown>,
  tool: string
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  const fail = (detail: string) => ({ ok: false as const, detail });
  const evidence = ((doc.completion ?? {}) as { evidence?: { verified?: { artifactId?: string; capability?: string; runId?: string }[] } }).evidence;
  const cited = (evidence?.verified ?? []).filter((v) => v.capability === tool && v.runId === producerRunId);
  if (cited.length === 0) return fail(`the deliverable cites no verified "${tool}" result from its own run`);
  for (const c of cited) {
    const row = c.artifactId ? await tx.query.artifacts.findFirst({ where: eq(artifacts.id, c.artifactId) }) : undefined;
    if (!row?.inlineContent || contentHash(row.inlineContent) !== row.hash || !row.producingInvocationId) continue;
    const [inv] = await tx
      .select({ runId: invocations.runId, kind: invocations.kind, status: invocations.status, capability: capabilities.name })
      .from(invocations)
      .innerJoin(capabilities, eq(capabilities.id, invocations.capabilityId))
      .where(eq(invocations.id, row.producingInvocationId));
    if (!inv || inv.runId !== producerRunId || inv.kind !== "tool" || inv.status !== "completed" || inv.capability !== tool) continue;
    let result: { results?: { value?: unknown }[]; agents?: { runsCompleted?: unknown; subscriptionTokens?: unknown }[]; window?: { from?: unknown; to?: unknown } };
    try {
      result = JSON.parse(row.inlineContent) as typeof result;
    } catch {
      continue;
    }
    const values = new Set((result.results ?? []).map((r) => r.value).filter((v): v is number => typeof v === "number").map(String));
    if (values.size === 0) continue;
    const allowed = new Set([
      ...values,
      ...(result.agents ?? []).flatMap((a) => [String(a.runsCompleted), String(a.subscriptionTokens)]),
      ...`${String(result.window?.from ?? "")} ${String(result.window?.to ?? "")}`.match(/\d+/g) ?? [],
    ]);
    const text = [doc.summary, doc.body, ...(Array.isArray(doc.findings) ? doc.findings : [])].filter((x): x is string => typeof x === "string").join("\n");
    const numbers = new Set(text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);
    const quoted = [...values].filter((v) => numbers.has(v)).length;
    const need = Math.min(3, values.size);
    if (quoted < need) return fail(`the deliverable quotes ${quoted} of the ${need} or more "${tool}" values it must report; prose without the recorded figures is not a report`);
    const unsupported = [...numbers].filter((n) => /^\d{3,}$/.test(n) && !allowed.has(n));
    if (unsupported.length > 0) return fail(`the deliverable states figures "${tool}" did not return: ${unsupported.slice(0, 5).join(", ")} (a derived total or an invented figure)`);
    return { ok: true, detail: `quotes ${quoted} recorded "${tool}" values` };
  }
  return fail(`no cited "${tool}" result is a genuine, intact result of that tool in the worker's run`);
}

/**
 * Where a Manager record came from. Only a record written by code — a deterministic invocation, with its
 * stored hash intact — in a Manager plan or review step may be acted on.
 */
/**
 * The step kinds whose DETERMINISTIC positions write records a Capability may act on. A governed write
 * always names a record written by one of these; anything else — a model's own output, an artifact from
 * another run — is refused. Adding a kind here widens what can authorise a write, so it is a short list
 * kept next to the check itself.
 */
const RECORD_WRITING_KINDS = new Set(["manager_plan", "manager_review", "manager_recover", "meeting_outcome"]);

export async function codeWrittenRecord(tx: DrizzleTransaction, artifactId: unknown): Promise<{ content: Record<string, unknown>; runId: string } | null> {
  if (typeof artifactId !== "string") return null;
  const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
  if (!row?.producingInvocationId || !row.inlineContent || contentHash(row.inlineContent) !== row.hash) return null;
  const inv = await tx.query.invocations.findFirst({ where: eq(invocations.id, row.producingInvocationId) });
  if (!inv || inv.kind !== "deterministic") return null;
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, inv.runId) });
  const ti = run ? await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) }) : undefined;
  const task = ti ? await tx.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, ti.taskDefinitionId) }) : undefined;
  if (!RECORD_WRITING_KINDS.has(task?.kind ?? "")) return null;
  const content = await readArtifactJson(tx, artifactId);
  return content ? { content, runId: inv.runId } : null;
}

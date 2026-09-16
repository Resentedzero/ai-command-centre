/**
 * `agent_objective` (V1.1): an autonomous agent works toward an objective (the Goal)
 * inside ONE Run of ONE Task Instance: the spec's agentic loop (§3d, §11), where an LLM
 * Invocation's output decides the next Invocation within the Run's fixed Task, budget
 * and Agent. It never creates Task Instances or changes workflow topology.
 *
 * THE BOUNDED PLAN. Built once, with its maximum length fixed from the limits (R1):
 *
 *   for k in 1..N (N = maxIterations, at most 12):
 *     decide(k)  llm, intent decide  -> DecisionV1 (think | tool | gate | finish)
 *     act(k)     from decision k: llm thinking action | governed Tool Invocation |
 *                approval gate | a deterministic refusal record | skip on finish
 *     record(k)  deterministic: the compact ledger + `agent_loop_iteration_recorded`
 *   conclude     deterministic: why the loop ended + the terminal R4 event
 *   write        llm: the final deliverable
 *   persist      deterministic: the `deliverable` Artifact, with basis and completion
 *
 * Every position after an explicit finish resolves to skip, as does decide(k) once the
 * active time or the budget headroom for another iteration and the final write is gone.
 * Nothing a model outputs can add positions, raise a limit, or change a Grant or Policy.
 *
 * GOVERNANCE. Each LLM position goes through the Router (tier from the Agent's profile,
 * risk and escalation floors, its provider restriction), the Budget Governor and the
 * Context Compiler; each tool through Grant, Policy, budget, Approval and stops; every
 * position through the stop check. A tool the agent may not use (not in the step's
 * allow-list, over its call limit, no loop action, no Grant) becomes a recorded refusal
 * and the loop continues; a Policy DENY or a failed call fails the Run (fail closed).
 * Autonomous Runs are not retried automatically.
 *
 * CONTEXT. Each call is compiled fresh with only: the agent's instructions, the Goal,
 * a trusted directive (limits, allowed actions, artifact labels), the latest compact
 * ledger and at most a few artifacts the agent asked for by id. Never a transcript.
 * Ledgers, decisions and results are model or tool output, so they are fenced as
 * untrusted data.
 *
 * DETERMINISM. Thunks read only persisted rows, plus the clock and budget counters for
 * decide(k)'s two stopping checks, which only ever move one way; and a skip is sticky
 * once later positions ran (R1). A tool position awaiting approval re-resolves from its
 * immutable decision Artifact, so its resumed spec is identical.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import { approvals, artifacts, capabilities, capabilityGrants, invocations, runs, taskInstances } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { correlationForRun, emitLifecycleEvent } from "../../events/lifecycle.js";
import type { ContextBudget, InvocationIntent } from "../../context/types.js";
import type {
  DeferredInvocationSpec,
  DeterministicInvocationSpec,
  InvocationSpec,
  InvocationSpecContext,
  LlmInvocationSpec,
  PlannedInvocationSpec,
  SkippedPosition,
} from "../../execution/types.js";
import type { LinearGraphDefinition } from "../../workflow/graphTypes.js";
import { MAX_ACTIVE_SECONDS, MAX_LOOP_ITERATIONS } from "../../governance/autonomyLimits.js";
import { budgetHeadroom } from "../../governance/budgetHeadroom.js";
import { parseLoopLimits, TIER_DIFFICULTY, type ExecutionProfile, type LoopLimits } from "../../definitions/executionProfile.js";
import { resolveToolInvocation } from "../toolAdapters.js";
import { findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { parseStepInputs, resolveStepInputArtifacts, validateStepInputs, type StepInput } from "../shared/stepInputs.js";
import { loopActionFor, loopInputFieldNames, parseLoopActionInput } from "../shared/loopActions.js";
import { DELIVERABLE_DIRECTIVE, DELIVERABLE_FORMAT, DELIVERABLE_OUTPUT_SCHEMA, evidenceBasisFor, persistDeliverableArtifact, type Completion } from "../shared/deliverable.js";
import { gateGrantProblem } from "../reviewCheckpoint/buildInvocationSpecs.js";
import { REVIEW_CHECKPOINT_CAPABILITY, REVIEW_CHECKPOINT_PERMISSION } from "../reviewCheckpoint/capability.js";

export const THINKING_INTENTS = ["plan", "brainstorm", "analyse", "compare", "critique", "write"] as const;
export type ThinkingIntent = (typeof THINKING_INTENTS)[number];

export const LOOP_ITERATION_EVENT = "agent_loop_iteration_recorded";
const MAX_TOOLS = 10;
const MAX_TEXT = 2_000;
const MAX_REQUESTED_ARTIFACTS = 4;
const MAX_LEDGER_ARTIFACTS = 30;
const NOTE_CHARS = 280;
const SUMMARY_CHARS = 400;
const REASON_CHARS = 300;
const NAME_CHARS = 80;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export type ObjectiveParameters = {
  loop: LoopLimits;
  intents: ThinkingIntent[];
  tools: { capability: string; maxCalls: number }[];
  completionCriteria: string | null;
  escalateWhen: string | null;
  inputs: StepInput[];
};

const ALLOWED_KEYS = ["loop", "intents", "tools", "completionCriteria", "escalateWhen", "inputs"];

export function parseObjectiveParameters(p: Record<string, unknown>): { ok: true; params: ObjectiveParameters } | { ok: false; reason: string } {
  const extra = Object.keys(p).filter((k) => !ALLOWED_KEYS.includes(k));
  if (extra.length > 0) return { ok: false, reason: `unknown parameter(s): ${extra.join(", ")}.` };
  const loop = parseLoopLimits(p.loop, `"loop"`);
  if (!loop.ok) return loop;
  const intents = p.intents ?? [];
  if (!Array.isArray(intents) || !intents.every((i) => THINKING_INTENTS.includes(i as ThinkingIntent)) || new Set(intents).size !== intents.length) {
    return { ok: false, reason: `"intents" must be distinct thinking actions from ${THINKING_INTENTS.join(", ")}.` };
  }
  const toolsRaw = p.tools ?? [];
  if (!Array.isArray(toolsRaw) || toolsRaw.length > MAX_TOOLS) return { ok: false, reason: `"tools" must be a list of at most ${MAX_TOOLS} actions.` };
  const tools: ObjectiveParameters["tools"] = [];
  for (const [i, t] of toolsRaw.entries()) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) return { ok: false, reason: `tools[${i}] must be an object.` };
    const r = t as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "capability" && k !== "maxCalls")) return { ok: false, reason: `tools[${i}] has unknown fields.` };
    if (typeof r.capability !== "string" || !loopActionFor(r.capability)) {
      return { ok: false, reason: `tools[${i}]: "${String(r.capability)}" cannot be used by an autonomous loop (no loop action is registered for it).` };
    }
    if (typeof r.maxCalls !== "number" || !Number.isInteger(r.maxCalls) || r.maxCalls < 1 || r.maxCalls > MAX_LOOP_ITERATIONS) {
      return { ok: false, reason: `tools[${i}].maxCalls must be an integer from 1 to ${MAX_LOOP_ITERATIONS}.` };
    }
    if (tools.some((x) => x.capability === r.capability)) return { ok: false, reason: `tools[${i}] repeats "${r.capability}".` };
    tools.push({ capability: r.capability, maxCalls: r.maxCalls });
  }
  if (intents.length === 0 && tools.length === 0) return { ok: false, reason: "an objective needs at least one thinking action or tool." };
  const text = (v: unknown, name: string): string | null | { error: string } => {
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && v.length <= MAX_TEXT ? v : { error: `"${name}" must be at most ${MAX_TEXT} characters.` };
  };
  const completionCriteria = text(p.completionCriteria, "completionCriteria");
  if (completionCriteria && typeof completionCriteria === "object") return { ok: false, reason: completionCriteria.error };
  const escalateWhen = text(p.escalateWhen, "escalateWhen");
  if (escalateWhen && typeof escalateWhen === "object") return { ok: false, reason: escalateWhen.error };
  const inputs = parseStepInputs(p.inputs);
  if (!inputs.ok) return inputs;
  return {
    ok: true,
    params: {
      loop: loop.limits,
      intents: intents as ThinkingIntent[],
      tools,
      completionCriteria: completionCriteria as string | null,
      escalateWhen: escalateWhen as string | null,
      inputs: inputs.inputs,
    },
  };
}

/** R3: save-time check, including that the step's Agent holds a Grant for every allowed tool. */
export async function validateObjectiveStep(
  tx: DrizzleTransaction,
  ctx: { parameters: Record<string, unknown>; graph: LinearGraphDefinition; stepIndex: number; agentDefinitionId: string; agentDefinitionVersion: number }
): Promise<string | null> {
  const parsed = parseObjectiveParameters(ctx.parameters);
  if (!parsed.ok) return parsed.reason;
  const inputs = validateStepInputs(ctx.parameters.inputs, ctx.graph, ctx.stepIndex);
  if (!inputs.ok) return inputs.reason;
  for (const tool of parsed.params.tools) {
    const action = loopActionFor(tool.capability)!;
    if (!(await grantFor(tx, ctx.agentDefinitionId, ctx.agentDefinitionVersion, tool.capability, action.permission))) {
      return `the step's agent holds no Grant for "${tool.capability}" (${action.permission}).`;
    }
  }
  return null;
}

async function grantFor(tx: DrizzleTransaction, agentId: string, agentVersion: number, capabilityName: string, permission: string): Promise<boolean> {
  const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, capabilityName) });
  if (!capability) return false;
  const grants = await tx.query.capabilityGrants.findMany({
    where: and(
      eq(capabilityGrants.agentDefinitionId, agentId),
      eq(capabilityGrants.agentDefinitionVersion, agentVersion),
      eq(capabilityGrants.capabilityId, capability.id),
      isNull(capabilityGrants.revokedAt)
    ),
  });
  return grants.some((g) => g.permissions.includes(permission));
}

/** The effective limits: the operator's ceilings, lowered by the step and the Agent's profile, never raised. */
export function effectiveLimits(step: LoopLimits, profile: ExecutionProfile): { maxIterations: number; maxActiveSeconds: number } {
  return {
    maxIterations: Math.min(MAX_LOOP_ITERATIONS, step.maxIterations ?? MAX_LOOP_ITERATIONS, profile.loop?.maxIterations ?? MAX_LOOP_ITERATIONS),
    maxActiveSeconds: Math.min(MAX_ACTIVE_SECONDS, step.maxActiveSeconds ?? MAX_ACTIVE_SECONDS, profile.loop?.maxActiveSeconds ?? MAX_ACTIVE_SECONDS),
  };
}

// ---------------------------------------------------------------------------
// Schemas (JSON Schema, so the Claude CLI's --json-schema enforces them)
// ---------------------------------------------------------------------------

/**
 * The decision's JSON Schema. Given the step's allowed thinking actions and tools, `intent`
 * and `capability` are enums of exactly those (plus "" when unused), so the structured-output
 * validator refuses an invented action before it reaches the loop's own refusal check.
 */
/**
 * OUTPUT CAPS. Model output was 57% of the V1.1 dogfood's tokens, and the runtime has no
 * output-cap flag — but it does enforce a schema `maxLength` (checked live 2026-09-16: asked
 * for 300 words under a 40-character cap it returned 37). So every field a loop call writes
 * carries a bound. Intermediate work is bounded hardest: it only feeds the ledger and the
 * final write, and the ledger keeps `summary` at 400 characters and `ledgerNote` at 280
 * anyway, so anything longer was paid for and discarded.
 */
export const OUTPUT_CAPS = {
  assessment: 400,
  instruction: 600,
  ledgerNote: 280,
  actionInput: 500,
  requestedArtifacts: MAX_REQUESTED_ARTIFACTS,
  /** R2 Stage 4: how many results a finish may cite as the evidence that its criteria are met. */
  evidenceItems: 4,
  workSummary: 400,
  workContent: 5_000,
  workKeyPoint: 240,
  workKeyPoints: 8,
  /** An artifact id is a uuid; an action name is a registered intent or capability name. */
  artifactId: 64,
  actionName: 120,
} as const;

export function decisionSchema(allowed?: { intents: string[]; tools: string[] }): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assessment: { type: "string", maxLength: OUTPUT_CAPS.assessment },
      done: { type: "boolean" },
      action: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["think", "tool", "gate", "finish"] },
          intent: allowed ? { type: "string", enum: [...allowed.intents, ""] } : { type: "string", maxLength: OUTPUT_CAPS.actionName },
          capability: allowed ? { type: "string", enum: [...allowed.tools, ""] } : { type: "string", maxLength: OUTPUT_CAPS.actionName },
          input: {
            type: "object",
            properties: Object.fromEntries(loopInputFieldNames().map((f) => [f, { type: "string", maxLength: OUTPUT_CAPS.actionInput }])),
            additionalProperties: false,
          },
          instruction: { type: "string", maxLength: OUTPUT_CAPS.instruction },
          useArtifacts: { type: "array", maxItems: OUTPUT_CAPS.requestedArtifacts, items: { type: "string", maxLength: OUTPUT_CAPS.artifactId } },
        },
        required: ["type", "intent", "capability", "input", "instruction", "useArtifacts"],
        additionalProperties: false,
      },
      ledgerNote: { type: "string", maxLength: OUTPUT_CAPS.ledgerNote },
      evidence: { type: "array", maxItems: OUTPUT_CAPS.evidenceItems, items: { type: "string", maxLength: OUTPUT_CAPS.artifactId } },
    },
    required: ["assessment", "done", "action", "ledgerNote", "evidence"],
    additionalProperties: false,
  };
}

export const WORK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: OUTPUT_CAPS.workSummary },
    content: { type: "string", maxLength: OUTPUT_CAPS.workContent },
    keyPoints: { type: "array", maxItems: OUTPUT_CAPS.workKeyPoints, items: { type: "string", maxLength: OUTPUT_CAPS.workKeyPoint } },
  },
  required: ["summary", "content", "keyPoints"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

/** Why a finish counts as evidence-based, or does not: the claim, what code confirmed, and what it could not. */
export type CompletionEvidence = {
  claim: string;
  /** `runId` is the Run that produced the artifact; `fromStep` is set when it was an explicit handoff from an earlier step. */
  verified: { artifactId: string; hash: string; capability: string; iteration: number; runId: string; fromStep?: string }[];
  rejected: string[];
};

/**
 * A handed-off artifact counts as evidence only when ALL of these hold, each written by code rather than by a model:
 * - it is a `deliverable` row: a `report` stores its model's JSON as given, so a `format` or `basis` key inside it
 *   could be forged by injected content (independent review, Stage 5);
 * - its upstream step itself finished `evidence_sufficient`: evidence gathered but never verified — an iteration
 *   limit, a finish citing nothing — must not become verified downstream just by being handed on;
 * - its recorded basis names at least one evidence-bearing capability.
 */
export function carriesRecordedEvidence(row: { type: string }, content: Record<string, unknown> | null): boolean {
  if (row.type !== "deliverable" || content?.format !== DELIVERABLE_FORMAT) return false;
  const completion = content.completion && typeof content.completion === "object" ? (content.completion as { reason?: unknown }) : null;
  if (completion?.reason !== "evidence_sufficient") return false;
  const basis = content.basis && typeof content.basis === "object" ? (content.basis as { evidence?: unknown }) : null;
  return Array.isArray(basis?.evidence) && basis.evidence.length > 0;
}

/** A cited result counts only if its stored content actually holds something: search results or cited sources. */
function holdsResults(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  const inner = c.result && typeof c.result === "object" ? (c.result as Record<string, unknown>) : c;
  return [inner.results, inner.sources].some((v) => Array.isArray(v) && v.length > 0);
}

export type Decision = {
  assessment: string;
  done: boolean;
  action: { type: "think" | "tool" | "gate" | "finish"; intent: string; capability: string; input: Record<string, unknown>; instruction: string; useArtifacts: string[] };
  ledgerNote: string;
  /** R2 Stage 4: when finishing, the result ids the agent claims show its completion criteria are met. A claim, verified by code at conclude. */
  evidence: string[];
};

export function parseDecision(value: unknown): { ok: true; decision: Decision } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object") return { ok: false, reason: "the decision is not an object" };
  const d = value as Record<string, unknown>;
  const a = d.action as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return { ok: false, reason: "the decision has no action" };
  if (!["think", "tool", "gate", "finish"].includes(a.type as string)) return { ok: false, reason: `unknown action type "${String(a.type)}"` };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    ok: true,
    decision: {
      assessment: str(d.assessment).slice(0, MAX_TEXT),
      done: d.done === true,
      action: {
        type: a.type as Decision["action"]["type"],
        intent: str(a.intent),
        capability: str(a.capability),
        input: a.input && typeof a.input === "object" && !Array.isArray(a.input) ? (a.input as Record<string, unknown>) : {},
        instruction: str(a.instruction).slice(0, MAX_TEXT),
        useArtifacts: Array.isArray(a.useArtifacts) ? a.useArtifacts.filter((x): x is string => typeof x === "string").slice(0, MAX_REQUESTED_ARTIFACTS) : [],
      },
      ledgerNote: str(d.ledgerNote).slice(0, NOTE_CHARS),
      evidence: Array.isArray(d.evidence) ? d.evidence.filter((x): x is string => typeof x === "string").slice(0, OUTPUT_CAPS.evidenceItems) : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  iteration: number;
  action: { type: string; intent?: string; capability?: string };
  outcome: { status: "completed" | "refused" | "finished" | "skipped"; reason?: string };
  resultArtifactId: string | null;
  summary: string | null;
  note: string;
};

export type Ledger = {
  format: "agent_ledger/v1";
  iteration: number;
  maxIterations: number;
  finished: boolean;
  entries: LedgerEntry[];
  artifacts: { id: string; label: string }[];
};

// ---------------------------------------------------------------------------
// Active time and budget headroom
// ---------------------------------------------------------------------------

/** Seconds a Run has been actively executing: wall time since it started, less the time spent waiting on Approvals. Pure. */
export function computeActiveSeconds(startedAt: Date, waits: { createdAt: Date; resolvedAt: Date | null }[], now: Date): number {
  const elapsed = now.getTime() - startedAt.getTime();
  const waiting = waits.reduce((sum, w) => {
    const start = Math.max(w.createdAt.getTime(), startedAt.getTime());
    const end = Math.min((w.resolvedAt ?? now).getTime(), now.getTime());
    return sum + Math.max(0, end - start);
  }, 0);
  return Math.max(0, Math.floor((elapsed - waiting) / 1000));
}

async function activeSecondsOf(tx: DrizzleTransaction, runId: string, now: Date): Promise<number> {
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return 0;
  const waits = await tx
    .select({ createdAt: approvals.createdAt, resolvedAt: approvals.resolvedAt })
    .from(approvals)
    .innerJoin(invocations, eq(approvals.invocationId, invocations.id))
    .where(eq(invocations.runId, runId));
  return computeActiveSeconds(run.startedAt, waits, now);
}

const reservationOf = (b: ContextBudget) => b.maxInputTokens + b.expectedOutputTokens;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type ObjectiveConfig = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  parameters: ObjectiveParameters;
  contextBudget: ContextBudget;
  profile: ExecutionProfile;
};

/** Positions of iteration k (1-based) and of the closing positions, for a loop of N iterations. */
export const positions = {
  decide: (k: number) => 3 * (k - 1) + 1,
  act: (k: number) => 3 * (k - 1) + 2,
  record: (k: number) => 3 * (k - 1) + 3,
  conclude: (n: number) => 3 * n + 1,
  write: (n: number) => 3 * n + 2,
  persist: (n: number) => 3 * n + 3,
};

const skip = (reason: string): SkippedPosition => ({ kind: "skip", reason });
const artifactAt = (ctx: InvocationSpecContext, seqNo: number) => ctx.priorArtifacts.find((a) => a.seqNo === seqNo);

async function readJson(tx: DrizzleTransaction, artifactId: string): Promise<unknown> {
  const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
  try {
    return JSON.parse(row?.inlineContent ?? "null");
  } catch {
    return null;
  }
}

export async function buildAgentObjectiveInvocationSpecs(
  tx: DrizzleTransaction,
  config: ObjectiveConfig,
  params: { taskInstanceId: string }
): Promise<PlannedInvocationSpec[]> {
  const run = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const runId = run.id;
  const limits = effectiveLimits(config.parameters.loop, config.profile);
  const N = limits.maxIterations;
  const inputs = await resolveStepInputArtifacts(tx, params.taskInstanceId, config.parameters.inputs);
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, params.taskInstanceId) });
  const goalTitle = taskInstance ? await goalTitleOf(tx, taskInstance.workflowRunId) : null;

  const base = config.contextBudget;
  // R2 Stage 5: a step that was explicitly HANDED evidence decides on it, so its decisions keep the
  // step's full per-artifact allowance. At 60%, a handed-off document just over the cap arrived as a
  // bare reference, and the downstream agent spent its iterations reading the evidence instead of
  // judging it (seen live, 2026-09-16). Steps without inputs keep the smaller decision budget.
  const decideBudget: ContextBudget =
    inputs.length > 0
      ? { ...base, expectedOutputTokens: Math.min(base.expectedOutputTokens, 800) }
      : {
          ...base,
          maxInputTokens: Math.floor(base.maxInputTokens * 0.6),
          maxArtifactTokens: Math.floor(base.maxArtifactTokens * 0.6),
          compressionThreshold: Math.floor(base.compressionThreshold * 0.6),
          expectedOutputTokens: Math.min(base.expectedOutputTokens, 800),
        };
  const actBudget: ContextBudget = { ...base, maxInputTokens: Math.floor(base.maxInputTokens * 0.8), expectedOutputTokens: Math.min(base.expectedOutputTokens, 1_500) };
  const neededForAnotherIteration = reservationOf(decideBudget) + reservationOf(actBudget) + reservationOf(base);

  const llmCommon = {
    kind: "llm" as const,
    costClass: "llm" as const,
    candidateToolCapabilityIds: [],
    taskDifficulty: TIER_DIFFICULTY[config.profile.preferredTier ?? "MID"],
    riskTier: "low" as const,
    ...(config.profile.provider ? { requiredProvider: config.profile.provider } : {}),
  };

  const inputLabels = inputs.map((i) => ({ id: i.artifactId, label: `input from step "${i.stepId}" (${i.type})` }));

  /** The latest ledger before iteration k, if any. */
  async function ledgerBefore(ctx: InvocationSpecContext, k: number): Promise<{ id: string; ledger: Ledger } | null> {
    for (let j = k - 1; j >= 1; j--) {
      const art = artifactAt(ctx, positions.record(j));
      if (art) return { id: art.artifactId, ledger: (await readJson(tx, art.artifactId)) as Ledger };
    }
    return null;
  }

  async function decisionOf(ctx: InvocationSpecContext, k: number) {
    const art = artifactAt(ctx, positions.decide(k));
    if (!art) return null;
    return { art, parsed: parseDecision(await readJson(tx, art.artifactId)) };
  }

  /** Requested artifact ids, kept only if the agent could have been shown them (ledger or step inputs). */
  function allowedRequests(requested: string[], known: { id: string }[]): string[] {
    const ids = new Set(known.map((k) => k.id));
    return [...new Set(requested)].filter((id) => ids.has(id)).slice(0, MAX_REQUESTED_ARTIFACTS);
  }

  const refused = (reason: string): DeterministicInvocationSpec => ({
    kind: "deterministic",
    costClass: "deterministic",
    // Reasons can quote model output (an unknown intent or capability): bounded before they are stored.
    execute: async () => ({ refused: true, reason: reason.slice(0, REASON_CHARS) }),
  });

  // The ceiling is fixed for the Run's life (R1): a plan rebuilt with a different N (a changed
  // ceiling constant mid-run) would misplace its closing positions, so it fails closed.
  const recorded = await tx
    .select({ content: artifacts.inlineContent })
    .from(artifacts)
    .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
    .where(and(eq(invocations.runId, runId), eq(invocations.kind, "deterministic")));
  for (const row of recorded) {
    const ledger = parseJsonObject(row.content);
    if (ledger?.format === "agent_ledger/v1" && ledger.maxIterations !== N) {
      throw new Error(`agent_objective: run "${runId}" started with ${String(ledger.maxIterations)} iterations but its plan now has ${N} (fail closed).`);
    }
  }

  const plan: PlannedInvocationSpec[] = [];
  for (let k = 1; k <= N; k++) {
    // decide(k)
    plan.push((async (ctx) => {
      if (k > 1) {
        const previous = await decisionOf(ctx, k - 1);
        if (!previous) return skip("loop_ended");
        // `done` is the agent saying the objective is met. Honour it as an explicit finish:
        // otherwise a decision that says "done" and then names another action buys a whole
        // further iteration the agent has already told us it does not need.
        if (previous.parsed.ok && (previous.parsed.decision.action.type === "finish" || previous.parsed.decision.done)) return skip("agent_finished");
      }
      const now = new Date();
      const active = await activeSecondsOf(tx, runId, now);
      if (active >= limits.maxActiveSeconds) return skip("active_time_limit");
      if ((await budgetHeadroom(tx, { runId, taskInstanceId: params.taskInstanceId, resourceUnit: "subscription_tokens", now })) < neededForAnotherIteration) {
        return skip("budget_headroom");
      }

      const prior = await ledgerBefore(ctx, k);
      const known = prior?.ledger.artifacts ?? inputLabels;
      const lastDecision = k > 1 ? await decisionOf(ctx, k - 1) : null;
      const requested = lastDecision?.parsed.ok ? allowedRequests(lastDecision.parsed.decision.action.useArtifacts, known) : [];
      // The explicitly handed inputs are offered at EVERY decision, not only the first: they are what
      // this step exists to judge. The Compiler dedups by hash, so a repeat request adds nothing.
      const candidates = [...new Set([...(prior ? [prior.id] : []), ...inputs.slice(0, MAX_REQUESTED_ARTIFACTS).map((i) => i.artifactId), ...requested])];
      const callsUsed = await toolCallsBefore(tx, runId, positions.decide(k));

      const spec: LlmInvocationSpec = {
        ...llmCommon,
        intent: "decide",
        directive: decideDirective({
          k,
          N,
          activeMinutesUsed: Math.floor(active / 60),
          maxActiveMinutes: Math.floor(limits.maxActiveSeconds / 60),
          params: config.parameters,
          callsUsed,
          artifacts: known,
          goalTitle,
        }),
        candidateArtifactIds: [...new Set(candidates)],
        contextBudget: decideBudget,
        expectedOutputShape: decisionSchema({ intents: config.parameters.intents, tools: config.parameters.tools.map((t) => t.capability) }),
      };
      return spec;
    }) satisfies DeferredInvocationSpec);

    // act(k)
    plan.push((async (ctx) => {
      const decision = await decisionOf(ctx, k);
      if (!decision) return skip("no_decision");
      if (!decision.parsed.ok) return refused(decision.parsed.reason);
      const { action } = decision.parsed.decision;
      const prior = await ledgerBefore(ctx, k);
      const known = prior?.ledger.artifacts ?? inputLabels;

      switch (action.type) {
        case "finish":
          return skip("finish");
        case "think": {
          if (!config.parameters.intents.includes(action.intent as ThinkingIntent)) return refused(`thinking action "${action.intent}" is not allowed for this objective`);
          const spec: LlmInvocationSpec = {
            ...llmCommon,
            intent: action.intent as InvocationIntent,
            directive:
              `Carry out one ${action.intent} step toward the objective: the action described by the decision artifact ` +
              `(its "action.instruction"), using the other artifacts provided. Return a short "summary" (at most two sentences), ` +
              `the result as Markdown in "content" — at most ${OUTPUT_CAPS.workContent} characters, so be dense and leave out ` +
              `restatement of the objective or of earlier steps — and at most ${OUTPUT_CAPS.workKeyPoints} "keyPoints". ` +
              `This is working material for the final document, not the document itself.`,
            candidateArtifactIds: [...new Set([decision.art.artifactId, ...(prior ? [prior.id] : []), ...allowedRequests(action.useArtifacts, known)])],
            contextBudget: actBudget,
            expectedOutputShape: WORK_RESULT_SCHEMA,
          };
          return spec;
        }
        case "tool": {
          const allowed = config.parameters.tools.find((t) => t.capability === action.capability);
          if (!allowed) return refused(`"${action.capability}" is not an allowed action for this objective`);
          const loopAction = loopActionFor(action.capability);
          if (!loopAction) return refused(`"${action.capability}" has no loop action`);
          const used = (await toolCallsBefore(tx, runId, positions.act(k)))[action.capability] ?? 0;
          if (used >= allowed.maxCalls) return refused(`"${action.capability}" already used ${used} of ${allowed.maxCalls} calls`);
          const input = parseLoopActionInput(loopAction, action.input);
          if (!input.ok) return refused(input.reason);
          if (!(await grantFor(tx, config.agentDefinitionId, config.agentDefinitionVersion, action.capability, loopAction.permission))) {
            return refused(`the agent holds no Grant for "${action.capability}" (${loopAction.permission})`);
          }

          // An action whose work happens inside the model call (native web search) runs as a
          // governed LLM Invocation carrying exactly the tools its Grant authorized. The
          // Executor re-resolves that Grant and evaluates Policy before dispatching, so this
          // is a narrowing, never the authorization itself.
          if (loopAction.providerTools && loopAction.providerTools.length > 0) {
            const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.name, action.capability) });
            if (!capability) return refused(`"${action.capability}" is not a registered capability`);
            const spec: LlmInvocationSpec = {
              ...llmCommon,
              intent: "extract",
              directive:
                `Find out, using only the tool provided: ${input.input.query ?? action.instruction}. ` +
                "Answer strictly from what the tool returns. Cite every source you used, each with its URL and title. " +
                'If the tool returns nothing usable, say so in "answer" rather than answering from your own knowledge — ' +
                "a claim presented as researched that was not is worse than no answer.",
              candidateArtifactIds: [decision.art.artifactId],
              contextBudget: actBudget,
              expectedOutputShape: loopAction.providerToolOutputSchema ?? WORK_RESULT_SCHEMA,
              capabilityId: capability.id,
              permission: loopAction.permission,
              llmTools: loopAction.providerTools,
            };
            return spec;
          }

          return resolveToolInvocation(tx, {
            capabilityName: loopAction.capabilityName,
            permission: loopAction.permission,
            proposedActionSnapshot: loopAction.toSnapshot(input.input),
          }) as Promise<InvocationSpec>;
        }
        case "gate": {
          const problem = await gateGrantProblem(tx, config.agentDefinitionId, config.agentDefinitionVersion);
          if (problem) return refused(`cannot ask for approval: ${problem}`);
          const question = action.instruction.trim().slice(0, 500);
          if (!question) return refused("an approval request needs a question in action.instruction");
          const decisionRow = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, decision.art.artifactId) });
          return resolveToolInvocation(tx, {
            capabilityName: REVIEW_CHECKPOINT_CAPABILITY.id,
            permission: REVIEW_CHECKPOINT_PERMISSION,
            proposedActionSnapshot: {
              question,
              artifactId: decisionRow!.id,
              artifactHash: decisionRow!.hash,
              artifacts: [{ stepId: `decision-${k}`, id: decisionRow!.id, hash: decisionRow!.hash, type: decisionRow!.type }],
            },
          });
        }
      }
    }) satisfies DeferredInvocationSpec);

    // record(k)
    plan.push((async (ctx) => {
      const decision = await decisionOf(ctx, k);
      if (!decision) return skip("no_decision");
      const prior = await ledgerBefore(ctx, k);
      const actArtifact = artifactAt(ctx, positions.act(k));
      const actInvocation = await tx.query.invocations.findFirst({ where: and(eq(invocations.runId, runId), eq(invocations.seqNo, positions.act(k))) });
      const spec: DeterministicInvocationSpec = {
        kind: "deterministic",
        costClass: "deterministic",
        execute: async () => {
          const d = decision.parsed.ok ? decision.parsed.decision : null;
          const result = actArtifact ? ((await readJson(tx, actArtifact.artifactId)) as Record<string, unknown> | null) : null;
          const finished = d?.action.type === "finish";
          let outcome: LedgerEntry["outcome"];
          if (!decision.parsed.ok) outcome = { status: "refused", reason: decision.parsed.reason.slice(0, REASON_CHARS) };
          else if (finished) outcome = { status: "finished" };
          else if (!actInvocation) outcome = { status: "skipped" };
          else if (result && result.refused === true) outcome = { status: "refused", reason: String(result.reason ?? "").slice(0, REASON_CHARS) };
          else outcome = { status: "completed" };

          const summary =
            outcome.status !== "completed" || !result
              ? null
              : typeof result.summary === "string"
                ? result.summary.slice(0, SUMMARY_CHARS)
                : JSON.stringify(result).slice(0, SUMMARY_CHARS);
          const action: LedgerEntry["action"] = d
            ? {
                type: d.action.type,
                ...(d.action.type === "think" ? { intent: d.action.intent.slice(0, NAME_CHARS) } : {}),
                ...(d.action.type === "tool" ? { capability: d.action.capability.slice(0, NAME_CHARS) } : {}),
              }
            : { type: "invalid" };
          const resultArtifactId = outcome.status === "completed" && actArtifact ? actArtifact.artifactId : null;
          const entry: LedgerEntry = { iteration: k, action, outcome, resultArtifactId, summary, note: d?.ledgerNote ?? "" };
          const label = d?.action.type === "think" ? `iteration ${k}: ${d.action.intent}` : d?.action.type === "tool" ? `iteration ${k}: ${d.action.capability}` : `iteration ${k}`;
          const ledger: Ledger = {
            format: "agent_ledger/v1",
            iteration: k,
            maxIterations: N,
            finished,
            entries: [...(prior?.ledger.entries ?? []), entry],
            artifacts: [...(prior?.ledger.artifacts ?? inputLabels), ...(resultArtifactId ? [{ id: resultArtifactId, label }] : [])].slice(-MAX_LEDGER_ARTIFACTS),
          };
          // R4: structured progress for the live feed and trace. No prompt, context or result text.
          await emitLifecycleEvent(tx, {
            eventType: LOOP_ITERATION_EVENT,
            subjectId: `${runId}:${k}`,
            correlation: await correlationForRun(tx, runId),
            producer: "agent-loop",
            payload: {
              iteration: k,
              maxIterations: N,
              action,
              outcome,
              decisionArtifactId: decision.art.artifactId,
              resultArtifactId,
              note: entry.note,
              activeSeconds: await activeSecondsOf(tx, runId, new Date()),
              finished,
            },
          });
          return ledger;
        },
      };
      return spec;
    }) satisfies DeferredInvocationSpec);
  }

  // conclude: why the loop ended, recorded once, before the final write.
  plan.push((async (ctx) => {
    let iterations = 0;
    let finishing: Decision | null = null;
    for (let k = 1; k <= N; k++) {
      const d = await decisionOf(ctx, k);
      if (!d) break;
      iterations = k;
      // Same rule the decide position stops on: an explicit finish, or the agent saying the
      // objective is met. Without the second clause the run stops for the right reason and
      // then reports the wrong one, because this derives the reason rather than reading it.
      if (d.parsed.ok && (d.parsed.decision.action.type === "finish" || d.parsed.decision.done)) finishing = d.parsed.decision;
    }

    // R2 Stage 4: a finish is a CLAIM. It is recorded as evidence-based completion only when
    // code can confirm what it cites: a result this Run's own ledger recorded as a completed
    // tool action, whose stored content actually holds results. Anything cited that fails that
    // test is kept as rejected, so the record shows what was claimed and what held up.
    let evidence: CompletionEvidence | null = null;
    if (finishing) {
      const entries = (await ledgerBefore(ctx, N + 1))?.ledger.entries ?? [];
      const results = new Map(entries.filter((e) => e.action.type === "tool" && e.outcome.status === "completed" && e.resultArtifactId).map((e) => [e.resultArtifactId!, e]));
      // R2 Stage 5: a downstream agent may also cite what it was explicitly HANDED — a step
      // input resolved by reference from an earlier step's completed Run — but only when that
      // artifact's code-recorded evidence basis shows evidence was actually gathered upstream.
      // Nothing else another agent produced is citable: it was never in this agent's context.
      const handed = new Map(inputs.map((i) => [i.artifactId, i]));
      const verified: CompletionEvidence["verified"] = [];
      const rejected: string[] = [];
      for (const id of [...new Set(finishing.evidence)]) {
        const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, id) });
        const content = row ? parseJsonObject(row.inlineContent) : null;
        const entry = results.get(id);
        const input = handed.get(id);
        if (row && entry && holdsResults(content)) {
          verified.push({ artifactId: id, hash: row.hash, capability: entry.action.capability ?? "", iteration: entry.iteration, runId });
        } else if (row && input && carriesRecordedEvidence(row, content)) {
          verified.push({ artifactId: id, hash: row.hash, capability: "handoff", iteration: 0, runId: input.runId, fromStep: input.stepId });
        } else {
          rejected.push(id);
        }
      }
      evidence = { claim: finishing.assessment.slice(0, SUMMARY_CHARS), verified, rejected };
    }
    const spec: DeterministicInvocationSpec = {
      kind: "deterministic",
      costClass: "deterministic",
      execute: async () => {
        const now = new Date();
        const active = await activeSecondsOf(tx, runId, now);
        // Only a verified citation makes completion evidence-based. A finish without one is still
        // the agent's own decision, and says so; a limit is never either.
        const completion: Completion = evidence
          ? evidence.verified.length > 0
            ? { status: "complete", reason: "evidence_sufficient", evidence }
            : { status: "complete", reason: "agent_finished", evidence }
          : iterations >= N
            ? { status: "incomplete", reason: "max_iterations" }
            : active >= limits.maxActiveSeconds
              ? { status: "incomplete", reason: "active_time_limit" }
              : { status: "incomplete", reason: "budget_headroom" };
        await emitLifecycleEvent(tx, {
          eventType: LOOP_ITERATION_EVENT,
          subjectId: `${runId}:end`,
          correlation: await correlationForRun(tx, runId),
          producer: "agent-loop",
          payload: { iteration: null, maxIterations: N, iterations, terminal: completion, activeSeconds: active, maxActiveSeconds: limits.maxActiveSeconds },
        });
        return { format: "agent_loop_termination/v1", ...completion, iterations, maxIterations: N, activeSeconds: active };
      },
    };
    return spec;
  }) satisfies DeferredInvocationSpec);

  // write: the final deliverable, from the ledger and the latest results only.
  plan.push((async (ctx) => {
    const conclusion = artifactAt(ctx, positions.conclude(N));
    if (!conclusion) throw new Error("agent_objective: the loop has no recorded conclusion (fail closed).");
    const prior = await ledgerBefore(ctx, N + 1);
    const results = (prior?.ledger.artifacts ?? inputLabels).slice(-MAX_REQUESTED_ARTIFACTS).map((a) => a.id);
    const termination = (await readJson(tx, conclusion.artifactId)) as { status?: string; reason?: string } | null;
    const spec: LlmInvocationSpec = {
      ...llmCommon,
      intent: "write",
      directive:
        `${DELIVERABLE_DIRECTIVE}\n\nThe autonomous work has ended (${termination?.status ?? "unknown"}: ${termination?.reason ?? "unknown"}). ` +
        "Write the deliverable for the objective from the ledger and the results provided. If the work ended incomplete, say what remains open.",
      candidateArtifactIds: [...new Set([...(prior ? [prior.id] : []), conclusion.artifactId, ...results])],
      contextBudget: base,
      expectedOutputShape: DELIVERABLE_OUTPUT_SCHEMA,
    };
    return spec;
  }) satisfies DeferredInvocationSpec);

  // persist: the deliverable Artifact, with the evidence basis and completion recorded by code.
  plan.push((async (ctx) => {
    const written = artifactAt(ctx, positions.write(N));
    const conclusion = artifactAt(ctx, positions.conclude(N));
    if (!written || !conclusion) throw new Error("agent_objective: nothing to persist (fail closed).");
    const spec: DeterministicInvocationSpec = {
      kind: "deterministic",
      costClass: "deterministic",
      execute: async () => {
        const output = (await readJson(tx, written.artifactId)) as Record<string, unknown> | null;
        const termination = (await readJson(tx, conclusion.artifactId)) as Completion | null;
        if (!output || !termination) throw new Error("agent_objective: unreadable final output (fail closed).");
        const basis = await evidenceBasisFor(tx, [runId], inputs.map((i) => i.artifactId));
        await persistDeliverableArtifact(tx, written.invocationId, output, { basis, completion: { status: termination.status, reason: termination.reason, ...(termination.evidence ? { evidence: termination.evidence } : {}) } });
        return {};
      },
    };
    return spec;
  }) satisfies DeferredInvocationSpec);

  return plan;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? "null");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function goalTitleOf(tx: DrizzleTransaction, workflowRunId: string | null): Promise<string | null> {
  if (!workflowRunId) return null;
  const wr = await tx.query.workflowRuns.findFirst({ where: (w, { eq: e }) => e(w.id, workflowRunId) });
  const goal = wr ? await tx.query.goals.findFirst({ where: (g, { eq: e }) => e(g.id, wr.goalId) }) : undefined;
  return goal?.title ?? null;
}

/** Tool Invocations proposed in this Run before `seqNo`, counted per capability name. */
async function toolCallsBefore(tx: DrizzleTransaction, runId: string, seqNo: number): Promise<Record<string, number>> {
  const rows = await tx
    .select({ capability: capabilities.name })
    .from(invocations)
    .innerJoin(capabilities, eq(invocations.capabilityId, capabilities.id))
    .where(and(eq(invocations.runId, runId), eq(invocations.kind, "tool"), lt(invocations.seqNo, seqNo)));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.capability] = (counts[r.capability] ?? 0) + 1;
  return counts;
}

function decideDirective(v: {
  k: number;
  N: number;
  activeMinutesUsed: number;
  maxActiveMinutes: number;
  params: ObjectiveParameters;
  callsUsed: Record<string, number>;
  artifacts: { id: string; label: string }[];
  goalTitle: string | null;
}): string {
  const lines = [
    "You are working autonomously toward the objective in the task state (the Goal). Decide the single next action.",
    `Iteration ${v.k} of at most ${v.N}; active time ${v.activeMinutesUsed} of ${v.maxActiveMinutes} minutes.`,
    v.params.intents.length > 0 ? `Thinking actions (type "think", set "intent"): ${v.params.intents.join(", ")}. Put what to do in "instruction".` : "No thinking actions are allowed.",
  ];
  for (const t of v.params.tools) {
    const action = loopActionFor(t.capability)!;
    const fields = Object.entries(action.inputFields).map(([f, s]) => `${f} (${s.description})`).join(", ");
    lines.push(`Tool (type "tool", "capability": "${t.capability}"): ${action.describe}. Input: ${fields}. ${v.callsUsed[t.capability] ?? 0} of ${t.maxCalls} calls used.`);
  }
  if (v.params.escalateWhen) lines.push(`Ask the operator (type "gate", question in "instruction") when: ${v.params.escalateWhen}`);
  lines.push(`Finish (type "finish") when: ${v.params.completionCriteria ?? "the objective is satisfied well enough to write the final deliverable"}. A final deliverable is written after you finish or a limit is reached.`);
  lines.push(
    v.artifacts.length > 0
      ? `Artifacts you may request for your next action by id in "useArtifacts" (at most ${MAX_REQUESTED_ARTIFACTS}): ${v.artifacts.map((a) => `${a.id} = ${a.label}`).join("; ")}.`
      : "No results exist yet."
  );
  lines.push('The ledger artifact (if present) records every earlier action and outcome; do not repeat work it shows. Set unused fields to "" or [].');
  lines.push(
    'When you finish, put in "evidence" the ids of the results, or of inputs from earlier steps, that show the completion criteria are met, and say in "assessment" which criteria they satisfy. ' +
      "A finish is recorded as evidence-based only if what it cites is a completed result that holds results, or an input whose recorded evidence basis shows evidence was gathered; otherwise leave \"evidence\" empty."
  );
  lines.push(`"assessment": one or two sentences on progress. "ledgerNote": what this action is for, at most ${NOTE_CHARS} characters.`);
  return lines.join("\n");
}

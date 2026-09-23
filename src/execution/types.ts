/**
 * Executor types (Phase 3d/11.1, Unit 6 MVP scope).
 *
 * Pre-dispatch Ruling 1 redesigns the brief's flat `InvocationSpec` (a loose
 * `payload: Record<string, unknown>`) as a discriminated union keyed by
 * `kind` — see the task-6 brief for the exact shapes required verbatim.
 *
 * `"browser"` kind: the brief explicitly permits omitting it from this union
 * ("unused by both MVP workflows... your call, document whichever you
 * choose"). DECISION: omitted entirely. `InvocationKind` here is therefore a
 * strict subset of the DB's `invocation_kind` enum (which does include
 * "browser", for future units). Adding a `BrowserInvocationSpec` variant
 * later is a purely additive change to this union — nothing here forecloses
 * it — and no code in this unit ever needs to construct or match on it, so a
 * stub variant would be dead weight today (`noUnusedLocals`/
 * `noUnusedParameters` are on in tsconfig, which makes unused stub branches
 * an active liability, not a neutral placeholder).
 */
import type { CostClass } from "../governance/costClass.js";
import type { CapabilityPermission } from "../governance/policy.js";
import type { RiskTier } from "../governance/risk.js";
import type { CompiledContext, ContextBudget, InvocationIntent } from "../context/types.js";
import type { RouteResult } from "../router/types.js";
import type { ProviderName } from "../router/tierConfig.js";

export type InvocationKind = "llm" | "tool" | "retrieval" | "deterministic";

/**
 * What a tool's `execute` receives (spec §12, "Idempotency, including external
 * side effects"). `idempotencyKey` is the Invocation's persisted, unique
 * `invocations.idempotency_key` (`run:<runId>:seq:<seqNo>`): an adapter passes it
 * to an external API that supports idempotency keys, or uses it to recognise
 * its own earlier attempt. The same Invocation never gets a second key.
 */
export type ToolExecutionContext = { invocationId: string; idempotencyKey: string };

export type ToolInvocationSpec = {
  kind: "tool";
  costClass: CostClass;
  capabilityId: string;
  permission: CapabilityPermission;
  proposedActionSnapshot: Record<string, unknown>;
  toolBindingId: string;
  /** Caller-supplied cost estimate — Unit 2's `reserveBudget` treats estimation as the caller's responsibility. */
  estimatedCost: number;
  /**
   * The actual tool call, supplied directly by the caller. No Tool Adapter
   * registry exists (or is needed) at MVP's 2-capability scale.
   *
   * Called with NO database transaction open, after the Invocation is committed
   * as `executing` (DURABLE_EXECUTION §2.1), so it must not close over a
   * transaction: read what it needs when the spec is built. At most once per
   * Invocation — an interrupted call is never repeated. An error that PROVES
   * nothing was performed should carry `consumption: "none"` (the reservation is
   * then released); any other error is treated as possibly performed and charged
   * at the estimate.
   */
  execute: (ctx: ToolExecutionContext) => Promise<Record<string, unknown>>;
};

export type LlmInvocationSpec = {
  kind: "llm";
  costClass: "llm";
  intent: InvocationIntent;
  /** V1.1: a trusted directive for the Compiler's invocation-instruction layer (`CompileContextInput.directive`). Never model output. */
  directive?: string;
  /** R2: model-written directive text, fenced by the Compiler (`CompileContextInput.untrustedDirective`). */
  untrustedDirective?: string;
  /** V1.1: the Agent's provider restriction, passed to the Router (`RouteRequest.requiredProvider`). */
  requiredProvider?: ProviderName;
  candidateArtifactIds: string[];
  candidateToolCapabilityIds: string[];
  contextBudget: ContextBudget;
  /** Declared directly by the caller (the Task Definition's own characterization) — see Ruling 2. */
  taskDifficulty: "simple" | "standard" | "complex";
  /** Declared directly by the caller — see Ruling 2. LLM Invocations have no Capability, so the
   *  capability-driven `computeRiskTier` formula does not apply; this is never computed via Policy. */
  riskTier: RiskTier;
  expectedOutputShape: Record<string, unknown>;
  /**
   * R2: a provider-side tool this call may use (native web search), and the Capability
   * it runs under. All three are set together or not at all: the tool list is derived
   * from the Grant the Executor resolves for `capabilityId`/`permission`, so an LLM call
   * that reaches a third party is governed exactly like a Tool Invocation — Grant,
   * Policy, budget and stops — rather than being an invisible side effect inside a model
   * call. Absent means the V1 posture: no tools.
   */
  capabilityId?: string;
  permission?: CapabilityPermission;
  llmTools?: readonly string[];
};

export type DeterministicInvocationSpec = {
  kind: "deterministic";
  costClass: "deterministic";
  execute: () => Promise<Record<string, unknown>>;
};

export type RetrievalInvocationSpec = {
  kind: "retrieval";
  costClass: "local_retrieval";
  execute: () => Promise<Record<string, unknown>>;
};

export type InvocationSpec =
  | ToolInvocationSpec
  | LlmInvocationSpec
  | DeterministicInvocationSpec
  | RetrievalInvocationSpec;

// ---------------------------------------------------------------------------
// Deferred (lazily-resolved) spec positions — final-review Finding 4
// ---------------------------------------------------------------------------

/**
 * One Artifact already produced by an EARLIER Invocation of the SAME Run.
 *
 * Deliberately ids only — never `inlineContent`. Phase 5.5 ("Artifact
 * references vs. content") makes reference the default and leaves the
 * reference-vs-content decision to the Context Compiler; a deferred spec
 * therefore declares these ids (e.g. in `LlmInvocationSpec.candidateArtifactIds`)
 * and lets `compileContext` decide what, if anything, to inline. The Executor
 * that assembles this never reads an artifact's content.
 *
 * `seqNo` is the producing Invocation's per-Run sequence number (Phase 3e's
 * authoritative causal order). ALWAYS select by `seqNo`, never by array
 * position: `artifacts.created_at` is `defaultNow()`, and Postgres `now()` is
 * transaction-stable, so every artifact written inside one transaction shares a
 * timestamp and creation-time ordering is not meaningful.
 */
export type PriorInvocationArtifact = {
  seqNo: number;
  invocationId: string;
  artifactId: string;
};

/** The Run State (Phase 5.6) a deferred spec is resolved against: "only prior Invocation outputs within this Run". */
export type InvocationSpecContext = {
  /** Ordered by producing `seqNo` (ascending), then artifact id as a stable tiebreak. */
  priorArtifacts: PriorInvocationArtifact[];
};

/**
 * A spec position that cannot be computed until earlier positions of the same
 * Run have actually executed — Phase 5.8's "a prior Tool Invocation's
 * structured output becomes a new high-priority candidate for the next
 * compilation", which is otherwise unimplementable because the whole plan is
 * materialized before the Run's first Invocation runs.
 *
 * `executeRun` resolves this immediately before processing that position, and
 * ONLY if the position actually needs processing — an already-`completed`
 * Invocation is skipped without the thunk ever being called (see
 * `resolvePlannedSpec`'s call site in `./executor.ts`).
 *
 * DETERMINISM CONTRACT: a deferred spec at a position that can reach
 * `awaiting_approval` (i.e. a `"tool"` spec whose Grant is not `AUTONOMOUS`)
 * MUST resolve byte-identically across calls — `resumeToolSpec` deep-equals the
 * resuming spec against the stored invocation and fails it as
 * `"resume_spec_mismatch"` otherwise. This is the same determinism requirement
 * `InvocationSpecBuilder` already carries (`../workflow/interpreter.ts`). No
 * such spec exists today; the type merely permits one.
 */
export type DeferredInvocationSpec = (ctx: InvocationSpecContext) => Promise<InvocationSpec | SkippedPosition>;

/**
 * V1.1 (R1, approved 2026-09-15): what a DEFERRED position resolves to when it must not
 * run, e.g. every iteration after an autonomous agent's explicit finish. The Executor
 * proposes no Invocation for it and moves on. The plan's maximum length is still fixed
 * when the plan is built; a skip can only make a planned position not happen, never add
 * one. A skip is sticky: once a later position has an Invocation, an earlier position
 * without one is never resolved again (`executeRun`). A position that already has an
 * Invocation can never skip.
 */
export type SkippedPosition = { kind: "skip"; reason: string };

/**
 * One position in a Run's invocation plan: either a ready-made spec or a
 * deferred one.
 *
 * NOTE what this deliberately does NOT allow: the plan's LENGTH and ORDER are
 * still fixed by the caller before `executeRun` begins. A deferred position can
 * change WHAT an already-decided position is, or (V1.1, R1) resolve to
 * `SkippedPosition` so it does not happen; it can never add positions or
 * reorder them. Workflow topology stays deterministic and stays the
 * Workflow Interpreter's decision (Phase 11 / Phase 3d — "The Workflow never
 * delegates topology decisions to a model"); this is only data flowing between
 * already-decided Invocations inside one Run, which Phase 11 explicitly permits
 * ("within the Run's fixed Task/budget/Agent scope").
 */
export type PlannedInvocationSpec = InvocationSpec | DeferredInvocationSpec;

/**
 * An LLM Invocation committed as `executing` whose provider call must now be
 * made OUTSIDE any transaction (Phase 9). Carried in memory only: the compiled
 * context is not persisted, because an interrupted dispatch is never re-sent —
 * see `failInterruptedInvocation` (`./executor.ts`).
 */
export type PendingModelDispatch = {
  kind: "llm";
  invocationId: string;
  runId: string;
  route: RouteResult;
  compiledContext: CompiledContext;
  expectedOutputShape: Record<string, unknown>;
};

/**
 * A Tool Invocation committed as `executing` whose `execute` must now run
 * OUTSIDE any transaction (DURABLE_EXECUTION §2.1). Carries what the driver's
 * pre-effect authorization check and the recording transaction need. Memory
 * only: an interrupted tool call is never repeated, so nothing here is persisted.
 */
export type PendingToolDispatch = {
  kind: "tool";
  invocationId: string;
  runId: string;
  seqNo: number;
  idempotencyKey: string;
  reservationId: string;
  estimatedCost: number;
  capabilityId: string;
  permission: CapabilityPermission;
  toolBindingId: string;
  proposedActionSnapshot: Record<string, unknown>;
  execute: ToolInvocationSpec["execute"];
};

export type PendingDispatch = PendingModelDispatch | PendingToolDispatch;

/** The result of running a tool dispatch. Never a thrown error: failures are values, as for model dispatches. */
export type ToolDispatchOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: unknown };

/**
 * - `completed` / `failed` / `awaiting_approval`: as before.
 * - `dispatch_required`: the Run yielded at an LLM or Tool Invocation committed
 *   as `executing`. The caller must commit, dispatch `dispatch` with no
 *   transaction open, record the outcome (`completeModelDispatch` /
 *   `completeToolDispatch`) in a fresh transaction, and call `executeRun` again
 *   to continue.
 * - `in_flight`: another caller in this process is dispatching this Run's
 *   current Invocation right now. Nothing was changed; try again later.
 */
export type RunOutcome =
  | { status: "completed" | "failed" | "awaiting_approval"; runId: string }
  | { status: "dispatch_required"; runId: string; dispatch: PendingDispatch }
  | { status: "in_flight"; runId: string };

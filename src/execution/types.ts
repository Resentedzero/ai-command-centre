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
import type { ContextBudget } from "../context/types.js";

export type InvocationKind = "llm" | "tool" | "retrieval" | "deterministic";

export type ToolInvocationSpec = {
  kind: "tool";
  costClass: CostClass;
  capabilityId: string;
  permission: CapabilityPermission;
  proposedActionSnapshot: Record<string, unknown>;
  toolBindingId: string;
  /** Caller-supplied cost estimate — Unit 2's `reserveBudget` treats estimation as the caller's responsibility. */
  estimatedCost: number;
  /** The actual tool call, supplied directly by the caller. No Tool Adapter registry exists (or is needed) at MVP's 2-capability scale. */
  execute: () => Promise<Record<string, unknown>>;
};

export type LlmInvocationSpec = {
  kind: "llm";
  costClass: "llm";
  intent: "classify" | "synthesize" | "extract" | "decide" | "summarize";
  candidateArtifactIds: string[];
  candidateToolCapabilityIds: string[];
  contextBudget: ContextBudget;
  /** Declared directly by the caller (the Task Definition's own characterization) — see Ruling 2. */
  taskDifficulty: "simple" | "standard" | "complex";
  /** Declared directly by the caller — see Ruling 2. LLM Invocations have no Capability, so the
   *  capability-driven `computeRiskTier` formula does not apply; this is never computed via Policy. */
  riskTier: RiskTier;
  expectedOutputShape: Record<string, unknown>;
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
export type DeferredInvocationSpec = (ctx: InvocationSpecContext) => Promise<InvocationSpec>;

/**
 * One position in a Run's invocation plan: either a ready-made spec or a
 * deferred one.
 *
 * NOTE what this deliberately does NOT allow: the plan's LENGTH and ORDER are
 * still fixed by the caller before `executeRun` begins. A deferred position can
 * change WHAT an already-decided position is; it can never change WHETHER or
 * HOW MANY positions exist. Workflow topology stays deterministic and stays the
 * Workflow Interpreter's decision (Phase 11 / Phase 3d — "The Workflow never
 * delegates topology decisions to a model"); this is only data flowing between
 * already-decided Invocations inside one Run, which Phase 11 explicitly permits
 * ("within the Run's fixed Task/budget/Agent scope").
 */
export type PlannedInvocationSpec = InvocationSpec | DeferredInvocationSpec;

export type RunOutcome = { status: "completed" | "failed" | "awaiting_approval"; runId: string };

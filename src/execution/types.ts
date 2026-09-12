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

export type RunOutcome = { status: "completed" | "failed" | "awaiting_approval"; runId: string };

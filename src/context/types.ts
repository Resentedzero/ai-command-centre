/**
 * Context Compiler types (Phase 5, Unit 4 MVP scope). Frozen interface per
 * the Unit 4 brief — do not add fields speculatively.
 */

export type ContextBudget = {
  maxInputTokens: number;
  maxArtifactTokens: number;
  maxRetrievedItems: number;
  maxToolSchemaTokens: number;
  compressionThreshold: number;
  freshnessRequirementSeconds: number;
  expectedOutputTokens: number;
};

export type ContextCandidateKind = "task_state" | "artifact_ref" | "artifact_content" | "tool_schema";

export type ContextCandidate = {
  kind: ContextCandidateKind;
  id: string; // MUST resolve to a real, persisted row (artifact id, etc.) — never an ad hoc in-memory key
  tier: 1 | 2 | 3 | 4;
  estimatedTokens: number;
  freshnessTimestamp: Date | null;
  trusted: boolean;
};

export type ExclusionReason = "budget" | "stale" | "duplicate" | "irrelevant" | "unauthorized";

/**
 * One included candidate's lineage (spec §5.13, extended 2026-09-14): what it
 * was, whether it was trusted, what it added to the prompt (framing included),
 * and for an artifact the exact version and content hash that went in.
 */
export type IncludedProvenance = {
  id: string;
  tier: number;
  kind: ContextCandidateKind;
  trusted: boolean;
  estimatedTokens: number;
  version?: number;
  hash?: string;
};

/**
 * Spec §5.16 "tokens actually used", measured deterministically: which included
 * artifacts the output references by id. Recorded on `invocation_completed`.
 */
export type ArtifactReferenceMeasurement = {
  includedArtifactIds: string[];
  referencedArtifactIds: string[];
  includedArtifactTokens: number;
  referencedArtifactTokens: number;
};

export type CompiledContext = {
  layers: {
    instructions: string;
    constraints: string;
    taskState: string;
    memory: string;
    artifacts: string;
    toolSchemas: Record<string, unknown>[];
    /** Spec §5.14 layer 7: this Invocation's declared intent and required output shape. */
    invocationInstruction: string;
  };
  provenance: {
    included: IncludedProvenance[];
    excluded: { id: string; reason: ExclusionReason }[];
  };
  estimatedInputTokens: number;
};

/**
 * `compileContext`'s parameter object, named here for reuse between
 * `compiler.ts` and its tests. Structurally identical to the inline type in
 * the brief's interface listing — pulling it into a named export changes
 * nothing about the public contract.
 */
export type CompileContextInput = {
  intent: "classify" | "synthesize" | "extract" | "decide" | "summarize";
  taskInstanceId: string;
  /**
   * The Run this compilation serves (added 2026-09-14). Its bound Agent
   * Definition supplies the instructions layer (spec §5.14 layer 1: system/role
   * instructions), and its Capability Grants bound which tool schemas may be
   * included (§5.7). Optional: without it the instructions layer is empty and
   * every tool schema is excluded as `unauthorized`.
   */
  runId?: string;
  /** The JSON shape the Invocation must return; rendered into the invocation-instruction layer and counted in the budget. */
  expectedOutputShape: Record<string, unknown>;
  candidateArtifactIds: string[];
  candidateToolCapabilityIds: string[];
  budget: ContextBudget;
};

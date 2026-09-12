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

export type CompiledContext = {
  layers: {
    instructions: string;
    constraints: string;
    taskState: string;
    memory: string;
    artifacts: string;
    toolSchemas: Record<string, unknown>[];
  };
  provenance: {
    included: { id: string; tier: number }[];
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
  candidateArtifactIds: string[];
  candidateToolCapabilityIds: string[];
  budget: ContextBudget;
};

/**
 * The FROZEN canonical Event envelope — Phase 8.1 in full, as specified by
 * Unit 1's brief. Do not add, remove, or flatten fields here without
 * updating the spec first: this type is the reviewable contract for every
 * other unit that emits or consumes events.
 */
export type EventEnvelope = {
  eventId: string; // generated UUID, primary key
  idempotencyKey: string; // caller-supplied, unique constraint — the actual dedup key
  eventType: string;
  eventVersion: number; // payload shape version for this eventType (Phase 20 risk #9)
  occurredAt: Date; // display only, never used for ordering
  sequenceNo: number; // monotonic, scoped per runId — authoritative for ordering
  causationId: string | null; // the event/invocation that directly caused this one
  correlation: {
    goalId: string | null;
    workflowRunId: string | null;
    taskInstanceId: string | null;
    runId: string | null;
    invocationId: string | null;
  };
  actor: string; // "agent:<id>@<version>" | "human:<id>" | "system"
  producer: string; // which module emitted this, e.g. "executor" | "workflow-interpreter" | "api"
  payload: Record<string, unknown>; // typed per eventType by convention; not a discriminated union for MVP
  usage: {
    tokensIn: number;
    tokensOut: number;
    cacheHit: boolean;
    costAmount: number;
    modelId: string;
  } | null; // present only for LLM-related events; never flattened onto the envelope itself
};

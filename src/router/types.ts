/**
 * Model Router types (Phase 10, Unit 5). Base shapes are the brief's frozen
 * interfaces; two fields are added per documented rulings below — both
 * additions, never removals or narrowings, so nothing that already typechecks
 * against the brief's original shapes stops typechecking.
 */
import type { RiskTier } from "../governance/risk.js";
import type { ContextBudget } from "../context/types.js";

export type ModelTier = "CHEAP" | "STRONG";

export type RouteRequest = {
  taskDifficulty: "simple" | "standard" | "complex";
  riskTier: RiskTier; // "high"/"highest" forces STRONG — QUALITY FLOOR ONLY
  contextBudget: ContextBudget;
  runId: string;
  taskInstanceId: string;
  // Pre-dispatch ruling addition: the brief's frozen RouteRequest has no
  // invocationId, but its own "Tests required" list demands the routing
  // decision be captured as structured payload on the `invocation_started`
  // event — impossible without something to attach the event to. The caller
  // (a future Unit 6 Executor) is expected to have already created the
  // `invocations` row before calling `authorizeRoute`; this unit never
  // creates Invocation rows itself.
  invocationId: string;
};

export type RouteResult = {
  tier: ModelTier;
  modelId: string;
  reservationId: string;
  // Further addition (this unit's own resolution, in the same spirit as the
  // invocationId ruling above): the brief's frozen RouteResult has no
  // invocationId either, but `callModel` is separately required (same
  // pre-dispatch ruling, point 3) to emit `invocation_completed` correlated
  // to an invocation — and `callModel`'s only input besides the compiled
  // context is `RouteResult`. Without carrying invocationId forward from
  // `authorizeRoute`'s `req.invocationId` into its returned `RouteResult`,
  // `callModel` would have no way to know which invocation it is completing.
  // This is a minimal, additive extension of the same gap, not a new
  // architectural choice.
  invocationId: string;
  // Fix round 1 addition (independent review, Important #1): `callModel`'s
  // `invocation_completed` emission was correlating with `runId: null` /
  // `taskInstanceId: null` because RouteResult didn't carry them, even
  // though every invocation belongs to a real, non-null run. Per Unit 1's
  // `emit.ts`, a `runId: null` event falls into the shared GLOBAL sequence
  // bucket instead of the per-run monotonic counter — breaking "all events
  // for run X in order" queries and needlessly contending a shared advisory
  // lock across unrelated runs. Same additive-extension pattern as
  // `invocationId` above: `authorizeRoute` already has `req.runId`/
  // `req.taskInstanceId`, so it now carries them forward too.
  runId: string;
  taskInstanceId: string;
};

/**
 * Performance eligibility as the read APIs display it (`GET /agents/:id` `performance`,
 * `GET /costs` `costVsSuccess`). The runtime's own gate decides (`performanceEligibility`,
 * N = `MIN_PERFORMANCE_SAMPLES`), so a UI never compares `sampleCount` with N itself.
 *
 * Display only: nothing here feeds a decision. The Model Router's tier preference is the
 * only decision that reads eligibility; Policy, Approvals and the Executor never import
 * the gate, and only the two read routes import this helper
 * (`tests/execution/structuralInvariants.test.ts`).
 */
import { MIN_PERFORMANCE_SAMPLES, performanceEligibility } from "../governance/performanceEligibility.js";

export function eligibilityFields(sampleCount: number): {
  eligible: boolean;
  eligibilityReason: "insufficient_samples" | "no_criterion" | null;
  minSamples: number | null;
} {
  const eligibility = performanceEligibility(sampleCount);
  return {
    eligible: eligibility.eligible,
    eligibilityReason: eligibility.eligible ? null : eligibility.reason,
    minSamples: MIN_PERFORMANCE_SAMPLES,
  };
}

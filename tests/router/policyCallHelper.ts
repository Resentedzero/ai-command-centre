/**
 * Test-only helper used solely to prove that `vi.spyOn` on
 * `governance/policy.ts`'s namespace object actually intercepts a REAL
 * cross-module call (i.e. a call made from code other than the test file
 * itself) under this project's Vitest+TS setup. Without this positive
 * control, the "authorizeRoute/callModel never call evaluatePolicy" spy
 * assertion in `modelRouter.test.ts` would pass vacuously whether or not
 * spy interception actually works cross-module — since `modelRouter.ts`
 * genuinely never imports `evaluatePolicy` either way, a spy that silently
 * fails to wire up would report "0 calls" for the wrong reason.
 */
import { evaluatePolicy } from "../../src/governance/policy.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

export async function callEvaluatePolicyForTest(tx: DrizzleTransaction) {
  return evaluatePolicy(tx, {
    grant: null,
    permission: "READ",
    proposedActionSnapshot: {},
    trustLevel: "first_party",
  });
}

/**
 * The internal function behind `system.keep_stats`, and its autonomous-loop action. `prepare` validates
 * the snapshot (exactly `{ window }`, one of the fixed windows) and computes the statistics in the
 * builder's transaction; `execute` only returns them. Evidence class `system_state`: the Keep's own
 * records, never research.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import type { LoopAction } from "../shared/loopActions.js";
import { KEEP_STATS_CAPABILITY, KEEP_STATS_READ, KEEP_STATS_WINDOWS, parseKeepStatsWindow } from "./capability.js";
import { computeKeepStats } from "./stats.js";

export const keepStatsRead: InternalToolFunction = {
  capabilityName: KEEP_STATS_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const keys = Object.keys(proposedActionSnapshot);
    if (keys.length !== 1 || keys[0] !== "window") throw new Error(`${KEEP_STATS_READ}: the request must be exactly { window } (got ${keys.join(", ") || "nothing"}).`);
    const window = parseKeepStatsWindow(proposedActionSnapshot.window);
    if (!window) throw new Error(`${KEEP_STATS_READ}: window must be one of ${Object.keys(KEEP_STATS_WINDOWS).join(", ")}.`);
    return { inputs: { stats: await computeKeepStats(tx, window) }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  async execute({ inputs }) {
    return inputs.stats as Record<string, unknown>;
  },
};

export const keepStatsLoopAction: LoopAction = {
  capabilityName: KEEP_STATS_CAPABILITY.id,
  permission: "READ",
  describe: `read recorded Command Keep statistics for a recent window (${Object.keys(KEEP_STATS_WINDOWS).join(", ")}): goals, runs, model and tool calls, subscription tokens, agents that worked, approvals, stops. Report its figures exactly as returned; never add, total or derive new numbers`,
  inputFields: { window: { maxLength: 3, description: `one of ${Object.keys(KEEP_STATS_WINDOWS).join(", ")}` } },
  toSnapshot: (input) => ({ window: input.window }),
  // A window outside the fixed list is refused like a missing Grant: recorded, never run.
  async prove(_tx, _run, input) {
    const window = parseKeepStatsWindow(input.window);
    return window ? { ok: true, snapshot: { window } } : { ok: false, reason: `window must be one of ${Object.keys(KEEP_STATS_WINDOWS).join(", ")}` };
  },
};

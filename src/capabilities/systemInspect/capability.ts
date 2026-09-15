/**
 * `system.inspect` (V1.1): read a bounded, deterministic explanation of the Command
 * Keep's own state for one subject (a workflow run, approval, agent, artifact, goal,
 * run, or the whole system). The Keeper's Think answers read state only through it,
 * under a READ Grant, so even a reasoning Keeper holds no write path.
 */
export const SYSTEM_INSPECT_CAPABILITY = {
  id: "system.inspect",
  description: "Read a bounded explanation of the Command Keep's own current state for one subject",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

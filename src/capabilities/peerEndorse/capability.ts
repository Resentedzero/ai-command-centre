/**
 * `peer.endorse` (R2 progression, operator decision D4): an agent records that another agent's
 * deliverable was useful to its own work. Governed like any Capability — Grant, Policy, budget,
 * stops, events — and worth ZERO XP. It is a signal an operator can read, never authority.
 */
export const PEER_ENDORSE_CAPABILITY = {
  id: "peer.endorse",
  description: "Record that another agent's deliverable, received in this run's context, was useful (no XP; evidence only)",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

/** An endorsement creates a record; it changes no artifact and no other agent. */
export const PEER_ENDORSE_PERMISSION = "CREATE" as const;

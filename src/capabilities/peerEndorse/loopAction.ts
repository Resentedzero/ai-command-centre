/**
 * `peer.endorse` as an autonomous loop action. The decision names an artifact and a reason; the
 * runtime's proof (`./proof.ts`) decides whether it may be endorsed and supplies the hash, the
 * endorsing Run and the endorsed agent. A refused proof is refused like a missing Grant.
 */
import type { LoopAction } from "../shared/loopActions.js";
import { PEER_ENDORSE_CAPABILITY, PEER_ENDORSE_PERMISSION } from "./capability.js";
import { MAX_ENDORSEMENT_REASON, proveEndorsement } from "./proof.js";

export const peerEndorseLoopAction: LoopAction = {
  capabilityName: PEER_ENDORSE_CAPABILITY.id,
  permission: PEER_ENDORSE_PERMISSION,
  describe: "endorse another agent's deliverable that you received in this run and found useful (a signal only; earns no XP)",
  inputFields: {
    artifactId: { maxLength: 36, description: "the id of the other agent's deliverable you received" },
    reason: { maxLength: MAX_ENDORSEMENT_REASON, description: "why it was useful to your work" },
  },
  toSnapshot: (input) => ({ artifactId: input.artifactId, reason: input.reason }),
  prove: async (tx, { runId }, input) => proveEndorsement(tx, { endorserRunId: runId, artifactId: input.artifactId!, reason: input.reason! }),
};

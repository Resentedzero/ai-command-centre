/**
 * The internal function behind `peer.endorse`. `prepare` proves the snapshot again from persisted
 * rows (`./proof.ts`), so a snapshot that did not come from the loop's proof fails closed; `execute`
 * returns the endorsement record. No other effect, no evidence, no XP.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { PEER_ENDORSE_CAPABILITY } from "./capability.js";
import { proveEndorsement } from "./proof.js";

export const PEER_ENDORSE_RECORD = "peer.endorse.record";

export const peerEndorseRecord: InternalToolFunction = {
  capabilityName: PEER_ENDORSE_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot: s }) {
    if (typeof s.artifactId !== "string" || typeof s.artifactHash !== "string" || typeof s.endorserRunId !== "string" || typeof s.reason !== "string") {
      throw new Error(`${PEER_ENDORSE_RECORD}: the endorsement was not proven by the runtime (fail closed).`);
    }
    const proof = await proveEndorsement(tx, { endorserRunId: s.endorserRunId, artifactId: s.artifactId, reason: s.reason });
    if (!proof.ok) throw new Error(`${PEER_ENDORSE_RECORD}: ${proof.reason} (fail closed).`);
    if (proof.snapshot.artifactHash !== s.artifactHash || proof.snapshot.endorsedAgentName !== s.endorsedAgentName) {
      throw new Error(`${PEER_ENDORSE_RECORD}: the snapshot does not match the record (fail closed).`);
    }
    return { inputs: { endorsement: proof.snapshot }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => ({ endorsed: true, endorsement: inputs.endorsement }),
};

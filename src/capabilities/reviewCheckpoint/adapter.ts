/**
 * The internal function behind `review.checkpoint`'s binding. `prepare` proves every
 * pinned output still exists with the pinned hash (Artifacts are immutable, so this
 * also holds at execution); `execute` records that the operator let the workflow
 * continue. It has no other effect and carries no evidence.
 */
import { inArray } from "drizzle-orm";
import { artifacts } from "../../db/schema.js";
import type { InternalToolFunction } from "../toolAdapters.js";
import { REVIEW_CHECKPOINT_CAPABILITY } from "./capability.js";

export const REVIEW_CHECKPOINT_RECORD = "review.checkpoint.record";

export const reviewCheckpointRecord: InternalToolFunction = {
  capabilityName: REVIEW_CHECKPOINT_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot }) {
    const question = proposedActionSnapshot.question;
    const pinned = proposedActionSnapshot.artifacts;
    if (typeof question !== "string" || question.trim() === "") throw new Error(`${REVIEW_CHECKPOINT_RECORD}: the checkpoint has no question.`);
    if (!Array.isArray(pinned) || pinned.length === 0) throw new Error(`${REVIEW_CHECKPOINT_RECORD}: the checkpoint pins no outputs.`);
    const wanted = pinned.map((p) => p as { id?: unknown; hash?: unknown });
    if (!wanted.every((p) => typeof p.id === "string" && typeof p.hash === "string")) {
      throw new Error(`${REVIEW_CHECKPOINT_RECORD}: every pinned output needs an id and a hash.`);
    }
    const rows = await tx.select({ id: artifacts.id, hash: artifacts.hash }).from(artifacts).where(inArray(artifacts.id, wanted.map((p) => p.id as string)));
    for (const p of wanted) {
      if (rows.find((r) => r.id === p.id)?.hash !== p.hash) throw new Error(`${REVIEW_CHECKPOINT_RECORD}: output ${String(p.id)} does not match its pinned hash (fail closed).`);
    }
    return { inputs: { question, artifacts: wanted }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => ({ checkpoint: "passed", question: inputs.question, artifacts: inputs.artifacts }),
};

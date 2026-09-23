/**
 * The internal function behind `system.inspect`. `prepare` builds the explanation with
 * the Keeper's read-only explain code in the builder's transaction; `execute` returns
 * it. Its evidence is the system's own records, never research.
 *
 * R2 Stage 6: when the snapshot carries the operator's question and it maps to a supported
 * intent, the result is that intent's curated FACT / DERIVED / UNKNOWN answer
 * (`../../keeper/explainIntent.ts`) — only what the question needs — instead of the subject's
 * general explanation.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { explain, parseSubject, subjectKey } from "../../keeper/explain.js";
import { answerQuestion } from "../../keeper/explainIntent.js";
import { findKeeperAgent } from "../../definitions/lookupSeed.js";
import { SYSTEM_INSPECT_CAPABILITY } from "./capability.js";

export const SYSTEM_INSPECT_READ = "system.inspect.read";

export const systemInspectRead: InternalToolFunction = {
  capabilityName: SYSTEM_INSPECT_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const subject = parseSubject(proposedActionSnapshot.subject);
    if (!subject) throw new Error(`${SYSTEM_INSPECT_READ}: the proposed action names no valid subject.`);
    const question = typeof proposedActionSnapshot.question === "string" ? proposedActionSnapshot.question : null;
    if (question) {
      const addressee = (await findKeeperAgent(tx))?.name ?? null;
      const keeper = await answerQuestion(tx, { subject, question, addressee });
      // Only an answer that found records replaces the subject's general explanation.
      // The UI's list of other questions is not context the answer needs.
      if (keeper.intent && keeper.facts.length + keeper.derived.length > 0) return { inputs: { explanation: { ...keeper, canExplain: undefined } }, costClass: "local_retrieval", estimatedCost: 0 };
    }
    const explanation = (await explain(tx, subject)) ?? {
      subject: { type: subject.type, id: subject.id },
      headline: `No ${subjectKey(subject)} was found.`,
      status: null,
      facts: [],
      reasons: [],
      next: [],
    };
    return { inputs: { explanation }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => ({ explanation: inputs.explanation }),
};

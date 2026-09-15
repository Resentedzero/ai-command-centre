/**
 * The internal function behind `system.inspect`. `prepare` builds the explanation with
 * the Keeper's read-only explain code in the builder's transaction; `execute` returns
 * it. Its evidence is the system's own records, never research.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { explain, parseSubject, subjectKey } from "../../keeper/explain.js";
import { SYSTEM_INSPECT_CAPABILITY } from "./capability.js";

export const SYSTEM_INSPECT_READ = "system.inspect.read";

export const systemInspectRead: InternalToolFunction = {
  capabilityName: SYSTEM_INSPECT_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const subject = parseSubject(proposedActionSnapshot.subject);
    if (!subject) throw new Error(`${SYSTEM_INSPECT_READ}: the proposed action names no valid subject.`);
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

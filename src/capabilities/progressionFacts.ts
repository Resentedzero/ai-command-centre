/**
 * What each Capability's use means for progression (R2), declared here in capability code so the
 * progression projector names no capability (spec §18.3, structural invariant). Presentation and
 * evidence only: nothing here authorizes anything.
 */
import { evidenceClassOfFunction } from "./toolAdapters.js";
import { PEER_ENDORSE_CAPABILITY } from "./peerEndorse/capability.js";
import { PUBLISH_REPORT_CAPABILITY } from "./publishReport/capability.js";
import { REVIEW_CHECKPOINT_CAPABILITY } from "./reviewCheckpoint/capability.js";

/** Specialisation domains a Capability's use counts toward. `analysis` comes from a verified handoff, not a Capability. */
export type WorkDomain = "research" | "analysis" | "publishing";

/**
 * The domain a completed use of `capabilityName` counts toward, or null. Research counts only when
 * its results were real evidence: a binding whose function returns fixed test data is not research.
 */
export function domainOfCapabilityUse(capabilityName: string, bindingFunction: string | null): WorkDomain | null {
  if (capabilityName.startsWith("research.")) return evidenceClassOfFunction(bindingFunction) === "fixture" ? null : "research";
  if (capabilityName === PUBLISH_REPORT_CAPABILITY.id) return "publishing";
  return null;
}

/** The Capability whose completed uses are peer endorsements (proven again by the progression projection). */
export const ENDORSEMENT_CAPABILITY_NAME = PEER_ENDORSE_CAPABILITY.id;

/**
 * Task kinds whose Runs are attendance, not work.
 *
 * A meeting is a real operation — it convenes as a Workflow Run, each participant speaks in their own
 * Run, and all of it is recorded. But being in the room is not an outcome, so none of it earns anything:
 * not the turn (task XP), not the capability used to record the outcome, not the meeting's Workflow Run,
 * and not its Goal. Without this the Manager, which schedules meetings autonomously, could mint XP for
 * the whole Keep by calling an all-hands — model output turning directly into progression.
 *
 * The strings are literal rather than imported from `./taskPlans.js` so that reading progression never
 * loads every task-plan builder, and so the set cannot depend on module load order the way the retry
 * exclusions do. `tests/capabilities/progressionFacts.test.ts` pins them to the exported kind constants.
 */
const NOT_WORK_TASK_KINDS: ReadonlySet<string> = new Set(["meeting_contribution", "meeting_outcome"]);

/** The Task kinds above, for the one SQL filter that needs them (`../projections/agentProgression.ts`). */
export function taskKindsEarningNoProgression(): string[] {
  return [...NOT_WORK_TASK_KINDS];
}

/** Capabilities whose use earns no XP: an approval gate is not work, and endorsements are worth zero. */
export function earnsCapabilityXp(capabilityName: string): boolean {
  // Workplace coordination (reading the calendar, booking a room) is office administration, not a capability worth XP.
  return capabilityName !== REVIEW_CHECKPOINT_CAPABILITY.id && capabilityName !== PEER_ENDORSE_CAPABILITY.id && !capabilityName.startsWith("workplace.");
}

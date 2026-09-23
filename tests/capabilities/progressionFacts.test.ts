/**
 * What capability code declares about progression (R2 Stage 15).
 *
 * `taskKindsEarningNoProgression()` names its Task kinds as literal strings so that reading progression
 * never has to load every task-plan builder. That is the only reason this file exists: it pins those
 * literals to the exported constants, so renaming a kind cannot silently start paying for meetings.
 */
import { describe, expect, it } from "vitest";
import { taskKindsEarningNoProgression, earnsCapabilityXp } from "../../src/capabilities/progressionFacts.js";
import { MEETING_CONTRIBUTION_KIND, MEETING_OUTCOME_KIND } from "../../src/capabilities/taskPlans.js";

describe("the Task kinds that are attendance rather than work", () => {
  it("is exactly the two meeting kinds, by their real constants", () => {
    expect(taskKindsEarningNoProgression().sort()).toEqual([MEETING_CONTRIBUTION_KIND, MEETING_OUTCOME_KIND].sort());
  });

  it("does not exclude the Manager's own work: planning, reviewing and recovering are outcomes", () => {
    const excluded = new Set(taskKindsEarningNoProgression());
    expect(excluded.has("manager_plan")).toBe(false);
    expect(excluded.has("manager_review")).toBe(false);
    expect(excluded.has("manager_recover")).toBe(false);
    expect(excluded.has("agent_objective")).toBe(false);
  });

  it("still earns nothing for office administration, an approval gate or an endorsement", () => {
    expect(earnsCapabilityXp("workplace.schedule_meeting")).toBe(false);
    expect(earnsCapabilityXp("review.checkpoint")).toBe(false);
    expect(earnsCapabilityXp("peer.endorse")).toBe(false);
    expect(earnsCapabilityXp("research.search")).toBe(true);
  });
});

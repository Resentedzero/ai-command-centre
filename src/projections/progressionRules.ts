/**
 * Agent progression rules (R2; operator decision D2, 2026-09-16). Governance constants, kept in
 * one place so they are easy to revise. Progression is an interpretation of real work: every
 * number here is earned only from runtime facts and operator actions, and none of it is read by
 * anything that authorizes, routes, budgets or compiles context.
 */

/** XP per award rule. D2 values. The difficulty/high-value bonus is deliberately absent: no governed criterion exists. */
export const XP = {
  /** A Task Instance whose Run is a performance success sample (`runSamples.ts`). */
  task: 100,
  /** That success Run also completed at least one `research.*` Invocation. Adds to `task`. */
  research: 100,
  /** Per distinct Capability a success Run completed an Invocation of (see NO_CAPABILITY_XP). */
  capability: 50,
  /** A Workflow Run that completed, to each agent with a success sample inside it. */
  workflow: 250,
  /** A Goal (the "mission") that completed, to each agent with a success sample in its Workflow Runs. */
  mission: 500,
  /** The deliverable of a Run whose loop concluded `evidence_sufficient` (code-verified evidence). */
  validatedArtifact: 150,
} as const;

/** Operator quality verdicts and the XP the latest verdict on an artifact is worth. */
export const QUALITY_VERDICTS = ["POOR", "ACCEPTABLE", "GOOD", "EXCELLENT"] as const;
export type QualityVerdict = (typeof QUALITY_VERDICTS)[number];
export const VERDICT_XP: Record<QualityVerdict, number> = { POOR: 0, ACCEPTABLE: 50, GOOD: 150, EXCELLENT: 300 };

/**
 * Level thresholds. Each step costs 250 XP more than the last: L2 500, L3 1,250, L4 2,250,
 * L5 3,500, L6 5,000, L7 6,750, L8 8,750 … threshold(L) = 250 × (L(L+1)/2 − 1). No cap.
 * A level is progression state and presentation. It grants nothing.
 */
export const LEVEL_STEP_XP = 250;

export function levelThreshold(level: number): number {
  return level <= 1 ? 0 : LEVEL_STEP_XP * ((level * (level + 1)) / 2 - 1);
}

export function levelFor(xp: number): { level: number; xp: number; levelStartXp: number; nextLevelXp: number } {
  let level = 1;
  while (xp >= levelThreshold(level + 1)) level++;
  return { level, xp, levelStartXp: levelThreshold(level), nextLevelXp: levelThreshold(level + 1) };
}

/** Specialisation domains (declared per Capability in `../capabilities/progressionFacts.ts`; `analysis` = a verified cross-agent handoff). */
export type Domain = "research" | "analysis" | "publishing";

/** A specialisation needs this many success Runs in the domain, and at least half of the agent's domain work. */
export const SPECIALISATION_MIN_RUNS = 3;

/** Achievements: a small, deterministic set. `seasoned:<domain>` needs this many success Runs in one domain. */
export const SEASONED_MIN_RUNS = 5;
export const ACHIEVEMENTS = {
  first_success: "First successful task",
  verified_research: "First verified research result",
  handoff: "Finished on another agent's handoff",
  validated_artifact: "First validated deliverable",
  seasoned: "Seasoned in a domain",
} as const;

/** Each achievement's deterministic condition, in words (the projector implements exactly these). */
export const ACHIEVEMENT_CONDITIONS: Record<keyof typeof ACHIEVEMENTS, string> = {
  first_success: "the earliest run of this agent that counted as a performance success",
  verified_research: "the earliest run that finished evidence_sufficient with a code-verified research result",
  handoff: "the earliest run that finished evidence_sufficient on a verified handoff from another agent",
  validated_artifact: "the earliest deliverable of a run that finished evidence_sufficient",
  seasoned: `the ${SEASONED_MIN_RUNS}th successful run in one domain`,
};

/** Reputation is not a score: it shows its signals only once there is at least this much of them. */
export const REPUTATION_MIN_VERDICTS = 3;

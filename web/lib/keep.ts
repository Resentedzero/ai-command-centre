/**
 * World geometry and presentation mappings shared by every pixel screen.
 * Presentation only: nothing here decides a runtime fact. Room rectangles are
 * `assets/gamification/adapted/keep-v4-rooms.json` at 2x; the two agent
 * workshops are anonymous slots, filled by whichever Agent Definitions the API
 * returns (never by agent name).
 */

export type Rect = { x: number; y: number; w: number; h: number; wall: number };

export const KEEP = { width: 1440, height: 1024, src: "/world/keep-v4-2x.png" };

export const SYSTEM_ROOMS = {
  events: { x: 80, y: 32, w: 352, h: 256, wall: 96 },
  approvals: { x: 480, y: 32, w: 480, h: 256, wall: 96 },
  goals: { x: 1008, y: 32, w: 352, h: 256, wall: 96 },
  runtime: { x: 480, y: 336, w: 480, h: 352, wall: 96 },
  workflows: { x: 80, y: 736, w: 352, h: 256, wall: 96 },
  entrance: { x: 480, y: 736, w: 480, h: 256, wall: 96 },
  artifacts: { x: 1008, y: 736, w: 352, h: 256, wall: 96 },
} satisfies Record<string, Rect>;

export const WORKSHOP_SLOTS: Rect[] = [
  { x: 80, y: 336, w: 352, h: 352, wall: 96 },
  { x: 1008, y: 336, w: 352, h: 352, wall: 96 },
];

/** 4x close-ups of the two workshops, same slot order. */
export const WORKSHOP_CLOSEUPS = ["/world/room-researcher-workshop-4x-slate.png", "/world/room-publisher-workshop-4x.png"];

/** The floor below a room's back wall, where light and actors sit. */
export function floorOf(r: Rect): { left: number; top: number; width: number; height: number } {
  return { left: r.x, top: r.y + r.wall, width: r.w, height: r.h - r.wall };
}

export function hashOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** Preferred workshop for an Agent Definition (a hash of its id), so the Overview room and the Agents close-up agree. */
export function preferredSlot(id: string): number {
  return (hashOf(id) >>> 3) % WORKSHOP_SLOTS.length;
}

/**
 * Workshop per slot: each Agent Definition takes its preferred workshop, or the
 * other one when it is taken, in stable id order. Groups past the slot count get
 * no workshop (the screen lists them). Unbound entries (no id) get none.
 */
export function placeInWorkshops<T extends { id: string | null }>(groups: T[]): (T | undefined)[] {
  const slots: (T | undefined)[] = WORKSHOP_SLOTS.map(() => undefined);
  for (const g of groups.filter((x) => x.id).sort((a, b) => (a.id! < b.id! ? -1 : 1))) {
    const preferred = preferredSlot(g.id!);
    const slot = slots[preferred] === undefined ? preferred : slots.findIndex((x) => x === undefined);
    if (slot >= 0) slots[slot] = g;
  }
  return slots;
}

/** One agent's state from its unfinished Runs' statuses: working beats waiting beats pending. */
export function agentState(statuses: string[]): string {
  for (const s of ["active", "awaiting_approval", "pending"]) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

export type Character = "knight" | "wizard";
const CHARACTERS: Character[] = ["knight", "wizard"];

/**
 * Visual identity from the Agent Definition id, never from role or name. With
 * the Registry's definition ids, characters go out in sorted id order (cycling),
 * so the definitions that exist look distinct; without them, a hash of the id.
 * Every sprite on every screen goes through here, so an agent looks the same everywhere.
 */
export function characterFor(id: string, definitionIds?: string[] | null): Character {
  const i = definitionIds ? [...definitionIds].sort().indexOf(id) : -1;
  return CHARACTERS[(i >= 0 ? i : hashOf(id)) % CHARACTERS.length]!;
}

/** An exact decimal string without trailing zeros ("0.000000" → "0", "1.50" → "1.5"): the same value, readable at a glance. */
export function formatAmount(amount: string): string {
  return /^-?\d+\.\d+$/.test(amount) ? amount.replace(/\.?0+$/, "") : amount;
}

export type Tone = "active" | "done" | "wait" | "fail" | "idle" | "neutral";

/**
 * Colour meaning per runtime word (runtime-truth.md vocabularies). Approval
 * `pending` means waiting on a human, so callers pass `wait` for it explicitly;
 * a Task Instance `pending` is idle.
 */
export function toneFor(state: string | null | undefined): Tone {
  switch (state) {
    case "active":
    case "executing":
    case "in_progress":
      return "active";
    case "completed":
    case "approved":
      return "done";
    case "awaiting_approval":
    case "paused":
      return "wait";
    case "failed":
    case "rejected":
    case "expired":
    case "stopped":
      return "fail";
    case "pending":
    case "proposed":
      return "idle";
    default:
      return "neutral";
  }
}

/** Runtime words shown with spaces: `awaiting_approval` -> `awaiting approval`. */
export function stateWord(state: string): string {
  return state.replace(/_/g, " ");
}

const POLICY_DECISION_WORD: Record<string, string> = { ALLOW: "allowed", REQUIRE_APPROVAL: "approval required", DENY: "denied" };
const POLICY_BASIS_WORD: Record<string, string> = {
  autonomy_autonomous: "autonomous",
  autonomy_always_approve: "always approve",
  autonomy_state_unrecognized: "autonomy state not recognized",
  autonomy_conditional_rule_undecided: "conditional · rule not decided",
  no_grant: "no grant",
  permission_not_granted: "permission not granted",
  binding_below_grant_trust_bar: "binding below trust bar",
  unverified_binding_requires_approval: "unverified binding",
  conditional_performance_meets_allow_threshold: "conditional",
  conditional_performance_below_allow_threshold: "conditional · below allow threshold",
  conditional_performance_below_deny_threshold: "conditional · below deny threshold",
  conditional_insufficient_evidence: "conditional · not enough evidence",
  conditional_human_gated_action: "conditional · human-gated action",
};

/**
 * The colour of a recorded Policy decision: red for a denial; amber for an approval
 * requirement only while a human is being asked (`awaitingHuman`, the Invocation's or
 * Approval's own state), since amber means a human must act now; neutral otherwise,
 * including `allowed · conditional`.
 */
export function policyTone(record: { decision: string | null } | null | undefined, awaitingHuman: boolean): Tone {
  if (record?.decision === "DENY") return "fail";
  if (record?.decision === "REQUIRE_APPROVAL" && awaitingHuman) return "wait";
  return "neutral";
}

/**
 * The Conditional Autonomy evidence Policy recorded, as one line for a tooltip
 * (`conditional_autonomy_v1 · MID · 12 samples · success 0.9 · allow ≥ 0.8 · approval ≥ 0.6`).
 * Every value is the API's; nothing is compared here.
 */
export function policyEvidenceTitle(record: {
  conditionalRule?: { id: string | null; allowAtOrAboveSuccessRate: number | null; requireApprovalAtOrAboveSuccessRate: number | null } | null;
  performanceEvidence?: { effectiveTier: string | null; sampleCount: number | null; successRate: string | null; eligibilityReason: string | null } | null;
} | null | undefined): string | undefined {
  const rule = record?.conditionalRule;
  if (!rule) return undefined;
  const e = record?.performanceEvidence;
  return [
    rule.id,
    e ? (e.effectiveTier ?? undefined) : "performance not consulted",
    e?.sampleCount !== null && e?.sampleCount !== undefined ? `${e.sampleCount} samples` : undefined,
    e?.successRate ? `success ${e.successRate}` : undefined,
    e?.eligibilityReason ? stateWord(e.eligibilityReason) : undefined,
    rule.allowAtOrAboveSuccessRate !== null ? `allow ≥ ${rule.allowAtOrAboveSuccessRate}` : undefined,
    rule.requireApprovalAtOrAboveSuccessRate !== null ? `approval ≥ ${rule.requireApprovalAtOrAboveSuccessRate}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Policy's recorded decision as one compact line (`approval required · always approve`).
 * Words only: the decision and its basis are the API's (`PolicyDecisionRecord`), never
 * computed here. Plain text; colour stays with the status mark and the failure line.
 * `withCheckpoint` names which check it was (`at pre dispatch`), so a later check that
 * again reads "approval required" beside a completed action is not taken as outstanding.
 */
export function policyToken(
  record: { decision: string | null; basis: string | null; checkpoint?: string | null } | null | undefined,
  withCheckpoint = false
): string {
  if (!record?.decision) return "";
  const decision = POLICY_DECISION_WORD[record.decision] ?? stateWord(record.decision);
  const basis = record.basis ? (POLICY_BASIS_WORD[record.basis] ?? stateWord(record.basis)) : null;
  const words = basis ? `${decision} · ${basis}` : decision;
  return withCheckpoint && record.checkpoint ? `${words} · at ${stateWord(record.checkpoint)}` : words;
}

const TIER_SOURCE_WORD: Record<string, string> = {
  escalation_floor: "floor",
  performance_preference: "preference",
  budget_downgrade: "budget downgrade",
};

/**
 * The Router's recorded tier and which rule set it (`MID · floor`, `STRONG · preference`, `CHEAP`),
 * or what a refused route tried (`MID · refused`). Words only, from the API's `RouteRecord`.
 */
export function routeToken(
  route: { resultingTier: string | null; attemptedTier: string | null; tierSource: string | null } | null | undefined
): string {
  if (!route) return "";
  const tier = route.resultingTier ?? route.attemptedTier;
  if (!tier) return "";
  // A route recorded before the Router recorded its source must not read as a default route;
  // a source this build does not know is shown as its own word, never dropped.
  const source =
    route.tierSource === null ? "source not recorded" : route.tierSource === "default" ? undefined : (TIER_SOURCE_WORD[route.tierSource] ?? stateWord(route.tierSource));
  return [tier, source, route.resultingTier === null ? "refused" : undefined].filter(Boolean).join(" · ");
}

/**
 * The Budget Governor's recorded fallback as one tooltip line
 * (`denied at MID · tried CHEAP · context ×0.75 · input 75000 · authorized`). The API's values only.
 */
export function budgetFallbackTitle(
  fallback: { fromTier: string | null; attemptedTier: string | null; authorized: boolean | null; contextBudgetFactor: number | null; maxInputTokens: number | null } | null | undefined
): string | undefined {
  if (!fallback) return undefined;
  return [
    fallback.fromTier ? `denied at ${fallback.fromTier}` : undefined,
    fallback.attemptedTier ? `tried ${fallback.attemptedTier}` : undefined,
    fallback.contextBudgetFactor !== null ? `context ×${fallback.contextBudgetFactor}` : undefined,
    fallback.maxInputTokens !== null ? `input ${fallback.maxInputTokens}` : undefined,
    fallback.authorized === null ? undefined : fallback.authorized ? "authorized" : "denied",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Whether a performance row meets the sample criterion, as the API's gate decided it
 * (`eligible`, `eligibilityReason`); never computed from `sampleCount` here. Meeting it
 * does not mean the Router uses the row: it reads only the Run's own Agent version and
 * Task Definition, and only tiers above the default.
 */
export function eligibilityWord(row: { eligible?: boolean; eligibilityReason?: string | null; sampleCount: number; minSamples?: number | null }): string {
  if (row.eligible === undefined) return "";
  if (row.eligible) return "eligible · meets sample criterion";
  if (row.eligibilityReason === "insufficient_samples") {
    return row.minSamples ? `not enough samples · ${row.sampleCount} of ${row.minSamples}` : "not enough samples";
  }
  return row.eligibilityReason ? stateWord(row.eligibilityReason) : "not eligible";
}

/** A count from a capped list is never a total: `100+`. */
export function countLabel(n: number, cap: number): string {
  return n >= cap ? `${cap}+` : String(n);
}

/** `compact` drops the year, for narrow event lists (#57); give the full value in `title`. */
export function formatTime(iso: string | null | undefined, compact = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // Local time; the date is shown unless it is today.
  if (d.toDateString() === new Date().toDateString()) return time;
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return compact ? `${day} ${time}` : `${d.getFullYear()}-${day} ${time}`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Outlined 2x strips (make-outlined-strips.ps1). Frame counts are strip width / frame width. */
export const STRIPS = {
  knight: {
    idle: { src: "/world/strips/knight-idle-strip-2x-outlined.png", w: 68, h: 68, n: 4, ms: 500, once: false },
    run: { src: "/world/strips/knight-run-strip-2x-outlined.png", w: 132, h: 132, n: 6, ms: 100, once: false },
    death: { src: "/world/strips/knight-death-strip-2x-outlined.png", w: 68, h: 68, n: 9, ms: 100, once: true },
  },
  wizard: {
    idle: { src: "/world/strips/wizard-idle-strip-2x-outlined.png", w: 68, h: 68, n: 4, ms: 500, once: false },
    run: { src: "/world/strips/wizard-run-strip-2x-outlined.png", w: 132, h: 132, n: 6, ms: 100, once: false },
    death: { src: "/world/strips/wizard-death-strip-2x-outlined.png", w: 68, h: 68, n: 12, ms: 100, once: true },
  },
} as const;

export type Pose = keyof (typeof STRIPS)["knight"];

/** tile-pack.md state treatments. `null`: no character drawn (pending: absent). */
export function poseFor(taskStatus: string, stopped: boolean): Pose | null {
  if (stopped) return "idle";
  if (taskStatus === "active") return "run";
  if (taskStatus === "failed") return "death";
  if (taskStatus === "pending") return null;
  return "idle";
}

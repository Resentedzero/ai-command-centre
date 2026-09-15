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

/** Visual identity from the Agent Definition id (a hash), never from role or name. */
export function characterFor(id: string): Character {
  return hashOf(id) % 2 === 0 ? "knight" : "wizard";
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

/** A count from a capped list is never a total: `100+`. */
export function countLabel(n: number, cap: number): string {
  return n >= cap ? `${cap}+` : String(n);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // Local time; the date is shown unless it is today.
  return d.toDateString() === new Date().toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
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

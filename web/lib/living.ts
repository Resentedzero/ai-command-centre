/**
 * The living workplace (plan §13): where each agent is drawn and what it looks like it is doing.
 *
 * A PROJECTION OF REALITY, NOT A SECOND RUNTIME. What an agent is doing comes only from the
 * runtime's own records (`desireFor`: stopped › awaiting approval › real meeting › working › queued › idle).
 * A meeting desire exists only for a real, event-verified meeting (`GET /workplace/presence`): the
 * participants gather in its room shortly before it starts and stay there until it ends.
 * Everything else — wandering, resting, gathering, the path it walks — is presentation: seeded,
 * computed here in the browser, never persisted and never sent anywhere. This module has no I/O.
 *
 * SPACE comes from the workspace configuration (`GET /world`): active areas are walkable, work
 * areas hold workstations, common/rest/social areas host idle life, waiting areas host agents
 * waiting on an approval. Paths only cross between areas where their rectangles overlap or touch,
 * so an agent never walks through a wall the configuration does not open.
 *
 * SPREAD. Idle agents choose among every living area (common, rest, social), weighted by its size
 * and by how many others are already there or heading there (`crowd`), pause where they stand as
 * often as they walk, and start at seeded, different times — so they do not bunch in one plaza or
 * move in step. Every walk step faces its direction of travel; a desk sets the facing at work.
 */

export type Point = { x: number; y: number };
export type WorldArea = { id: string; name: string; purpose: string; x: number; y: number; w: number; h: number; active: boolean; buildingId?: string };
export type Facing = "down" | "up" | "left" | "right";
export type Workstation = { id: string; areaId: string; name: string; activity: string; x: number; y: number; active: boolean; facing?: string };
export type LivingWorld = { areas: WorldArea[]; workstations: Workstation[]; buildings?: { id: string; active: boolean }[] };

/** What the runtime says an agent is doing. The only input that can put an agent at work. */
export type Desire =
  | { kind: "idle" }
  | { kind: "work"; activity: string; runIds: string[] }
  | { kind: "wait"; runIds: string[] }
  | { kind: "queued"; runIds: string[] }
  /** Its Workflow Run is paused: held where queued work stands, never shown working. */
  | { kind: "paused"; runIds: string[] }
  | { kind: "stopped"; runIds: string[] }
  /** Assigned work whose turn has not come: an earlier step of its Workflow Run has not finished. */
  | { kind: "waiting_dependency"; detail: string }
  /** A `break` entry in its diary covers now. A break is time off, never work and never a stop. */
  | { kind: "break"; detail: string; until: string | null }
  /** Outside its working hours, or an "unavailable" diary entry. It is simply not at work. */
  | { kind: "off"; detail: string; until: string | null }
  /** A real meeting (workplace): gathering in its room before it starts, or in it. `areaName` null: the room is not on the map. */
  | { kind: "meeting"; meetingId: string; title: string; roomName: string; areaName: string | null; phase: "gathering" | "in_meeting"; endsAt: string };

/** What the character is shown doing. `working`, `waiting` and `stopped` only ever follow a matching Desire. */
export type Presence = "walking" | "standing" | "resting" | "socialising" | "working" | "waiting" | "queued" | "stopped" | "meeting" | "away";

export type AgentSim = {
  name: string;
  /** Where the character is now (the end of its current step). */
  at: Point;
  /** Waypoints still to walk, in order. */
  path: Point[];
  presence: Presence;
  /** The way the character looks: its direction of travel while walking, its desk's facing at work. */
  facing: Facing;
  /** What it is walking to or staying at, so a change of desire is noticed. */
  intent: string;
  /** When an ambient stay ends (ms). */
  until: number;
  /** When the current walking step ends (ms); the renderer glides to `at` over the step. */
  stepEnds: number;
  stepMs: number;
  speed: number;
  seed: number;
};

const MARGIN = 20;

export function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A small seeded generator (mulberry32): the same agent makes the same ambient choices. */
export function nextRandom(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  const value = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  return [value, t];
}

/** Only what is active: an area of an inactive building is gone too. */
export const active = (world: LivingWorld): LivingWorld => {
  const inactiveBuildings = new Set((world.buildings ?? []).filter((b) => !b.active).map((b) => b.id));
  const areas = world.areas.filter((a) => a.active && !(a.buildingId && inactiveBuildings.has(a.buildingId)));
  const ids = new Set(areas.map((a) => a.id));
  return { areas, workstations: world.workstations.filter((w) => w.active && ids.has(w.areaId)) };
};

export const inside = (p: Point, a: WorldArea, pad = 0) => p.x >= a.x - pad && p.x <= a.x + a.w + pad && p.y >= a.y - pad && p.y <= a.y + a.h + pad;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Where two areas join: the centre of their overlap (touching edges count), or null when they do not meet. */
function portal(a: WorldArea, b: WorldArea): Point | null {
  const x1 = Math.max(a.x, b.x) - 1;
  const y1 = Math.max(a.y, b.y) - 1;
  const x2 = Math.min(a.x + a.w, b.x + b.w) + 1;
  const y2 = Math.min(a.y + a.h, b.y + b.h) + 1;
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

/**
 * The shortest path from `from` to `to` through walkable areas, as waypoints (excluding `from`),
 * or null when `to` cannot be reached. Every area is a rectangle, so any two points inside one
 * area are joined by a straight line that stays inside it; areas connect only at their portals.
 */
export function findPath(world: LivingWorld, from: Point, to: Point): Point[] | null {
  const areas = world.areas;
  const startAreas = areas.filter((a) => inside(from, a, 2));
  const endAreas = areas.filter((a) => inside(to, a, 2));
  if (startAreas.length === 0 || endAreas.length === 0) return null;
  if (startAreas.some((a) => endAreas.includes(a))) return [to];

  type Node = { p: Point; areas: Set<WorldArea> };
  const nodes: Node[] = [{ p: from, areas: new Set(startAreas) }, { p: to, areas: new Set(endAreas) }];
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const p = portal(areas[i]!, areas[j]!);
      if (p) nodes.push({ p, areas: new Set([areas[i]!, areas[j]!]) });
    }
  }
  const shares = (a: Node, b: Node) => [...a.areas].some((x) => b.areas.has(x));
  const best = nodes.map(() => Infinity);
  const prev: (number | null)[] = nodes.map(() => null);
  const done = new Set<number>();
  best[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && best[i]! < Infinity && (u === -1 || best[i]! < best[u]!)) u = i;
    if (u === -1) return null;
    if (u === 1) break;
    done.add(u);
    for (let v = 0; v < nodes.length; v++) {
      if (done.has(v) || !shares(nodes[u]!, nodes[v]!)) continue;
      const d = best[u]! + dist(nodes[u]!.p, nodes[v]!.p);
      if (d < best[v]!) {
        best[v] = d;
        prev[v] = u;
      }
    }
  }
  const out: Point[] = [];
  for (let i: number | null = 1; i !== null && i !== 0; i = prev[i]!) out.unshift(nodes[i]!.p);
  return out;
}

/** A seeded spot inside an area, clear of its edges. */
function spotIn(area: WorldArea, seed: number): [Point, number] {
  const [rx, s1] = nextRandom(seed);
  const [ry, s2] = nextRandom(s1);
  const mx = Math.min(MARGIN, area.w / 3);
  const my = Math.min(MARGIN, area.h / 3);
  return [{ x: Math.round(area.x + mx + rx * (area.w - 2 * mx)), y: Math.round(area.y + my + ry * (area.h - 2 * my)) }, s2];
}

// ---------------------------------------------------------------------------
// Workstations: one agent per desk; sharing is shown, never hidden.
// ---------------------------------------------------------------------------

export type Placement = { station: Workstation; shared: boolean };

/**
 * Deterministic desks for the agents at work, in name order: a free desk for their activity, else a
 * free generic desk, else any free desk; with none free, they share their activity's first desk and
 * the placement says so.
 */
export function allocateWorkstations(workers: { name: string; activity: string }[], world: LivingWorld, held: Map<string, string> = new Map()): Map<string, Placement> {
  const stations = world.workstations;
  const taken = new Set<string>();
  const out = new Map<string, Placement>();
  // An agent already at (or walking to) a desk keeps it: a newcomer never evicts someone mid-run.
  for (const w of [...workers].sort((a, b) => a.name.localeCompare(b.name))) {
    const keep = stations.find((s) => s.id === held.get(w.name) && !taken.has(s.id));
    if (keep) {
      taken.add(keep.id);
      out.set(w.name, { station: keep, shared: false });
    }
  }
  let overflow = 0;
  for (const w of [...workers].sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.has(w.name)) continue;
    const free = (pred: (s: Workstation) => boolean) => stations.find((s) => !taken.has(s.id) && pred(s));
    const station = free((s) => s.activity === w.activity) ?? free((s) => s.activity === "generic") ?? free(() => true);
    if (station) {
      taken.add(station.id);
      out.set(w.name, { station, shared: false });
    } else {
      // Every desk is taken. Share, but spread: picking `find()` gave every overflow worker the SAME
      // desk object, so they all stood on one pixel. Deal them round the desks of the right kind instead.
      const candidates = stations.filter((s) => s.activity === w.activity);
      const pool = candidates.length > 0 ? candidates : stations;
      const station = pool[overflow++ % pool.length];
      if (station) out.set(w.name, { station, shared: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The simulation step. Pure: (state, desire, world, time) -> state.
// ---------------------------------------------------------------------------

const areasFor = (world: LivingWorld, purposes: string[]) => world.areas.filter((a) => purposes.includes(a.purpose));
const LIVING = ["common", "rest", "social"];

/**
 * How many agents are at or heading to each area. Counted from the intent, which names the area it is
 * for: `ambient:<purpose>:<areaId>:…` and `wait:<areaId>` / `queued:<areaId>` / `break:<areaId>` /
 * `waiting:<areaId>`. It used to count ambient intents only, so a common room already full of waiting
 * agents still read as empty and idle life walked straight into it. Pass the OTHER agents.
 */
export function crowdOf(sims: Iterable<AgentSim>): Map<string, number> {
  const out = new Map<string, number>();
  for (const sim of sims) {
    const parts = sim.intent.split(":");
    const areaId = parts[0] === "ambient" ? parts[2] : ["wait", "queued", "break", "waiting"].includes(parts[0] ?? "") ? parts[1] : undefined;
    if (areaId) out.set(areaId, (out.get(areaId) ?? 0) + 1);
  }
  return out;
}

/** A seeded choice weighted by area size, halved for every other agent already there. */
function pickArea(areas: WorldArea[], crowd: Map<string, number>, r: number, avoid?: WorldArea): WorldArea | undefined {
  const weights = areas.map((a) => (Math.sqrt(a.w * a.h) / (1 + 2 * (crowd.get(a.id) ?? 0))) * (a === avoid ? 0.35 : 1));
  const total = weights.reduce((x, y) => x + y, 0);
  let t = r * total;
  for (let i = 0; i < areas.length; i++) if ((t -= weights[i]!) <= 0) return areas[i];
  return areas.at(-1);
}

const livingPresence = (purpose: string): Presence => (purpose === "rest" ? "resting" : purpose === "social" ? "socialising" : "standing");

/** Down half the time, else a side: how an idle character stands once it has arrived. */
function restingFacing(seed: number): Facing {
  const [r] = nextRandom(seed ^ 0x9e3779b9);
  return r < 0.5 ? "down" : r < 0.75 ? "left" : "right";
}

export function facingOf(from: Point, to: Point, previous: Facing = "down"): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return previous;
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
}

/** A new character, already somewhere in a living area, staying there for a seeded while so a crowd never moves in step. */
export function spawn(name: string, world: LivingWorld, now = 0, crowd: Map<string, number> = new Map()): AgentSim {
  const seed = hash(name);
  const [r0, s0] = nextRandom(seed);
  const home = pickArea(areasFor(world, LIVING), crowd, r0) ?? areasFor(world, ["common"])[0] ?? world.areas[0];
  const [at, s1] = home ? spotIn(home, s0) : [{ x: 0, y: 0 }, s0];
  const [r, s2] = nextRandom(s1);
  const [first, next] = nextRandom(s2);
  const intent = home ? `ambient:${home.purpose}:${home.id}:spawn` : "arrive";
  return {
    name,
    at,
    path: [],
    presence: home ? livingPresence(home.purpose) : "standing",
    facing: restingFacing(seed),
    intent,
    until: now + 1_000 + Math.round(first * 14_000),
    stepEnds: 0,
    stepMs: 0,
    speed: Math.round(44 + r * 34),
    seed: next,
  };
}

/**
 * An area of one of these purposes, weighted away from the areas already busiest. Everyone waiting used
 * to be sent to `waiting[0]` and everyone queued to `common[0]`, which put the whole Keep on one tile.
 * The choice is seeded per agent and per kind, so it is stable between ticks without being uniform.
 */
function pickPlace(world: LivingWorld, purposes: string[], sim: AgentSim, crowd: Map<string, number>, kind: string): WorldArea | undefined {
  // The FIRST purpose that exists wins outright — a waiting agent belongs in a waiting area, and only
  // falls back to a common one when the world has none. Spreading happens within that purpose.
  const areas = purposes.map((p) => areasFor(world, [p])).find((list) => list.length > 0) ?? [];
  if (areas.length === 0) return undefined;
  const held = areas.find((a) => sim.intent.startsWith(`${kind}:${a.id}`));
  return held ?? pickArea(areas, crowd, hash(`${sim.name}:${kind}`) / 0xffffffff);
}

/** Stand in that area, keeping the spot already chosen so the character does not shuffle every tick. */
function placeIn(sim: AgentSim, area: WorldArea, kind: string, presence: Presence): { intent: string; point: Point; presence: Presence; seed: number } {
  const intent = `${kind}:${area.id}`;
  if (sim.intent.startsWith(intent)) return { intent: sim.intent, point: sim.path.at(-1) ?? sim.at, presence, seed: sim.seed };
  const [point] = spotIn(area, hash(`${sim.name}:${kind}`));
  return { intent, point, presence, seed: sim.seed };
}

/** Where the desire sends the agent, and what it does there. Null: stay where it is. */
function destination(sim: AgentSim, desire: Desire, world: LivingWorld, placement: Placement | undefined, now: number, crowd: Map<string, number>): { intent: string; point: Point; presence: Presence; until?: number; seed: number } | null {
  switch (desire.kind) {
    case "stopped":
      return null;
    case "work":
      return placement ? { intent: `work:${placement.station.id}`, point: { x: placement.station.x, y: placement.station.y }, presence: "working", seed: sim.seed } : null;
    case "wait": {
      const area = pickPlace(world, ["waiting", "common"], sim, crowd, "wait");
      return area ? placeIn(sim, area, "wait", "waiting") : null;
    }
    case "meeting": {
      const area = world.areas.find((a) => a.name === desire.areaName);
      if (!area) return null;
      const intent = `meeting:${desire.meetingId}:${area.id}`;
      if (sim.intent === intent) return { intent, point: sim.path.at(-1) ?? sim.at, presence: "meeting", seed: sim.seed };
      const [point] = spotIn(area, hash(`${sim.name}:${desire.meetingId}`));
      return { intent, point, presence: "meeting", seed: sim.seed };
    }
    case "waiting_dependency": {
      const area = pickPlace(world, ["waiting", "common"], sim, crowd, "waiting");
      return area ? placeIn(sim, area, "waiting", "waiting") : null;
    }
    case "break": {
      const area = pickPlace(world, ["rest", "common", "social"], sim, crowd, "break");
      return area ? placeIn(sim, area, "break", "resting") : null;
    }
    case "off":
      // Not at work: no desk, no waiting room, no pretending. The character is simply not drawn here.
      return null;
    case "paused":
    case "queued": {
      const area = pickPlace(world, ["common", "waiting"], sim, crowd, "queued");
      return area ? placeIn(sim, area, "queued", "queued") : null;
    }
    case "idle": {
      // Keep doing the current ambient thing until it is over.
      if (sim.intent.startsWith("ambient:") && (sim.path.length > 0 || now < sim.until)) return { intent: sim.intent, point: sim.path.at(-1) ?? sim.at, presence: ambientPresence(sim.intent), until: sim.until, seed: sim.seed };
      const [roll, s1] = nextRandom(sim.seed);
      const [dwell, s2] = nextRandom(s1);
      const living = areasFor(world, LIVING);
      const here = living.find((a) => inside(sim.at, a));
      // Pause where it stands (a living area it is not crowding) half the time: no tiny loops.
      if (here && roll < 0.5 && (crowd.get(here.id) ?? 0) < 3) {
        return { intent: `ambient:${here.purpose}:${here.id}:pause:${now}`, point: sim.at, presence: livingPresence(here.purpose), until: now + 8_000 + Math.round(dwell * 16_000), seed: s2 };
      }
      const [pick, s3] = nextRandom(s2);
      const area = pickArea(living, crowd, pick, here);
      if (!area) return null;
      // A spot worth walking to: at least 48 px away where the area allows it.
      let [point, seed] = spotIn(area, s3);
      for (let i = 0; i < 3 && dist(point, sim.at) < 48; i++) [point, seed] = spotIn(area, seed);
      return { intent: `ambient:${area.purpose}:${area.id}:${now}`, point, presence: livingPresence(area.purpose), until: now + 10_000 + Math.round(dwell * 20_000), seed };
    }
  }
}

/** In a meeting, a character turns toward the middle of the room: toward the others, not the wall. */
function meetingFacing(world: LivingWorld, desire: Extract<Desire, { kind: "meeting" }>, at: Point): Facing {
  const area = world.areas.find((a) => a.name === desire.areaName);
  return area ? facingOf(at, { x: area.x + area.w / 2, y: area.y + area.h / 2 }, "down") : "down";
}

export function ambientPresence(intent: string): Presence {
  return intent.startsWith("ambient:rest") ? "resting" : intent.startsWith("ambient:social") ? "socialising" : "standing";
}

/**
 * One tick for one agent. Real desires replace whatever ambient plan it had immediately (it turns
 * and walks from where it stands); ambient plans only run when the runtime says it is idle.
 */
export function step(sim: AgentSim, given: Desire, world: LivingWorld, placement: Placement | undefined, now: number, crowd: Map<string, number> = new Map()): AgentSim {
  const desire: Desire = given.kind === "paused" ? { kind: "queued", runIds: given.runIds } : given;
  if (desire.kind === "stopped") {
    // Stopped: frozen where it stands, never walking or looking busy.
    return { ...sim, path: [], presence: "stopped", intent: "stopped", stepEnds: now, stepMs: 0 };
  }
  const goal = destination(sim, desire, world, placement, now, crowd);
  let next = sim;
  if (goal && goal.intent !== sim.intent) {
    const path = findPath(world, sim.at, goal.point);
    // No walkable route (it stands somewhere that was deactivated, or the place is cut off): it appears there, never shown busy elsewhere.
    next = path
      ? { ...sim, intent: goal.intent, path, seed: goal.seed, until: goal.until ?? 0, presence: path.length > 0 ? "walking" : goal.presence }
      : { ...sim, at: goal.point, intent: goal.intent, path: [], seed: goal.seed, until: goal.until ?? 0, presence: goal.presence, stepEnds: now, stepMs: 0 };
  } else if (!goal && desire.kind !== "idle") {
    // Real work with nowhere to draw it (no desk, no waiting area): shown standing, never working or waiting.
    return { ...sim, path: [], presence: "standing", intent: `nowhere:${desire.kind}`, stepEnds: now, stepMs: 0 };
  }
  if (now < next.stepEnds) return next;
  if (next.path.length > 0) {
    const [waypoint, ...rest] = next.path;
    // Real work and approvals are hurried to (twice the stroll): short runs are still seen at their desks.
    const pace = desire.kind === "work" || desire.kind === "wait" || desire.kind === "meeting" ? 2 : 1;
    const ms = Math.max(1, Math.round((dist(next.at, waypoint!) / (next.speed * pace)) * 1000));
    return { ...next, at: waypoint!, path: rest, presence: "walking", facing: facingOf(next.at, waypoint!, next.facing), stepEnds: now + ms, stepMs: ms };
  }
  const arrived: Presence =
    desire.kind === "work"
      ? "working"
      : desire.kind === "wait" || desire.kind === "waiting_dependency"
        ? "waiting"
        : desire.kind === "queued"
          ? "queued"
          : desire.kind === "meeting"
            ? "meeting"
            : desire.kind === "break"
              ? "resting"
              : ambientPresence(next.intent);
  if (next.presence === arrived && next.stepMs === 0) return next;
  // Arriving: face the desk at work, otherwise turn to stand naturally.
  const deskFacing = placement?.station.facing;
  const facing: Facing =
    desire.kind === "work" && (deskFacing === "up" || deskFacing === "down" || deskFacing === "left" || deskFacing === "right")
      ? deskFacing
      : desire.kind === "work"
        ? "up"
        : desire.kind === "meeting"
          ? meetingFacing(world, desire, next.at)
        : next.presence === "walking"
          ? restingFacing(hash(next.intent))
          : next.facing;
  return { ...next, presence: arrived, facing, stepMs: 0 };
}

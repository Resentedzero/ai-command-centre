/**
 * The living workplace simulation (`lib/living.ts`) and runtime → activity mapping (`lib/activity.ts`):
 * idle agents live only in living spaces; real work (and only real work) sends an agent along a
 * walkable path to a suitable workstation, keeps it there while the work lasts, and brings it back;
 * waiting and stopped override working; everything is deterministic and does no I/O.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  allocateWorkstations,
  crowdOf,
  facingOf,
  findPath,
  spawn,
  step,
  type AgentSim,
  type Desire,
  type LivingWorld,
  type Point,
  type WorldArea,
} from "../lib/living";
import { ACTIVITY_RULES, activityOf, desireFor } from "../lib/activity";
import type { AgentCardData } from "../lib/api";

const area = (id: string, purpose: string, x: number, y: number, w: number, h: number): WorldArea => ({ id, name: id, purpose, x, y, w, h, active: true });

// Two rooms above a hall, a plaza with benches and a gathering spot below, and a walled-off closet.
const world: LivingWorld = {
  areas: [
    area("study", "work", 0, 0, 200, 150),
    area("lab", "work", 300, 0, 200, 150),
    area("council", "waiting", 600, 0, 200, 150),
    area("hall", "corridor", 0, 146, 800, 60),
    area("plaza", "common", 200, 202, 400, 200),
    area("benches", "rest", 220, 350, 360, 40),
    area("spot", "social", 350, 210, 100, 40),
    area("closet", "work", 900, 900, 50, 50),
  ],
  workstations: [
    { id: "desk-research", areaId: "lab", name: "Lab bench", activity: "research", x: 400, y: 100, active: true },
    { id: "desk-think", areaId: "study", name: "Study desk", activity: "think", x: 100, y: 100, active: true },
    { id: "desk-generic", areaId: "study", name: "Spare desk", activity: "generic", x: 150, y: 60, active: true },
  ],
};

const inAnyArea = (p: Point, purposes?: string[]) => world.areas.some((a) => (!purposes || purposes.includes(a.purpose)) && p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);

/** Every straight step of the path, sampled every 4 px, stays inside some walkable area. */
function assertWalkable(from: Point, waypoints: Point[]) {
  let a = from;
  for (const b of waypoints) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      expect(world.areas.some((r) => p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2)).toBe(true);
    }
    a = b;
  }
}

/** Runs one agent for `seconds` at 250 ms ticks, recording every state. */
function run(sim: AgentSim, desire: Desire | ((t: number) => Desire), seconds: number, start = 0): AgentSim[] {
  const states: AgentSim[] = [];
  let s = sim;
  for (let t = start; t <= start + seconds * 1000; t += 250) {
    const d = typeof desire === "function" ? desire(t) : desire;
    const placement = d.kind === "work" ? allocateWorkstations([{ name: s.name, activity: d.activity }], world).get(s.name) : undefined;
    s = step(s, d, world, placement, t);
    states.push(s);
  }
  return states;
}

describe("paths", () => {
  it("routes between rooms through the halls, never through walls", () => {
    const from = { x: 50, y: 50 };
    const to = { x: 700, y: 100 };
    const path = findPath(world, from, to)!;
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toEqual(to);
    assertWalkable(from, path);
    expect(findPath(world, { x: 400, y: 300 }, { x: 420, y: 320 })).toEqual([{ x: 420, y: 320 }]);
  });

  it("returns null for a place nothing connects to or outside the world", () => {
    expect(findPath(world, { x: 50, y: 50 }, { x: 920, y: 920 })).toBeNull();
    expect(findPath(world, { x: 50, y: 50 }, { x: 5000, y: 5000 })).toBeNull();
  });
});

describe("idle agents live in the living spaces", () => {
  it("wander, rest and gather only in common, rest and social areas, and never look busy", () => {
    const states = run(spawn("Scholar", world), { kind: "idle" }, 120);
    const presences = new Set(states.map((s) => s.presence));
    for (const p of ["working", "waiting", "stopped", "queued"]) expect(presences.has(p as never)).toBe(false);
    expect([...presences].some((p) => ["resting", "socialising", "standing"].includes(p))).toBe(true);
    expect(presences.has("walking")).toBe(true);
    for (const s of states.filter((x) => x.presence !== "walking")) expect(inAnyArea(s.at, ["common", "rest", "social"])).toBe(true);
    expect(states.every((s) => !inAnyArea(s.at, ["work"]) || s.presence === "walking")).toBe(true);
  });

  it("is deterministic per agent, and different agents move differently", () => {
    const a1 = run(spawn("Scholar", world), { kind: "idle" }, 60).map((s) => `${s.at.x},${s.at.y},${s.presence}`);
    const a2 = run(spawn("Scholar", world), { kind: "idle" }, 60).map((s) => `${s.at.x},${s.at.y},${s.presence}`);
    const b = run(spawn("Analyst", world), { kind: "idle" }, 60).map((s) => `${s.at.x},${s.at.y},${s.presence}`);
    expect(a1).toEqual(a2);
    expect(b).not.toEqual(a1);
    expect(spawn("Scholar", world).speed).not.toBe(spawn("Analyst", world).speed);
  });
});

describe("a crowd of idle agents spreads out", () => {
  // Eight agents stepped together for 120 s, each seeing where the others are, as LivingAgents does.
  function crowdRun(seconds: number) {
    const names = ["Scholar", "Analyst", "Publisher", "Keeper", "Scout", "Scribe", "Warden", "Herald"];
    let sims = new Map<string, AgentSim>();
    const samples: AgentSim[][] = [];
    for (let t = 0; t <= seconds * 1000; t += 250) {
      const next = new Map<string, AgentSim>();
      for (const name of names) {
        const crowd = crowdOf([...next.values(), ...[...sims].filter(([n]) => !next.has(n) && n !== name).map(([, s]) => s)]);
        const current = sims.get(name) ?? spawn(name, world, t, crowd);
        next.set(name, step(current, { kind: "idle" }, world, undefined, t, crowd));
      }
      sims = next;
      samples.push([...sims.values()]);
    }
    return samples;
  }

  it("uses every living area, never piles more than half the standing agents into one, and does not move in step", () => {
    const samples = crowdRun(120);
    const byArea = new Map<string, number>();
    let still = 0;
    for (const sample of samples)
      for (const sim of sample) {
        if (sim.presence === "walking") continue;
        still++;
        const id = sim.intent.split(":")[2]!;
        byArea.set(id, (byArea.get(id) ?? 0) + 1);
      }
    expect([...byArea.keys()].sort()).toEqual(["benches", "plaza", "spot"]);
    for (const n of byArea.values()) expect(n / still).toBeLessThan(0.5);
    // First moves happen at different times.
    const firstMove = ["Scholar", "Analyst", "Publisher", "Keeper", "Scout", "Scribe", "Warden", "Herald"].map((name) =>
      samples.findIndex((sample) => sample.find((s) => s.name === name)!.presence === "walking")
    );
    expect(new Set(firstMove).size).toBeGreaterThanOrEqual(6);
  });

  it("faces the way it walks, and a walking step takes longer the farther it goes", () => {
    expect(facingOf({ x: 0, y: 0 }, { x: -10, y: 2 })).toBe("left");
    expect(facingOf({ x: 0, y: 0 }, { x: 10, y: -2 })).toBe("right");
    expect(facingOf({ x: 0, y: 0 }, { x: 1, y: -20 })).toBe("up");
    expect(facingOf({ x: 0, y: 0 }, { x: 0, y: 0 }, "left")).toBe("left");
    const walks = crowdRun(60).flat().filter((s) => s.presence === "walking" && s.stepMs > 0);
    expect(walks.length).toBeGreaterThan(0);
    for (const s of walks.slice(0, 50)) expect(["down", "up", "left", "right"]).toContain(s.facing);
  });

  it("faces its desk at work", () => {
    const desks = { ...world, workstations: world.workstations.map((w) => ({ ...w, facing: "left" })) };
    let s = spawn("Scholar", desks);
    const work: Desire = { kind: "work", activity: "research", runIds: ["r1"] };
    for (let t = 0; t < 60_000 && s.presence !== "working"; t += 250) s = step(s, work, desks, allocateWorkstations([{ name: "Scholar", activity: "research" }], desks).get("Scholar"), t);
    expect(s.presence).toBe("working");
    expect(s.facing).toBe("left");
  });
});

describe("real work overrides ambient life", () => {
  it("walks to a matching workstation, stays working while the run is active, then walks back to the living space", () => {
    const work: Desire = { kind: "work", activity: "research", runIds: ["r1"] };
    const timeline = (t: number): Desire => (t >= 10_000 && t < 60_000 ? work : { kind: "idle" });
    const states = run(spawn("Scholar", world), timeline, 120);
    const during = states.slice(40, 240); // 10 s .. 60 s
    const firstWalk = during.findIndex((s) => s.presence === "walking");
    expect(firstWalk).toBe(0); // it leaves at once, it does not switch pose in place
    const arrived = during.findIndex((s) => s.presence === "working");
    expect(arrived).toBeGreaterThan(0);
    for (const s of during.slice(arrived)) expect(s).toMatchObject({ presence: "working", at: { x: 400, y: 100 } });
    let prev = states[39]!.at;
    for (const s of during.slice(0, arrived + 1)) {
      assertWalkable(prev, [s.at]);
      prev = s.at;
    }
    // Before real work, and after it, it is never shown working.
    expect(states.slice(0, 40).some((s) => s.presence === "working")).toBe(false);
    const after = states.slice(241);
    expect(after.some((s) => s.presence === "working")).toBe(false);
    expect(after[0]!.presence).toBe("walking");
    expect(inAnyArea(after.at(-1)!.at, ["common", "rest", "social"])).toBe(true);
  });

  it("waits in the waiting area while awaiting approval, and is frozen where it stands when stopped", () => {
    const waiting = run(spawn("Scholar", world), { kind: "wait", runIds: ["r1"] }, 40);
    expect(waiting.at(-1)!.presence).toBe("waiting");
    expect(inAnyArea(waiting.at(-1)!.at, ["waiting"])).toBe(true);
    expect(waiting.some((s) => s.presence === "working")).toBe(false);

    const working = run(spawn("Scholar", world), { kind: "work", activity: "think", runIds: ["r1"] }, 30).at(-1)!;
    const stopped = run(working, { kind: "stopped", runIds: ["r1"] }, 20, 31_000);
    expect(stopped.every((s) => s.presence === "stopped" && s.at.x === working.at.x && s.at.y === working.at.y && s.path.length === 0)).toBe(true);
  });

  it("a break rests in a rest area; time off the clock draws the agent nowhere at all", () => {
    const onBreak = run(spawn("Scholar", world), { kind: "break", detail: "On a break (tea).", until: null }, 40);
    expect(onBreak.at(-1)!.presence).toBe("resting");
    expect(inAnyArea(onBreak.at(-1)!.at, ["rest"])).toBe(true);
    // A break is time off: it is never drawn as work, and it never touches a desk.
    expect(onBreak.some((s) => s.presence === "working")).toBe(false);

    // Off the clock: no desk, no waiting room, no pretending to be somewhere.
    const before = spawn("Scholar", world);
    const off = run(before, { kind: "off", detail: "Outside its working hours.", until: null }, 20);
    expect(off.every((st) => st.at.x === before.at.x && st.at.y === before.at.y)).toBe(true);
    expect(off.some((st) => st.presence === "working")).toBe(false);
  });

  it("waiting for a dependency waits, and is never drawn as work", () => {
    const waiting = run(spawn("Scholar", world), { kind: "waiting_dependency", detail: "Assigned work whose turn has not come." }, 40);
    expect(waiting.at(-1)!.presence).toBe("waiting");
    expect(inAnyArea(waiting.at(-1)!.at, ["waiting"])).toBe(true);
    expect(waiting.some((st) => st.presence === "working")).toBe(false);
  });

  it("overflow workers share desks without standing on the same pixel", () => {
    // Four thinkers, one thinking desk: the three that overflow must not all be handed the same desk.
    const placed = allocateWorkstations(
      [
        { name: "Ann", activity: "think" },
        { name: "Bea", activity: "think" },
        { name: "Cal", activity: "think" },
        { name: "Dai", activity: "think" },
      ],
      { ...world, workstations: world.workstations.filter((w) => w.activity === "think") },
      new Map()
    );
    const shared = [...placed.values()].filter((p) => p.shared);
    expect(shared.length).toBeGreaterThan(0);
    // Where the world offers more than one desk of the kind, overflow is dealt round them.
    const thinkDesks = world.workstations.filter((w) => w.activity === "think").length;
    if (thinkDesks > 1) expect(new Set(shared.map((p) => p.station.id)).size).toBeGreaterThan(1);
  });

  it("counts waiting and queued agents when judging how busy an area is", () => {
    const sims = [
      { ...spawn("A", world), intent: "wait:council" },
      { ...spawn("B", world), intent: "queued:plaza" },
      { ...spawn("C", world), intent: "ambient:common:plaza:1" },
      { ...spawn("D", world), intent: "break:benches" },
    ];
    const crowd = crowdOf(sims);
    // Before this, only the ambient agent counted and a room full of waiting agents read as empty.
    expect(crowd.get("council")).toBe(1);
    expect(crowd.get("plaza")).toBe(2);
    expect(crowd.get("benches")).toBe(1);
  });

  it("gives each working agent its own desk, preferring the activity, then generic, and says when desks are shared", () => {
    const placed = allocateWorkstations(
      [
        { name: "Zed", activity: "think" },
        { name: "Amy", activity: "think" },
        { name: "Bob", activity: "research" },
        { name: "Cat", activity: "think" },
      ],
      world
    );
    expect(placed.get("Amy")).toMatchObject({ station: { id: "desk-think" }, shared: false });
    expect(placed.get("Bob")).toMatchObject({ station: { id: "desk-research" }, shared: false });
    expect(placed.get("Cat")).toMatchObject({ station: { id: "desk-generic" }, shared: false });
    expect(placed.get("Zed")).toMatchObject({ station: { id: "desk-think" }, shared: true });
    expect(allocateWorkstations([{ name: "Solo", activity: "writing" }], world).get("Solo")!.station.id).toBe("desk-generic");
  });
});

describe("review fixes", () => {
  it("an agent whose run ends is never left labelled working while it drifts back to ambient life", () => {
    let s = run(spawn("Scholar", world), { kind: "work", activity: "think", runIds: ["r1"] }, 30).at(-1)!;
    expect(s.presence).toBe("working");
    for (let t = 31_000; t < 60_000; t += 250) {
      s = step(s, { kind: "idle" }, world, undefined, t);
      expect(s.presence).not.toBe("working");
      expect(s.presence).not.toBe("waiting");
    }
  });

  it("with no walkable route it appears at its destination instead of being shown busy where it stands", () => {
    const stranded: AgentSim = { ...spawn("Scholar", world), at: { x: 925, y: 925 } }; // in the closed-off closet
    const s = step(stranded, { kind: "work", activity: "research", runIds: ["r1"] }, world, allocateWorkstations([{ name: "Scholar", activity: "research" }], world).get("Scholar"), 0);
    expect(s).toMatchObject({ at: { x: 400, y: 100 }, presence: "working", path: [] });
    const nowhere = step(spawn("Scholar", world), { kind: "work", activity: "research", runIds: ["r1"] }, world, undefined, 0);
    expect(nowhere.presence).toBe("standing");
  });

  it("a desk already held is kept when another agent starts the same kind of work", () => {
    const first = allocateWorkstations([{ name: "Zed", activity: "research" }], world);
    expect(first.get("Zed")!.station.id).toBe("desk-research");
    const both = allocateWorkstations([{ name: "Zed", activity: "research" }, { name: "Amy", activity: "research" }], world, new Map([["Zed", "desk-research"]]));
    expect(both.get("Zed")!.station.id).toBe("desk-research");
    expect(both.get("Amy")!.station.id).not.toBe("desk-research");
  });

  it("areas of an inactive building are not walkable", async () => {
    const { active } = await import("../lib/living");
    const withBuilding: LivingWorld = { ...world, areas: world.areas.map((a) => ({ ...a, buildingId: a.id === "lab" ? "annex" : "main" })), buildings: [{ id: "main", active: true }, { id: "annex", active: false }] };
    const live = active(withBuilding);
    expect(live.areas.map((a) => a.id)).not.toContain("lab");
    expect(live.workstations.map((w) => w.id)).not.toContain("desk-research");
  });
});

describe("runtime → activity and desire", () => {
  const row = (over: Partial<AgentCardData>): AgentCardData => ({ agentDefinitionId: "d1", agentName: "Keeper", runId: "r1", taskInstanceId: "t1", taskStatus: "active", taskDefinitionName: null, goalTitle: null, latestActivitySummary: null, activity: null, ...over });

  it("maps what the run is doing to a workstation activity from one rule table", () => {
    expect(activityOf({ invocationKind: "tool", invocationStatus: "executing", capability: "research.search", intent: null }).activity).toBe("research");
    expect(activityOf({ invocationKind: "llm", invocationStatus: "executing", capability: "research.web", intent: "extract" }).activity).toBe("research");
    expect(activityOf({ invocationKind: "tool", invocationStatus: "executing", capability: "publish.report", intent: null }).activity).toBe("publishing");
    expect(activityOf({ invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "analyse" }).activity).toBe("analysis");
    expect(activityOf({ invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write" }).activity).toBe("writing");
    expect(activityOf({ invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "decide" }).activity).toBe("think");
    expect(activityOf({ invocationKind: "tool", invocationStatus: "completed", capability: "docs.retrieve", intent: null }).activity).toBe("generic");
    expect(activityOf(null).activity).toBe("generic");
    expect(ACTIVITY_RULES.at(-1)!.activity).toBe("generic");
  });

  it("takes the agent's state only from its unfinished runs and engaged stops: stopped › waiting › working › queued › idle", () => {
    const keeperThink = row({ activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write", taskKind: "keeper_answer" } });
    expect(desireFor([], [], ["d1"])).toEqual({ kind: "idle" });
    expect(desireFor([keeperThink], [], ["d1"])).toEqual({ kind: "work", activity: "think", runIds: ["r1"] });
    const otherWriting = row({ activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write", taskKind: "agent_objective" } });
    expect(desireFor([otherWriting], [], ["d1"])).toEqual({ kind: "work", activity: "writing", runIds: ["r1"] });
    expect(desireFor([row({ taskStatus: "pending" })], [], ["d1"])).toEqual({ kind: "queued", runIds: ["r1"] });
    expect(desireFor([keeperThink, row({ runId: "r2", taskStatus: "awaiting_approval" })], [], ["d1"])).toEqual({ kind: "wait", runIds: ["r2"] });
    expect(desireFor([keeperThink], [{ id: "s", scope: "agent_definition", scopeRefId: "D1", reason: null }], ["d1"]).kind).toBe("stopped");
    expect(desireFor([keeperThink], [{ id: "s", scope: "run", scopeRefId: "r1", reason: null }], ["d1"]).kind).toBe("stopped");
    expect(desireFor([keeperThink], [{ id: "s", scope: "agent_definition", scopeRefId: "other", reason: null }], ["d1"]).kind).toBe("work");
    // A stop on one of two runs stops only that run; stops at workflow-run and goal scope are matched per run.
    expect(desireFor([keeperThink, row({ runId: "r2" })], [{ id: "s", scope: "run", scopeRefId: "r1", reason: null }], ["d1"])).toEqual({ kind: "work", activity: "generic", runIds: ["r2"] });
    expect(desireFor([row({ workflowRunId: "wr9" })], [{ id: "s", scope: "workflow_run", scopeRefId: "WR9", reason: null }], ["d1"]).kind).toBe("stopped");
    expect(desireFor([row({ goalId: "g9" })], [{ id: "s", scope: "goal", scopeRefId: "g9", reason: null }], ["d1"]).kind).toBe("stopped");
    expect(desireFor([], [{ id: "s", scope: "global", scopeRefId: null, reason: null }], ["d1"]).kind).toBe("stopped");
  });
});

describe("truthfulness", () => {
  it("the simulation and the activity mapping make no requests and import nothing that writes", () => {
    for (const file of ["lib/living.ts", "lib/activity.ts"]) {
      const source = readFileSync(path.resolve(file), "utf8");
      expect(source).not.toMatch(/\bfetch\(|apiFetch|localStorage|sessionStorage|XMLHttpRequest|WebSocket/);
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)";/gm)];
      for (const m of imports) expect(m[1] === "type " || m[2] === "./living" || m[2] === "./api").toBe(true);
      expect(imports.filter((m) => m[2] === "./api").every((m) => m[1] === "type ")).toBe(true);
    }
  });
});

describe("hurrying to real work", () => {
  it("walks to a desk twice as fast as it strolls", () => {
    const sim = { ...spawn("Scholar", world), at: { x: 400, y: 300 }, path: [], intent: "ambient:common:plaza:x", until: 0 };
    const target = { x: 500, y: 300 };
    const stroll = step({ ...sim, path: [target] }, { kind: "idle" }, world, undefined, 1);
    const hurry = step({ ...sim, intent: "work:desk-research", path: [target] }, { kind: "work", activity: "research", runIds: ["r"] }, world, allocateWorkstations([{ name: "Scholar", activity: "research" }], world).get("Scholar"), 1);
    expect(hurry.stepMs).toBeLessThan(stroll.stepMs * 0.6);
  });
});

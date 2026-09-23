/**
 * World templates (plan §13–14): starting configurations for the physical Command Centre, all over
 * the same keep art (`keep-v4-2x.png`, 1440 × 1024) — they differ in how its rooms are used, never
 * in what the art shows. Coordinates are world pixels at 2×, matching
 * `assets/gamification/adapted/keep-v4-rooms.json` (a room's floor starts below its 96 px back wall).
 * A template is a starting point: the operator edits the result in Settings → World. Space only:
 * nothing here grants, routes, budgets or scores anything.
 */
import type { AreaPurpose, Facing, WorkstationActivity } from "./worldConfig.js";

type Rect = { x: number; y: number; w: number; h: number };
type Station = { name: string; activity: WorkstationActivity; x: number; y: number; facing?: Facing };
type Area = { name: string; purpose: AreaPurpose; rect: Rect; workstations?: Station[] };
export type WorldTemplate = { id: string; name: string; description: string; width: number; height: number; buildings: { name: string; rect: Rect; areas: Area[] }[] };

const KEEP_RECT: Rect = { x: 64, y: 24, w: 1312, h: 976 };

/** The stone halls: walkable everywhere, a place for a short stroll. They overlap the floors they touch so paths join up. */
const HALLS: Area[] = [
  { name: "North hall", purpose: "corridor", rect: { x: 80, y: 284, w: 1280, h: 56 } },
  { name: "South hall", purpose: "corridor", rect: { x: 80, y: 684, w: 1280, h: 56 } },
  { name: "West hall", purpose: "corridor", rect: { x: 428, y: 124, w: 56, h: 872 } },
  { name: "East hall", purpose: "corridor", rect: { x: 956, y: 124, w: 56, h: 872 } },
];

const FLOORS = {
  library: { x: 80, y: 128, w: 352, h: 160 },
  council: { x: 480, y: 128, w: 480, h: 160 },
  mapRoom: { x: 1008, y: 128, w: 352, h: 160 },
  westWorkshop: { x: 80, y: 432, w: 352, h: 256 },
  runtime: { x: 480, y: 432, w: 480, h: 256 },
  eastWorkshop: { x: 1008, y: 432, w: 352, h: 256 },
  forge: { x: 80, y: 832, w: 352, h: 160 },
  plaza: { x: 480, y: 832, w: 480, h: 160 },
  vault: { x: 1008, y: 832, w: 352, h: 160 },
};

const keep = (id: string, name: string, description: string, areas: Area[]): WorldTemplate => ({
  id,
  name,
  description,
  width: 1440,
  height: 1024,
  buildings: [{ name: "The Keep", rect: KEEP_RECT, areas: [...HALLS, ...areas] }],
});

export const WORLD_TEMPLATES: WorldTemplate[] = [
  keep("keep", "The Keep", "Balanced: every room in use, with a plaza, benches, a reading nook, the council tables and a map-room lounge to live in.", [
    {
      name: "Library",
      purpose: "work",
      rect: FLOORS.library,
      workstations: [
        { name: "Reading desk (west)", activity: "research", x: 196, y: 276 },
        { name: "Reading desk (east)", activity: "research", x: 316, y: 276 },
      ],
    },
    { name: "Reading nook", purpose: "rest", rect: { x: 170, y: 140, w: 170, h: 56 } },
    { name: "Council hall", purpose: "waiting", rect: FLOORS.council },
    { name: "Council tables", purpose: "social", rect: { x: 560, y: 236, w: 320, h: 48 } },
    { name: "Map room", purpose: "work", rect: FLOORS.mapRoom, workstations: [{ name: "Map table", activity: "think", x: 1180, y: 276 }] },
    { name: "Map-room lounge", purpose: "rest", rect: { x: 1030, y: 140, w: 300, h: 50 } },
    {
      name: "West workshop",
      purpose: "work",
      rect: FLOORS.westWorkshop,
      workstations: [
        { name: "Drafting bench", activity: "analysis", x: 220, y: 552 },
        { name: "Tool bench", activity: "analysis", x: 330, y: 672 },
      ],
    },
    {
      name: "Runtime room",
      purpose: "work",
      rect: FLOORS.runtime,
      workstations: [
        { name: "Console (west)", activity: "think", x: 545, y: 580 },
        { name: "Console (east)", activity: "think", x: 895, y: 580 },
      ],
    },
    {
      name: "East workshop",
      purpose: "work",
      rect: FLOORS.eastWorkshop,
      workstations: [
        { name: "Writing desk", activity: "writing", x: 1150, y: 620 },
        { name: "Press", activity: "publishing", x: 1070, y: 676 },
      ],
    },
    { name: "Forge", purpose: "work", rect: FLOORS.forge, workstations: [{ name: "Forge bench", activity: "generic", x: 345, y: 976 }] },
    { name: "Entrance plaza", purpose: "common", rect: FLOORS.plaza },
    { name: "Benches", purpose: "rest", rect: { x: 540, y: 930, w: 360, h: 56 } },
    { name: "Gathering spot", purpose: "social", rect: { x: 640, y: 840, w: 160, h: 64 } },
    { name: "Vault", purpose: "other", rect: FLOORS.vault },
  ]),
  keep("scholars", "Scholars' Keep", "Research first: more reading and thinking desks, the council hall as a common room, and quiet corners to rest in.", [
    {
      name: "Library",
      purpose: "work",
      rect: FLOORS.library,
      workstations: [
        { name: "Reading desk (west)", activity: "research", x: 196, y: 276 },
        { name: "Reading desk (east)", activity: "research", x: 316, y: 276 },
        { name: "Stacks desk", activity: "research", x: 116, y: 262 },
      ],
    },
    { name: "Council common room", purpose: "common", rect: FLOORS.council },
    { name: "Approval seal", purpose: "waiting", rect: { x: 640, y: 196, w: 160, h: 60 } },
    { name: "Map room", purpose: "work", rect: FLOORS.mapRoom, workstations: [{ name: "Map table", activity: "think", x: 1180, y: 276 }, { name: "Chart desk", activity: "analysis", x: 1110, y: 262 }] },
    {
      name: "West workshop",
      purpose: "work",
      rect: FLOORS.westWorkshop,
      workstations: [
        { name: "Drafting bench", activity: "analysis", x: 220, y: 552 },
        { name: "Tool bench", activity: "research", x: 330, y: 672 },
      ],
    },
    {
      name: "Runtime room",
      purpose: "work",
      rect: FLOORS.runtime,
      workstations: [
        { name: "Console (west)", activity: "think", x: 545, y: 580 },
        { name: "Console (east)", activity: "think", x: 895, y: 580 },
      ],
    },
    { name: "East workshop", purpose: "work", rect: FLOORS.eastWorkshop, workstations: [{ name: "Writing desk", activity: "writing", x: 1150, y: 620 }, { name: "Press", activity: "publishing", x: 1070, y: 676 }] },
    { name: "Quiet forge corner", purpose: "rest", rect: { x: 200, y: 860, w: 220, h: 60 } },
    { name: "Forge", purpose: "work", rect: FLOORS.forge, workstations: [{ name: "Forge bench", activity: "generic", x: 345, y: 976 }] },
    { name: "Entrance plaza", purpose: "social", rect: FLOORS.plaza },
    { name: "Benches", purpose: "rest", rect: { x: 540, y: 930, w: 360, h: 56 } },
    { name: "Vault", purpose: "other", rect: FLOORS.vault },
  ]),
  keep("garrison", "Garrison", "Compact headquarters: desks in every room for a larger team, living kept to the plaza, its benches and the halls.", [
    {
      name: "Library",
      purpose: "work",
      rect: FLOORS.library,
      workstations: [
        { name: "Reading desk (west)", activity: "research", x: 196, y: 276 },
        { name: "Reading desk (east)", activity: "research", x: 316, y: 276 },
      ],
    },
    { name: "Council hall", purpose: "waiting", rect: FLOORS.council },
    { name: "Map room", purpose: "work", rect: FLOORS.mapRoom, workstations: [{ name: "Map table", activity: "think", x: 1180, y: 276 }, { name: "Briefing desk", activity: "generic", x: 1100, y: 262 }] },
    {
      name: "West workshop",
      purpose: "work",
      rect: FLOORS.westWorkshop,
      workstations: [
        { name: "Drafting bench", activity: "analysis", x: 220, y: 552 },
        { name: "Tool bench", activity: "analysis", x: 330, y: 672 },
        { name: "Workbench", activity: "generic", x: 120, y: 672 },
      ],
    },
    {
      name: "Runtime room",
      purpose: "work",
      rect: FLOORS.runtime,
      workstations: [
        { name: "Console (west)", activity: "think", x: 545, y: 580 },
        { name: "Console (east)", activity: "think", x: 895, y: 580 },
        { name: "Core desk", activity: "analysis", x: 720, y: 676 },
      ],
    },
    {
      name: "East workshop",
      purpose: "work",
      rect: FLOORS.eastWorkshop,
      workstations: [
        { name: "Writing desk", activity: "writing", x: 1150, y: 620 },
        { name: "Press", activity: "publishing", x: 1070, y: 676 },
        { name: "Copy desk", activity: "writing", x: 1300, y: 676 },
      ],
    },
    { name: "Forge", purpose: "work", rect: FLOORS.forge, workstations: [{ name: "Forge bench", activity: "generic", x: 345, y: 976 }, { name: "Anvil", activity: "generic", x: 240, y: 976 }] },
    { name: "Entrance plaza", purpose: "common", rect: FLOORS.plaza },
    { name: "Benches", purpose: "rest", rect: { x: 540, y: 930, w: 360, h: 56 } },
    { name: "Vault", purpose: "other", rect: FLOORS.vault },
  ]),
];

export const DEFAULT_WORLD = WORLD_TEMPLATES[0]!;

/** A template as unsaved rows (ids `default-…`), for drawing and previewing before the operator creates a world. */
export function defaultWorldPreview(template: WorldTemplate = DEFAULT_WORLD) {
  const buildings: { id: string; name: string; x: number; y: number; w: number; h: number; active: boolean }[] = [];
  const areas: { id: string; buildingId: string; name: string; purpose: string; x: number; y: number; w: number; h: number; active: boolean }[] = [];
  const workstations: { id: string; areaId: string; name: string; activity: string; x: number; y: number; facing: string; active: boolean }[] = [];
  template.buildings.forEach((b, i) => {
    const buildingId = `default-building-${i}`;
    buildings.push({ id: buildingId, name: b.name, ...b.rect, active: true });
    b.areas.forEach((a, j) => {
      const areaId = `${buildingId}-area-${j}`;
      areas.push({ id: areaId, buildingId, name: a.name, purpose: a.purpose, ...a.rect, active: true });
      (a.workstations ?? []).forEach((w, k) => workstations.push({ id: `${areaId}-station-${k}`, areaId, ...w, facing: w.facing ?? "up", active: true }));
    });
  });
  return { buildings, areas, workstations };
}

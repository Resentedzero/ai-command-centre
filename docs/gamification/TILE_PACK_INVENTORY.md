# Tile Pack Inventory

Status: **Analysis only.** No runtime code, schema, UI components, or asset loader
were created or modified as part of this inventory. Nothing in this document
authorizes building the gamification system — Phase 16/18.1 of the frozen spec
still applies (`agent_xp_projection` and any presentation layer over it remain
unbuilt until a real MVP need exists).

## Source

- Location: `assets/gamification/Tile Pack/Pixel Crawler - Free Pack/`
- Delivered as an already-unpacked directory (no archive present or inspected).
- Pack name (from directory name): **"Pixel Crawler - Free Pack"**.
- Author, per `Terms.txt` (the only text/license file in the pack): **Anokolisa**
  (contact `AnomalyPixel@gmail.com`, Patreon/Twitter `@Anokolisa`).
- Total files: **338** — 169 `.png` (rasterized, usable as-is), 168 `.aseprite`
  (Aseprite editor source files — not directly usable in a browser), 1 `Terms.txt`.

## Directory Structure

```
Tile Pack/Pixel Crawler - Free Pack/
├── Entities/
│   ├── Characters/Body_A/Animations/   (a single base humanoid body, 14 action states × 3 facing directions)
│   ├── Mobs/                           (Orc Crew ×4 variants, Skeleton Crew ×4 variants)
│   └── Npc's/                          (Knight, Rogue, Wizzard — each with Death/Idle/Run)
├── Environment/
│   ├── Props/Animated/                 (cooking-pan animation, 5 variants)
│   ├── Props/Static/                   (Trees ×3 models, Vegetation, Furniture)
│   ├── Structures/Buildings/           (Floors, Props, Roofs, Shadows, Walls — building-kit sheets)
│   ├── Structures/Stations/            (Alchemy, Anvil, Bonfire, Cooking Station, Furnace, Sawmill, Workbench — animated crafting props)
│   └── Tilesets/                       (Cave [WIP], Dungeon, Floors, Wall, Water)
├── Icons/                              (single unexported Aseprite file, see below)
├── Weapons/                            (Bone, Hands, Wood — small prop sheets)
└── Terms.txt
```

Every file pairs as `<name>.aseprite` (editable source) + `<name>-Sheet.png` or
`<name>.png` (exported sprite sheet), with two notable exceptions where only the
source exists (`Icons/Resources.aseprite`, `Environment/Tilesets/Water.aseprite`)
— see Uncertainties.

## Asset Summary

| Category | Files (aseprite+png pairs, approx.) | Nature |
|---|---|---|
| Character animations (`Entities/Characters`) | 84 | One base body, 14 action states × 3 directions |
| Mobs (`Entities/Mobs`) | 48 | 8 creature variants (Orc/Skeleton ×4 each) × 3 states |
| NPCs (`Entities/Npc's`) | 18 | 3 humanoid NPCs × 3 states (Death/Idle/Run) |
| Tilesets (`Environment/Tilesets`) | 11 | 5 tile atlases (dungeon, cave, floor, wall, water) |
| Buildings (`Environment/Structures/Buildings`) | 10 | 5 building-kit layer sheets (Floors/Props/Roofs/Shadows/Walls) |
| Crafting stations (`Environment/Structures/Stations`) | ~34 | 7 station types, multiple numbered variants each, all animated |
| Props (`Environment/Props`) | ~44 | Animated pans (5), static trees (3 models × sizes), Vegetation, Furniture |
| Weapons (`Weapons`) | 6 | 3 small prop sheets (Bone, Hands, Wood) |
| Icons (`Icons`) | 1 (source-only) | Unexported 16×16-grid resource-icon sheet |

## Asset Categories

Grouped by what they visually are, not by folder name (verified by opening
representative sheets, not inferred from filenames alone):

- **Character/creature sprite sheets** (Characters, Mobs, NPCs): all top-down,
  16px-grid pixel art, multi-frame animation strips (walk/run/idle/death/attack
  cycles). Confirmed by direct inspection: `Idle_Down-Sheet.png` is a 4-frame
  idle loop of an unclothed base body; the Knight NPC's `Idle-Sheet.png` is a
  3-frame idle loop of an armored humanoid with a distinct silhouette from the
  base body/mobs.
- **Tile atlases** (Tilesets): non-animated, single-image sprite atlases mixing
  many small elements (walls, floor tiles, doors, decorative rune/portal
  circles in red/blue/green, banners) on one sheet — not organized as a clean
  grid of same-size cells; individual tiles would need manual slicing.
- **Animated decorative props/structures** (Stations, Animated Props): large
  multi-frame sprite sheets of a single animated object (e.g. `Anvil_03-Sheet.png`
  is ~44 frames of a hammering-anvil loop). These are scene decoration, not UI
  elements — confirmed by direct inspection, not filename guesswork.
- **Static props/scenery** (Trees, Vegetation, Furniture, Buildings): single or
  few-frame environment art, no UI relevance.
- **Weapons**: small equip-able item sprites (a bone club, a pair of fists, a
  wood weapon) — no UI relevance.
- **Icons**: exactly one file, `Icons/Resources.aseprite` — a 400×400 canvas on
  a 16×16 grid (per its own embedded metadata), consistent with a sheet of small
  resource-style icons (coins/gems/potions, typical of this asset line's naming),
  but **it has no exported PNG anywhere in the pack** — its actual icon contents
  were not visually verified, only its container metadata.

No tiles/panels/buttons/status-indicator/progress-bar/badge/achievement/
inventory-slot/map assets were found anywhere in the pack — these categories,
explicitly asked about, are simply **absent**.

## Technical Properties

- **Format**: PNG, RGBA (alpha/transparency confirmed present on every sampled
  file), 8-bit/color, non-interlaced. Aseprite sources are Aseprite's native
  binary format (not directly usable by a browser/bundler).
- **Base grid**: every one of the 168 `.aseprite` files reports **grid size
  16×16** in its own embedded metadata — this is a consistent 16px pixel-art
  unit across the entire pack, even though exported canvas/frame sizes vary
  (characters are typically 4×4 or 2×2 grid cells).
- **Representative dimensions** (from direct inspection, not assumed):
  - Character/mob animation frames: **64×64px** per frame is by far the most
    common (mobs' Idle frames are 32×32); sheets range from 128×32 (a 4-frame
    strip) up to 512×64 (an 8-frame strip).
  - Tile atlases: ~400×400 to 400×432px, not evenly divisible into a single
    clean tile size — mixed-size elements packed on one sheet.
  - Largest sheets by dimension: `Environment/Props/Static/Furniture.png`
    (800×864), `Environment/Structures/Stations/Sawmill/Level_3-Sheet.png`
    (896×640), `Environment/Structures/Stations/Anvil/Anvil_03-Sheet.png`
    (768×560).
- **Naming convention**: `<Action>_<Direction>-Sheet.png` for character
  animations (Direction ∈ {Down, Side, Up}, with one exception — Pierce uses
  Top instead of Up); `<Name>.png` for single-state sheets; numbered variants
  (`_01`, `_02`, `Size_01`…`Size_05`, `Level_1`…`Level_3`) for props/stations
  with multiple stages or sizes.
- **Duplicates/near-duplicates**: none found (no byte-identical files); the
  numbered variants (tree sizes, station levels) are deliberate graduated
  variants, not accidental duplicates.

## Sprite Sheets

Confirmed by opening representative sheets directly (not inferred):

- **Character animation strips** (Body_A, Mobs, NPCs) contain **animation
  frames of one pose**, laid out left-to-right, one row per sheet — e.g.
  `Idle_Down-Sheet.png` = 4 frames × 64×64; `Walk_Down-Sheet.png` = 6 frames ×
  64×64 (frame counts read directly from each `.aseprite` file's own `frames`
  field, cross-checked against a subset visually).
- **Crafting-station sheets** (Anvil, Sawmill, Alchemy, etc.) contain **many
  animation frames of one large decorative object** — `Anvil_03-Sheet.png` is
  roughly 8 columns × 5 rows of a single hammering-anvil loop.
- **Tile atlases** (Dungeon_Tiles.png etc.) contain **grouped, mixed-size
  individual tiles/objects** on one sheet (walls, doors, banners, decorative
  circles) — not a uniform grid, and not animation frames.
- **`Icons/Resources.aseprite`** is declared as a single-frame, 400×400,
  16×16-grid canvas — consistent with a sheet of many small individual icons,
  but its actual visual content was not verified (no PNG export exists to view).

## Command Centre Mapping

Evaluated against the frozen spec's actual UI surface (Phase 15's eight
screens) and the presentation-layer boundary (Phase 15.4/16.2: any such asset
layer must remain presentation-only, reading existing projections, never
computing XP, never holding business logic). Being conservative, as instructed:

| Command Centre concept | Match in this pack? |
|---|---|
| Agent identity / avatar | **Loose match at best.** The Knight/Rogue/Wizzard NPCs and the base Body_A character are humanoid, idle/run/death-animated sprites that *could* stand in as placeholder agent avatars — but the pack's aesthetic is a fantasy dungeon-crawler, not the "sci-fi ops center" direction described in the spec's own visual framing (Phase 1/15.4). Using them is a **stylistic decision the project hasn't made**, not a technical fit. |
| Agent status: Running / Idle | **Loose match.** Idle-cycle and Run-cycle animations exist per character/mob and could visually distinguish "idle" vs "active" on an agent card — but this is a repurposing of generic game-character states, not a designed status-indicator system. |
| Agent status: Completed / Failed | **Very loose.** A Death animation could stand in for "failed"; nothing represents "completed successfully" distinctly. |
| Agent status: Blocked / Approval required | **No match.** Nothing in the pack represents a paused/waiting/gated state. |
| Alerts / Notifications | **No match.** |
| XP / Levels / Achievements / Missions / Rewards | **No match found.** No badge, star, trophy, medal, or achievement-style icon exists anywhere in the 169 exported PNGs. The one plausibly relevant file (`Icons/Resources.aseprite`) is unexported and unverified. |
| Command panels / Navigation chrome | **No match.** Nothing resembling UI panels, buttons, or frames exists — the "Buildings"/"Stations" sheets are decorative game-world structures, not UI chrome. |
| Activity feed | **No match.** |
| Health / readiness | **No match.** No heart, health-bar, or gauge asset found. |
| Locked / unlocked | **No match.** No lock/key icon found (searched explicitly by likely names and by visual inspection of candidates; none present). |
| Success / failure indicators | **Very loose** — see Completed/Failed above; nothing purpose-built. |
| System / Budget status | **Speculative only.** `Dungeon_Tiles.png` contains three colored (red/blue/green) circular rune/portal decorations that *could* be repurposed as ad hoc status-color dots, but they are dungeon-scene decoration, not a designed status-indicator asset, and reusing them would be a stretch. |
| Decorative background / "world" view | **Reasonable match**, if the project later wants a literal tile-map/game-world visualization (Phase 15.4's "pixel-art tileset/game-world view" is explicitly named as a *possible future presentation layer* in the frozen spec) — the tilesets, buildings, and stations are genuine, coherent scenery for that specific idea. This is the one category where the pack's actual content aligns with something the spec already contemplated. |

**Overall finding**: this pack is not a Command-Center UI kit — it is generic
fantasy dungeon-crawler game art. Its most defensible tie to the actual spec is
Phase 15.4's speculative "pixel-art tileset/game-world view," not the agent
cards, status indicators, or gamification UI (XP bars, badges) described
elsewhere in Phases 15–16, none of which this pack provides assets for.

## V1 Priority

Conservative classification, per instructions — **nothing is classified HIGH**,
because nothing here is immediately, uncontroversially usable without a prior
art-direction decision the project hasn't made:

**HIGH PRIORITY**: *(none)*. There is no ready-made UI kit component in this
pack that could be dropped into Phase 15's V1 screens (Overview, Approvals
Queue, Activity Feed) as specified — those are plain data screens per Phase 15,
not gamified/tiled views, and V1's UI scope (Phase 18.1) doesn't include any
gamification surface at all.

**MEDIUM PRIORITY** (candidates for a future, explicitly-decided gamified
presentation layer — V1.1/V2 at the earliest, per Phase 19):
- `Entities/Characters/Body_A/Animations/{Idle,Run,Death}_Base/*` — a coherent
  idle/active/failed visual vocabulary, if agent cards ever get avatar art.
- `Entities/Npc's/{Knight,Rogue,Wizzard}/*` — three distinct humanoid
  silhouettes, if per-Agent-Definition avatars are ever wanted.
- `Environment/Tilesets/*` and `Environment/Structures/*` — coherent scenery
  for a literal "game-world map" view, if that specific Phase 15.4 idea is ever
  pursued.

**LOW PRIORITY**: `Entities/Mobs/*` (Orc/Skeleton creatures), `Weapons/*` — no
plausible Command Centre tie-in beyond generic decoration; could support a
throwaway easter egg, nothing more.

**UNNECESSARY**: `Environment/Props/Static/{Trees,Vegetation,Furniture}*`,
`Environment/Props/Animated/Pan_*` — pure environment dressing for a dungeon
scene, no identifiable relevance to this project even under the "game-world
view" idea above (a server room / ops-center map wouldn't plausibly contain
cooking pans or trees).

**Recommended V1 subset: none.** V1's actual UI scope (Phase 18.1: Overview,
Activity Feed, Approvals Queue) has no gamification surface to populate yet
(`agent_xp_projection` itself is deferred past V1 per Phase 18.1/19). This
inventory is preparation for a V1.1/V2 decision, not a V1 dependency.

## Licensing / Attribution

Per `Terms.txt` (the only license-relevant file present — no separate
`LICENSE`/`README`/credits file exists):

- Author: **Anokolisa** (`AnomalyPixel@gmail.com`).
- Credit is **not required**, but appreciated if given.
- Assets **may be altered** (shape/color/pattern).
- Assets **may be used in commercial products**.
- Assets (altered or not) **may not be sold or marketed as a final product**
  without the original creator's authorization — i.e., this pack (or
  derivatives of it) cannot itself become a product for sale; using it inside
  a larger application is stated as permitted ("creating commercial products...
  where they are functional").
- No redistribution-of-the-raw-pack restriction beyond the above was stated.

This is a factual summary of what `Terms.txt` says — not a legal opinion. If
these assets are ever actually shipped in a public product, get the terms
re-read at that time rather than relying on this summary alone.

## Performance Considerations

- **Total footprint is small**: ~1.11 MB across all 169 PNGs, ~1.36 MB across
  all 168 `.aseprite` sources. Even using the entire pack would not meaningfully
  affect a frontend bundle.
- **Source files must never ship to the frontend.** The 168 `.aseprite` files
  are Aseprite editor projects (confirmed via `file`'s format parsing, not
  filename guessing) — they are not renderable by a browser and exist purely
  as the editable source for the paired PNGs. Any asset pipeline must exclude
  `**/*.aseprite` from whatever gets bundled/served.
- **Sprite sheets need slicing before use.** None of the animation sheets are
  pre-sliced into individual frame files — every character/mob/station
  animation is one multi-frame PNG strip requiring sprite-sheet slicing
  (frame width/height + count, derivable from each file's own `.aseprite`
  metadata) in whatever rendering approach is chosen (CSS sprite offsetting,
  a canvas/WebGL sprite renderer, or a build-time slicer).
- **Tile atlases need manual slicing, not automatic.** Unlike the animation
  sheets, the tile atlases (Dungeon/Wall/Floor/Water/Cave) are irregular,
  mixed-size packed sheets — slicing them requires a human deciding tile
  boundaries (or Aseprite's own slice metadata, not inspected here), not a
  simple fixed-grid cut.
- **A few individual sheets are large enough to matter if used naively**:
  `Furniture.png` (800×864), `Sawmill/Level_3-Sheet.png` (896×640),
  `Anvil_03-Sheet.png` (768×560) — each under 100KB on disk, but worth
  trimming to only the specific animation frames actually used rather than
  shipping full multi-variant sheets.
- **No unnecessary formats found** — everything is PNG (appropriate for
  pixel art with transparency); no oversized JPEG/BMP/TIFF present.
- **The `Icons/Resources.aseprite` file cannot be used at all without first
  exporting it to PNG** (e.g. via Aseprite's CLI or GUI export) — it's the one
  category (icons) most relevant to actual UI work, and it's the one category
  that isn't currently usable.

## Recommended Application Asset Structure

Not implemented — for future reference only, if a gamified presentation layer
is ever built (per Phase 16.2's boundary: this stays a presentation-only asset
concern, never touched by Events/Projections/business logic code):

```
web/public/sprites/            (or an equivalent static-asset directory —
                                 exact location depends on the eventual
                                 Next.js app structure, not decided here)
├── agents/
│   ├── knight/{idle,run,death}.png       (sliced individual frames, or a
│   ├── rogue/{idle,run,death}.png         frame-metadata JSON + the sheet,
│   └── wizard/{idle,run,death}.png        depending on the renderer chosen)
├── world/
│   ├── tiles/                            (sliced dungeon/wall/floor tiles)
│   └── structures/                       (station/building sheets, if used)
└── (nothing from Mobs/Weapons/Props unless a specific future feature needs it)
```

Only a small, deliberately-chosen subset should ever be copied out of the
source pack — never the whole 338-file directory.

## Uncertainties

- **`Icons/Resources.aseprite`'s actual visual contents are unverified** — no
  PNG export exists anywhere in the pack to inspect. Its metadata (400×400,
  16×16 grid) is consistent with a resource-icon sheet, but this is an
  inference from the container format, not a direct observation of pixels.
- **`Environment/Tilesets/Cave_Tiles - WIP.aseprite/png`** is explicitly named
  "WIP" (work-in-progress) by the pack author — its completeness/quality
  relative to the other tilesets was not specifically assessed.
- **`Environment/Tilesets/Water.aseprite`** has no paired PNG (unlike
  `Water_tiles.aseprite`, which does) — unclear whether this is a duplicate
  source file, an earlier draft, or an intentionally-unexported variant.
- Exact per-subfolder file counts for `Environment/Structures/Stations` and
  `Environment/Props/Static/Trees` were derived from directory listings and
  spot-checks, not an exhaustive file-by-file enumeration of every numbered
  variant — the counts in the Asset Summary table are described as
  approximate for these two subtrees.
- Whether any additional license/attribution terms exist on the platform this
  pack was originally distributed from (e.g. an itch.io or store listing) was
  not checked — only the terms actually present in the pack's own `Terms.txt`
  are reported here.

## Recommended Next Steps

1. **No action required for V1** — the current MVP's UI scope (Phase 18.1) has
   no gamification surface, so this pack has no V1 dependency.
2. **Before any future gamification UI work**, the project needs an explicit
   art-direction decision: lean into this pack's fantasy-dungeon aesthetic for
   agent avatars/world-view, source a different (sci-fi/ops-center-themed)
   asset pack consistent with the spec's original visual framing (Phase 1/15.4),
   or keep the UI non-illustrated (icons/typography only). This inventory
   deliberately does not make that call.
3. **If `Icons/Resources.aseprite` turns out to matter**, it needs exporting to
   PNG (Aseprite GUI or `aseprite --batch --export` CLI, if Aseprite is
   available) before its contents can even be evaluated for use.
4. **If a future unit does build a gamification presentation layer**, keep it
   strictly to the Phase 16.2 boundary already established: it reads
   `agent_xp_projection`/other projections for data and renders sprites
   accordingly — it never becomes a second source of truth, never computes XP,
   and never touches Events/Runs/Invocations directly.

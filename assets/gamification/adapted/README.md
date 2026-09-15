# Adapted assets

This folder holds UI world art **derived from** the source packs in `../Tile Pack/`. Those packs are never edited; everything here is reproducible from a script.

| File | Made by | What it is |
|---|---|---|
| `compose-w2-keep.ps1` | the recipe | Composes the "W2 varied rooms" keep. |
| `w2-keep-base-1x.png` | the script | 672×576 source-pixel composite. |
| `w2-keep-base-2x.png` | the script | The same at 2×, nearest-neighbour. Used as the world base in Figma. |
| `w2-rooms.json` | the script | Room rectangles at 2× (x, y, w, h), used to place live layers. |

Run it with `powershell -File compose-w2-keep.ps1`. It needs Windows PowerShell with System.Drawing.

## Current assets (cycle 3–5, pure-pixel direction D19)

| File | Made by | What it is |
|---|---|---|
| `compose-keep-v4.ps1` | the recipe | The current keep. |
| `keep-v4-1x.png`, `keep-v4-2x.png`, `keep-v4-rooms.json` | `compose-keep-v4.ps1` | The composite and room rectangles. |
| `make-light-pools.ps1` | the recipe | Dithered pixel light. |
| `light-{active,wait,core,ambient,torch}-2x.png` | `make-light-pools.ps1` | Light pools, one colour per meaning. |
| `sprites-outlined-2x/`, `sprites-outlined-4x/` | a script in the session | Agent sprites with a baked 1-logical-pixel dark outline, for contrast in coloured light. |
| `core-crystal-pedestal-2x.png` | hand-drawn 16×20 pixel map | The runtime core. |
| `make-outlined-strips.ps1` | the recipe | Knight and wizard run, idle and death strips with the same baked outline, 1 logical px of padding per frame. |
| `strips-outlined-2x/` | `make-outlined-strips.ps1` | Animation strips for the motion prototype and the UI. |
| `motion-prototype.html` | hand-written | Local-only motion prototype over the keep art. Open it from this folder; it reads the generated PNGs next to it. It runs scripted demo states, never live data. |
| `room-*` crops | cropped from the composites | Close-ups and vignettes. |

**`compose-keep-v4.ps1` layout:**
- A larger command room, 24 px halls and a wider side rim with rampart columns, so it fills 1440 px at 2×.
- The forge fire is recoloured to dark embers: it is not state, so it must not glow.
- The command room floor is shifted teal → slate, so cyan stays unique to "active".
- The Researcher workshop floor gets the same slate shift, and the pale Publisher stone is dimmed ×(0.72, 0.72, 0.76). An unlit room must never look lit or cyan.
- `room-researcher-workshop-4x-slate.png`: the 4× close-up with only its teal pixels (B > R+12 and G > R+8) slate-shifted, so the furniture keeps its colours. It replaces `room-researcher-workshop-4x.png` in Figma.
  - **2026-09-15:** the decorative chest pair on its floor is covered with the floor tile one period (192 px) to the right: a 152 × 128 area at (16, 356). In this UI a chest means one real artifact, so no room art may carry painted chests. `room-researcher-workshop-4x-slate-nochests.png` is an identical copy of the patched file. The un-patched slate version was overwritten, and is reproducible from `room-researcher-workshop-4x.png` plus the slate shift above and this patch. The vault and keep composites carry no chests either (`compose-keep-v4.ps1`).
- No chests are baked into the vault. On the Artifacts screen each chest is one real artifact.

## What the composite contains

A 3×3 keep of 192×160 rooms (source pixels) joined by 48 px stone-brick corridors. Each room has its own architecture and furniture, and the furniture maps to what the product represents.

| Room | Represents | Built from |
|---|---|---|
| Library | Events (records) | Modern interiors: bookshelves, desks, globe. Wood plank floor. |
| Council hall | Approvals | Modern interiors: tables, chairs, plants. Parquet floor. |
| War room | Goals | Pixel Crawler banners, Modern map table and chairs. Plank floor. |
| Researcher / Publisher workshops | agent work areas | Pixel Crawler workbench and lab console stations. |
| Command room | runtime core | Apartment demo screens, consoles and chairs around the Pixel Crawler pit, plus a small lab table. |
| Engine room | Workflows | Pixel Crawler furnace tower and workbench on a grate floor. |
| Entrance hall | nothing (world-building) | Pixel Crawler benches, banners, candles. |
| Vault | Artifacts | Modern wardrobes, Pixel Crawler lockers, Top Down Adventure chests. |

## Adaptations

- **Modern tiles and apartment art is darkened and cooled** with a colour matrix: R×0.66, G×0.70, B×0.80. That's how bright daylight furniture sits in dungeon light. Pixel Crawler art is used unchanged.
- **Scale:** whole-number only (1× source, 2× output). Never smoothed.

## What is NOT baked in

Anything that carries **runtime state** stays a separate live layer in the UI, so it can change with the API:
- room light (state colour);
- agent sprites and their pose;
- the approval seal;
- stop barriers and doors;
- name tags and status labels;
- the core crystal and its glow.

The composite is the static architecture only. Don't bake state into it.

Licences: see `.claude/skills/designing-command-centre-ui/design-decisions.md` D13, D14 and D18. The operator allows all packs, but third-party pack files shouldn't be published without re-checking.

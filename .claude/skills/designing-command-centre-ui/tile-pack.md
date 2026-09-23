# Tile Pack: the world's asset library

Source: `assets/gamification/Tile Pack/Pixel Crawler - Free Pack/` (Anokolisa). Full inventory: `docs/gamification/TILE_PACK_INVENTORY.md`.

Licence (`Terms.txt`): may be used and altered inside a commercial app. Credit is optional. The pack may not be resold as a product.

## Rules

- **Copy a chosen subset** into `web/public/sprites/{agents,world,stations,fx}/`, never the whole pack. Never ship `.aseprite` files.
- **Grid:** 16 px. Scale by whole numbers only (2×, 3×, 4×), with `image-rendering: pixelated`. Never scale by fractions, never smooth.
- **Animation:** CSS `steps(n)` on `background-position` over a sprite strip, or a `<canvas>` world renderer. No animation or game library until there's a measured need.
- **Frame counts** below are sheet width ÷ frame size. Confirm against the `.aseprite` `frames` field before shipping, since a strip may contain padding.
- **Tile atlases** (`Environment/Tilesets/*.png`) are irregular packed sheets. A person chooses the slice rectangles and records them in a JSON slice map. Never guess a grid.
- **The approved slice map is `tile-slices.json`** in this skill: 34 named cuts in source pixels, each with a category and intended use, plus excluded regions. Use only these cuts. To add or change one, propose it on the Figma page "Tile cut map (review)" and get operator approval first.

## Characters (agents)

| Sheet | Size | Frames |
|---|---|---|
| `Entities/Npc's/{Knight,Rogue,Wizzard}/Idle/Idle-Sheet.png` | 128×32 | 4 × 32 px |
| `Entities/Npc's/{Knight,Rogue,Wizzard}/Run/Run-Sheet.png` | 384×64 | 6 × 64 px |
| `Entities/Npc's/Knight/Death/Death-Sheet.png` | 288×32 | 6 frames × 48×32 px (not square) |
| `Entities/Npc's/{Rogue,Wizzard}/Death/Death-Sheet.png` | 384×32 | 6 frames × 64×32 px (not square) |
| `Entities/Characters/Body_A/Animations/Idle_Base/Idle_{Down,Side,Up}-Sheet.png` | 256×64 | 4 × 64 px |
| `…/Run_Base/Run_{Down,Side,Up}-Sheet.png` | 384×64 | 6 × 64 px |
| `…/Collect_Base/Collect_{Down,Side,Up}-Sheet.png` | 512×64 | 8 × 64 px |
| `…/Carry_Idle/Carry_Idle_{Down,Side,Up}-Sheet.png` | 256×64 | 4 × 64 px |
| `…/Hit_Base/Hit_{Down,Side,Up}-Sheet.png` | 256×64 | 4 × 64 px |
| `…/Death_Base/Death_{Down,Side,Up}-Sheet.png` | 512×64 | 8 × 64 px |

An agent's sprite is a visual identity keyed to its **persistent name** (every Definition version looks the same), never a version id. An agent the operator dressed draws its `agent_appearances` look from the character kit (`agent-kit-2x/`, D24); any other agent keeps a default Knight or Wizzard, assigned in sorted name order. It is not a role or a class, and says nothing about capability.

## Stations and world

| Asset | Use in the world |
|---|---|
| `Environment/Structures/Stations/Alchemy/*` | Where `llm` Invocations happen: synthesis |
| `…/Anvil/*`, `…/Workbench/*` | Where `tool` Invocations happen: making an effect |
| `…/Furnace/*` | Deterministic processing |
| `…/Bonfire/*` (plus `Fire_*`, `Smoke-Sheet`) | Hub hearth, or live/idle heartbeat |
| `Environment/Tilesets/Dungeon_Tiles.png` | Walls, doors, banners, portcullis, and red/blue/green rune circles for room-state floor sigils |
| `Environment/Tilesets/{Floors,Wall}_Tiles.png` | Room and corridor construction |
| `Entities/Mobs/*`, `Weapons/*`, trees, cooking props | Not used. They carry no system meaning. |

Assigning a station per Invocation kind is a presentation choice, recorded here so every screen uses the same one. It does not create new capabilities.

## State treatments

The pack has idle, run and death. Everything else is a designed overlay built from pixel chrome (D19), dithered state light and tile sigils. Overlays use the state tokens and sit above the static composite as live layers.

| Runtime state | Character | Environment / overlay |
|---|---|---|
| Task Instance `pending` | Absent, or at the door | Room unlit, door closed |
| `active`, Invocation `executing` | Run to the station, then Collect loop | Station animates, room lit cyan (dithered pool clipped to the floor) |
| Invocation `proposed` | Idle facing the station | Station powers up (a single pulse) |
| `awaiting_approval` | Idle, facing the viewer | **Designed:** amber seal or sigil over the station, pulsing slowly, with the risk tier. Links to that approval. |
| Workflow Run `paused` | Idle | **Designed:** corridor lights dim amber, a held gate icon |
| Execution stop active (`activeStop`) | Idle, frozen on frame 1 | **Designed:** red barrier or portcullis across the room door, with the stop scope label |
| `completed` | Idle, or Carry_Idle when an artifact was produced | Station cools, one green completion flash, an artifact glyph on the room's shelf |
| `failed` | Death, played once and held on the last frame | Red alarm lamp, sealed door, failure reason on inspect |
| Approval `rejected` / `expired` | As `failed` | Seal breaks (rejected) or fades (expired) |
| SSE offline | Unchanged (last loaded state) | State light dims to about 45% because it may be stale. The connection chip reads a neutral "Offline", and the notice strip says the feed is offline with a neutral Reconnect button (Overview "live feed offline" state frame). |

Other packs (see `design-decisions.md` D13–D15): Top Down Adventure and Pixel 16 Interiors supply props, and `tile-slices.json` → `extraSlices` lists the cuts. Cute Fantasy supplies the outdoor wilderness around the keep: a composed ground image from grass plus path and water 9-slices, and trees, lamps and scatter. Its licence is non-commercial only, so never put it in a public repo or bundle.

Decoration rule: empty world space gets a dimmed floor and ambient props (`wall/stone-column`, `deco/*`, `props/*`, `floor/grate`), layered behind rooms. Status tiles (`wall/lamp-*`, `sigil/*`, `door/arch-portcullis`, `door/bars`) are never used as decoration.

Motion rule: animate what is working. Idle is subdued, meaning 1–2 fps breathing, no light pulses. Errors are loud once, then steady. Never loop an alarm.

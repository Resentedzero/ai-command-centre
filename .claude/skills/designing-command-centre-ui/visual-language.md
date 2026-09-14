# Visual language: "The dungeon/village is the computer"

A living pixel-art keep: varied rooms, halls and a glowing core. It is the AI runtime made visible. **The chosen direction is pure pixel (D19).** Sci-fi mission control was explored and rejected as the default (cycle 2 in `design-reviews.md`): vector HUD chrome made the screen read as a SaaS tool with a game inside it.

## The two layers

| Layer | Carries | Built from |
|---|---|---|
| **World** (pixel art) | Where work happens, who does it, what state it is in | A continuous keep of varied rooms (library, council hall, war room, workshops, command room, forge, vault), composed from all packs and adapted to dungeon light (`assets/gamification/adapted/`). Light, seals, doors, barriers and character poses carry state. |
| **Chrome** (pixel GUI) | Exact values, lineage, controls, notices | Pixel bevel frames (2 px outline plus a 2 px edge), dark wood bars and boards, parchment cards, Pixelify labels. They read as signs and boards inside the keep, not a dashboard laid over it. |

- **Everything is pixel-honest.** Whole-number scales, 2 px frame steps, dithered light. Smooth vector glows, hairline panels and holo effects are not used.
- **Share of the screen.** About 65–75% world on world-centred screens. Reading-first screens (Approvals, Events) invert this, but still sit on the same wood/parchment material. See `screens.md`.
- **Light is the information.**
  - **State light:** cyan = active; amber = awaiting approval / pending approval / paused; red = failed or stopped.
  - **Runtime core:** pale silver.
  - **Ambient:** rooms get dim neutral warm grey, and torches are tiny warm points. Ambient light must never read as amber state.
  - **Clipping:** all light is dithered and clipped to room floors.
- **Rooms may differ in architecture and mood**, but furniture must match what the room represents (see the room table in `assets/gamification/adapted/README.md`). Room-scale state (light, seal, barrier, sprite pose, tag) is always a live layer over the static composite.

## Palette (CSS custom properties; Figma variables use the same names)

Sampled from the references, then assigned meaning. A hue carries one meaning only.

| Token | Value | Meaning |
|---|---|---|
| `--void` | `#01070E` | Page background, unlit space around the world |
| `--panel` | `#040D15` | HUD panel fill (roughly 88% opaque over the world) |
| `--panel-raised` | `#0A1824` | Inspector sections, hovered rows |
| `--line` | `#15303F` | Hairline borders, dividers |
| `--text` | `#E6EEF5` | Primary text |
| `--text-dim` | `#7F93A6` | Labels, secondary text |
| `--state-active` | `#08B8F9` | `active`, `executing`, live data beams |
| `--state-done` | `#0BC97F` | `completed`, approved, live connection |
| `--state-wait` | `#F8A60F` | `awaiting_approval`, `paused`, pending approval |
| `--state-fail` | `#FB5D42` | `failed`, rejected, execution stop, stop controls |
| `--state-idle` | `#3B83D2` | `pending` or idle, shown dimmed |
| `--light-torch` | `#FCD20B` at low alpha | Ambient warm world light only. Never a status. |
| `--core-glow` | `#0BABE9` | Hub core and system chrome accents |

**Agent identity tints** give each room a light colour and name-plate trim: `--identity-violet` `#9C4AEE`, `--identity-magenta` `#F84FB9`, `--identity-indigo` `#6A7BFF`, `--identity-lilac` `#C77DFF`, `--identity-teal` `#2BD9C5`.

All of these tokens exist as Figma variables in the "Command Centre" collection (mode "Dark") of the D5 file. A Figma `state/active` is the CSS `--state-active`, and each variable's code syntax is set to its CSS name. They deliberately avoid the state hues. The reference gives one agent a red identity, which would read as an error, so that is not copied.

**Pixel chrome palette** (Figma variables `pixel/*`, CSS `--pixel-*`). These are chrome materials and never carry state:

| Token | Value | Use |
|---|---|---|
| `pixel/wood-dark` | `#1C130D` | Top bar, board, notice board |
| `pixel/wood` | `#2A1B12` | Tag and chip fill |
| `pixel/wood-edge` | `#6B4A2B` | 2 px bevel edge, bar borders |
| `pixel/outline` | `#0B0705` | 2 px outer outline, ground shadows |
| `pixel/parchment` | `#D8C49C` | Reading cards |
| `pixel/parchment-shade` | `#B39E74` | Card edge, skeleton bars |
| `pixel/ink` | `#3B2A1A` | Text on parchment |
| `pixel/label` / `pixel/label-dim` | `#F3E3C3` / `#A58B63` | Text on wood |

**Reading surfaces:**
- **Parchment** (`pixel/parchment`) is for short cards: headers, lineage rows, summaries.
- **Contrast (measured WCAG ratios):**
  - **On parchment, text is `pixel/ink` only** (8.0:1). Every state colour is 1.2–1.8:1 on parchment and every light label 1.4–1.9:1, so state on parchment is carried by the outlined marker plus an ink word. The marker's 2 px `pixel/outline` supplies the edge contrast.
  - On wood and void, all text tokens pass AA: `pixel/label` 13–16:1, `pixel/label-dim` 5.1–6.2:1, state colours 5.3–10.1:1.
  - Translucent text must still reach 4.5:1 after blending. Skeleton "· · ·" in ink needs at least 80% opacity on parchment (55% was 2.8:1). The dots already say "not loaded", so faintness adds nothing.
  - `pixel/wood-edge` is a border colour, never text (2.1–2.5:1 on wood).
- **Long reading** (approval previews, JSON snapshots, event logs, descriptions) sits on **dark vellum**. That is `pixel/wood` or `pixel/wood-dark` with a `pixel/wood-edge` bevel, in JetBrains Mono `pixel/label` text, at 14–16 px. Cream parchment over a large area glares.
- Readable content never sits on the map or its light.

**Green and red are for decisions and controls only.** Green (`state/done`) marks a positive outcome or confirming control: Live connection, completed, approved, the Approve button, a hash that matches. Red (`state/fail`) marks failure, rejection or a destructive control: failed, rejected, stopped, Stop and Reject buttons, a hash mismatch. Neither is ever world light. A neutral fact ("no active stop") is plain ink, never green.

**One approval, one place.** An agent that is `awaiting_approval` stands on the seal in the council hall (Approvals). Its own workshop goes dark, and its plaque keeps the amber marker. The hall is lit amber while any approval is pending. No room is lit twice for the same approval.

**The void is world darkness only.** Navy-black appears only inside a bevel-framed world view. Reading areas, boards and screen backgrounds sit on wood.

**Skeletons** (a value is still loading or absent from the mockup) are a "…" glyph in the surface's dim ink. Never draw a bar, which reads as a partly filled gauge (fake data).

`--core-glow` cyan is retired as the runtime colour. The core is pale silver (`#DDE8FF`), so it never reads as a third active agent.

**Status is never conveyed by hue alone.** Every state carries an icon or sigil and a text label.

## Typography

| Role | Face | Rules |
|---|---|---|
| World labels, screen titles, nav, tags, card titles, buttons | Pixelify Sans | 16 px or larger, whole-number scale, never long body text |
| Long reading text (approval previews, event summaries, descriptions) | JetBrains Mono on parchment or wood | Pixelify is unreadable in dense passages. IBM Plex Sans is no longer used for chrome (D19). |
| Numbers, ids, telemetry | JetBrains Mono (tabular figures) | Every amount states its unit: `0.0412 usd`, `18,204 subscription_tokens` |

Load fonts with `next/font/google` (self-hosted at build). These are decided in `design-decisions.md` D4.

Figma text styles in the D5 file, where each `a/b` name becomes a `.a-b` class or type token in code:

| Style | Font | Size / line height |
|---|---|---|
| `world/title` | Pixelify Sans SemiBold | 32/40 |
| `world/label` | Pixelify Sans Medium | 16/20 |
| `hud/heading` | IBM Plex Sans SemiBold | 16/24 |
| `hud/body` | IBM Plex Sans Regular | 14/20 |
| `hud/small` | IBM Plex Sans Regular | 12/16 |
| `hud/section` | IBM Plex Sans SemiBold, uppercase, 8% tracking | 12/16 |
| `data/value` | JetBrains Mono Medium | 20/28 |
| `data/body` | JetBrains Mono Regular | 13/20 |

## Spacing and radius

These live in the Figma "Spacing" collection; CSS names follow the same rule (`space/md` → `--space-md`).

| Token | px | Use |
|---|---|---|
| `space/2xs` | 2 | Icon to text in dense labels |
| `space/xs` | 4 | Inside labels and chips |
| `space/sm` | 8 | Between related items |
| `space/md` | 12 | Dense panel padding |
| `space/lg` | 16 | Default panel padding |
| `space/xl` | 24 | Between panel sections |
| `space/2xl` | 32 | Between major regions |
| `space/3xl` | 64 | Board and page margins |
| `radius/none` | 0 | Default HUD corner |
| `radius/sm` | 2 | The most rounding allowed |

## Panels and chrome

- **Frames:** every chrome frame is a pixel bevel, meaning a 2 px `pixel/outline` around a panel with a 2 px `pixel/wood-edge` or `pixel/parchment-shade` edge. Corners are square. There are no hairline glass panels, rounded SaaS cards, drop shadows or glows.
- **Grouping:** wood holds navigation and world tags; parchment cards hold short summaries, and long reading sits on dark vellum (see "Reading surfaces"). Buttons are bevel frames too, with a dark fill and a state-coloured edge: a dark red fill with a red edge for Stop. Solid saturated button fills are too loud.
- **Effects:** never put an effect on an image-filled sprite rectangle. It applies to the bounds and draws a box.
- Group with hairlines and section labels, not with more boxes. One panel with dense rows beats a grid of cards.
- Pixel-GUI framing (the parchment/wood panels in reference image 2) is the chrome everywhere since D19: boards, cards, plaques, buttons. No sci-fi HUD panels remain.
- Icons: a single-weight line set for the HUD, and 16 px pixel glyphs for the world. Never mix them in one component.

## Density and hierarchy

- Information-dense but scannable: 28–32 px rows, telemetry in mono, and the most important value per panel at 1.5–2× size.
- Hierarchy on every screen: (1) what needs the operator now (approvals, stops, failures), (2) what is working, (3) detail on demand.
- Detail appears in an inspector anchored to the selected world object, not in a new page, unless the job is deep reading.

## Motion

| Motion | Rule |
|---|---|
| Working | Continuous: the character's run or work loop (Pixel Crawler strips, 100 ms per frame, CSS `steps()`). While live, the rune crosses around the core pulse faintly (1 step brighter, 2 s). |
| Event arrives for a room | That room's light brightens by one dither level for 400 ms, then settles. A notice tab slides onto the board. |
| Idle | Barely moving: 1–2 fps breathing, no pulses |
| Needs attention | Slow pulse (1.6 s), amber |
| Failure or stop | One sharp flash, then steady red. Never loop an alarm. |
| Completion | A single green flash, then settle |
| HUD transitions | 120–180 ms, ease-out, no bounce |

Respect `prefers-reduced-motion`: freeze sprites on a representative frame, and keep state legible through the sigil, lamp and label.

**Prototype:** `assets/gamification/adapted/motion-prototype.html`, served locally by the `motion-prototype` entry in `.claude/launch.json`. It runs the rules above over the real keep art with scripted demo states, and has been checked in the browser:
- run loop: 6 frames at 100 ms (`steps(6)`, 0.6 s);
- idle: 2 fps;
- seal pulse: 1.6 s;
- runes: 2 s;
- event boost: 400 ms;
- failure and stop: one red flash, then steady;
- completion: one green flash;
- death: a single strip play that holds its last frame (`steps(n-1)` + `forwards`, so it never lands on an empty frame);
- reduced motion: every animation stops.

Implementation notes:
- Sprites use the baked-outline strips in `strips-outlined-2x/`.
- One-shot flash classes must be cleared on every state change; otherwise a stale class wins the cascade and replays the wrong colour.

## Avoid

- Generic SaaS dashboards and walls of cards
- Corporate admin styling
- Generic space-cockpit chrome
- Glow, scanlines or particles laid over text or numbers
- Copying a reference layout pixel for pixel
- Giving every screen the same template

---
name: designing-command-centre-ui
description: Use when designing, restyling or implementing any AI Command Centre screen or component in web/, when working from the reference images in assets/References for Ui, the Tile Pack sprites or a Figma frame, or when a design shows agents, metrics, states or features the API may not provide.
---

# Designing the Command Centre UI

## Overview

**The dungeon is the computer.** A living pixel-art keep makes AI work visible, and light in its rooms carries real state. The chrome is pure pixel too: wood and parchment boards, pixel bevel frames (D19). The earlier sci-fi HUD direction is superseded.

**The runtime decides what exists. The references decide how it feels.** Reference images, and later Figma frames, set atmosphere, palette, density, composition and motion. They never add agents, states, metrics, tabs or capabilities.

## The contract every screen meets

Each thing drawn on screen is exactly one of these:

1. **A real value**, naming its `web/lib/api.ts` type and field.
2. **Client-only state:** clock, SSE connection status, selection, hover.
3. **Chrome:** decoration that states no fact about the system.
4. **An honest absence:** an empty, loading, unavailable or error state, with a line saying why.

Nothing else is rendered: no demo data, no sample agents, no placeholder numbers. A value a design wants but the API lacks goes into `design-decisions.md` as a proposal. It is never a constant in `web/`.

## Before designing

| Need | File |
|---|---|
| Data, state vocabularies, reference-to-real mappings | `runtime-truth.md` |
| Palette tokens, type, panels, motion, what to avoid | `visual-language.md` |
| Each screen's operator question, composition and gating | `screens.md` |
| Sprites, frame counts, a treatment for every state | `tile-pack.md` |
| Take / don't take, per image | `references.md` |
| The 10-step workflow, Figma ↔ code mapping, validation | `figma-workflow.md` |
| Decided and proposed choices | `design-decisions.md` |
| Why each rule exists: critic rounds, accepted and rejected fixes, measured audits | `design-reviews.md` |
| Adapted art and the scripts that make it, plus the motion prototype | `assets/gamification/adapted/README.md` |

**Source of truth for visuals:** Figma file `3Q5IMyXoPHDBFDv8vjS467`.
- **`04 — Screens` pages:** each final pixel screen sits at (0, 0), with its states, laptop variants and a design note. Frames prefixed `[superseded: sci-fi HUD]` are history.
- **`03 — Components`:** `PixelTopBar`, plus the interaction-state sets `PixelButton`, `PixelTab`, `PixelPlaque` and `PixelInput`.
- **`05`:** the experiment trail only.

Read `web/AGENTS.md` before writing any Next.js code.

## Quick reference

- **Agents drawn** = rows the API returned. With zero rows, show the empty dungeon hub, not sample agents.
- **States:** use the runtime's own names (`awaiting_approval`, `paused`, `failed`…) with the treatments in `tile-pack.md`. Never merge real states into a reference legend. Never render `blocked` or `skipped`: the runtime never produces them.
- **Units:** one gauge per `resourceUnit`, labelled. Never summed, converted or given an invented limit.
- **Colour:** only the `visual-language.md` tokens. A hue means one thing. Status always has a label and an icon.
- **Sprites:** Npc's (Knight, Rogue, Wizzard) and Body_A only. Mobs and Weapons carry no meaning here.
- **Layouts:** screens differ by purpose (`screens.md`). No shared page template.
- **Figma:** it defines visuals only. If a frame shows unsupported data, build the mapped form and log the gap.
- **Light = state:** cyan active, amber awaiting approval, silver runtime core. Unloaded or failed means no room is lit. Green and red are for decisions and outcomes, never world light.
- **Every screen has its states:** loading ("· · ·", never bars), empty, error with a neutral recovery control, and offline. Routes and status codes go on a dim detail line, not in the message.
- **Contrast:** ink is the only text colour on parchment; translucent text must still reach 4.5:1. Measured values are in `visual-language.md`.
- **Interaction:** focus is a 2 px cream ring in a reserved slot; selection is a cream edge, never a state colour; disabled controls carry no state colour.
- **Laptop (1280 × 800 up):** the act-now control (Stop, Approve/Reject, hash check) stays above the fold, and a world view pans to what needs attention. Below 1280 × 800 is not designed.
- **Motion:** working loops at 100 ms per frame, one-shot flashes never loop, and reduced motion freezes sprites. See `motion-prototype.html`.

## Rationalizations (all seen in baseline testing)

| Excuse | Reality |
|---|---|
| "The operator asked to match the reference closely" | Match the look: lighting, density, composition. Content comes from the API. |
| "The demo is tomorrow, so placeholders keep it moving" | A demo of invented agents shows a product that doesn't exist. Ship honest empty states. |
| "Placeholders are labelled, so nobody is misled" | Labels get screenshotted without the tooltip. Placeholders are forbidden, not labelled. |
| "Only shown when the API fails" | An API failure shows an error state, never substitute data. |
| "Blocked/Done is close enough to the runtime state" | Separate states get separate treatments. Use the runtime's vocabulary. |
| "The reference shows 12 agents / XP / a graph / a model name" | See the mapping table in `runtime-truth.md`. |

## Red flags: stop and re-read the contract

- A file named `placeholders`, `demo`, `mock` or `sample` under `web/` outside `web/tests/`
- A hard-coded name, count, amount, model id or capability in a component
- A status set that isn't in `runtime-truth.md`
- A hex colour not in the tokens
- Every screen sharing one layout

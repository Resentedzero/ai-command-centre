# Design-to-code workflow and Figma

## Sources of truth

| Question | Source |
|---|---|
| What the platform does, what data and states exist, what the operator may control | Spec → API routes → `web/lib/api.ts` |
| How it looks: layout, components, variants, tokens, interaction and responsive behaviour | Figma file `3Q5IMyXoPHDBFDv8vjS467` (D5): the final pixel screens on the `04 — Screens` pages, components on `03 — Components`. This skill records the rules behind them. |
| How it is built | React/Next.js in `web/`, mapped to real read models |

Figma never adds runtime behaviour. A frame showing a feature the API lacks is built only in its mapped form (`runtime-truth.md`), and the gap is logged as a proposal.

## The workflow

1. **Runtime.** Read the read models this screen uses in `web/lib/api.ts` and the routes behind them. List the states that can occur.
2. **Purpose.** Write the operator question (`screens.md`).
3. **Hierarchy.** Split content into act now / working / detail on demand.
4. **World composition.** Decide what rooms, corridors, hub and objects mean on *this* screen.
5. **Chrome layer.** Place boards, cards, plaques and controls (pixel bevels, wood and parchment) around or inside the world. Each value names its source.
6. **Primitives.** Reuse or define components (list below) before drawing anything bespoke.
7. **States.** Draw every state the runtime can produce for each primitive, plus loading, empty, error and SSE-offline states. Draw no others. Include interaction states (hover, pressed, focus, disabled).
8. **Figma.** Capture or refine the frames, components and variables. Get a critic review and log it in `design-reviews.md`. Check contrast and the 1280 × 800 layout.
9. **Implement.** Build the approved frame in `web/`, component by component.
10. **Validate.** Check it against the frame visually, and against the API contract in tests.

## Keeping Figma and code in step

- **Variables ↔ CSS custom properties, same names:** `pixel/wood` ↔ `--pixel-wood`, `state/active` ↔ `--state-active`. Colour, spacing, type scale and motion durations are all variables.
- **Components ↔ React components, same names;** variants ↔ props. Variant values come only from the runtime vocabularies in `runtime-truth.md` (never a made-up `state=thinking`) or from interaction states.
- **Pixel primitives (D19):**
  - World: `WorldViewport` (pans), `Room`, `Corridor`, `AgentSprite`, `StateSigil`, light pools
  - Chrome: `PixelTopBar`, `PixelButton`, `PixelTab`, `PixelPlaque`, `PixelInput`, bevel cards (parchment for short summaries, dark vellum for long reading), notice strip
- **Built in Figma** (`03 — Components`):

  | Component | Figma node | Variants / properties | React |
  |---|---|---|---|
  | `PixelTopBar` | `95:242` | `active` = Overview, Agents, Workflows, Goals, Approvals, Artifacts, Events. Slots are `PixelTab` instances (120×40). TEXT props: Agents count, Pending, Connection. Hide the title at 1440 px wide or less. | `<PixelTopBar active="agents" />` |
  | `PixelButton` | `132:109` | `kind` = neutral, danger, approve; `state` = default, hover, pressed, focus, disabled. Focus is a 2 px cream ring in a reserved slot. | `<PixelButton kind="danger">Stop agent</PixelButton>`; state comes from CSS `:hover`, `:active`, `:focus-visible`, `[disabled]` |
  | `PixelTab` | `132:125` | `state` = inactive, hover, active, focus | `<PixelTab active />` |
  | `PixelPlaque` | `132:146` | `state` = default, hover, selected (cream edge), focus | a selectable list row |
  | `PixelInput` | `132:164` | `state` = default, focus, error, disabled | `<PixelInput error="…" />` |
  | `AgentSprite` | `20:20` | `character` = knight, rogue, wizard (identity from the agent id hash, never a role); `pose` = idle, run, death, chosen from runtime state (see `tile-pack.md`). In code, use the outlined strips in `assets/gamification/adapted/strips-outlined-2x/`. | `<AgentSprite character={identityFor(id)} pose={poseFor(taskStatus)} />` |
  | Tiles (approved cuts) | `24:2` | 34 image frames at 4×, named like `tile-slices.json` slices | Source art (not a component) |
  | Map scale 2× (source art) | `29:2` | The same cuts plus `sprite/<character>-<pose>` at 2× (tile 96 px) | Source art (not a component) |
  | Sprites (source art) | `15:2` | Knight, Rogue and Wizard idle frame 1 at 4× | Source art (not a component) |

  **Status in pixel (replaces `StatusLabel`):** the outlined `Pixel state marker` (10×10, fill in the state colour, 2 px `pixel/outline`) followed by the runtime word. The word is in the state colour on wood, and in `pixel/ink` on parchment (contrast rule). Unloaded status is a dimmed neutral marker plus "· · ·". It isn't a separate component yet; build it as `<StatusMark state="…" />` from `runtime-truth.md` vocabularies.

  **Sci-fi era, superseded by D19** (kept on `03` for reference; don't build these): `StatusLabel` `10:2`, `UnitGauge` `11:18`, `ConnectionIndicator` `12:17`, `CommandButton` `14:42`, `StateSigil` `27:14`, `Room` `30:154`. Their state lists still describe the runtime vocabulary correctly.

  Add a row whenever a component is built.
- **Layout per screen is a composition of primitives, not a shared page template.**
- **Styling:** CSS Modules plus a global tokens file (`web/app/tokens.css`). No Tailwind or component library unless `design-decisions.md` records the decision (D3).

## Using Figma through MCP

At the start of UI work, check whether a Figma MCP server is connected (search the available tools for "figma").

- **Connected** (the official Figma server, `https://mcp.figma.com/mcp`): give it the frame or node URL the operator approved (right-click the frame → Copy link to selection).
  - `get_design_context`: layout and structure to implement against
  - `get_variable_defs`: tokens, to check against `visual-language.md` names
  - `get_screenshot`: the visual target for validation
  - `get_metadata`: node tree and names for large frames
  - `get_code_connect_map`: existing component ↔ code links

  Map every value the frame shows through `runtime-truth.md` before writing JSX. Its example code is a starting point: convert it to CSS Modules and project tokens, never paste Tailwind or hard-coded hex values.
- **Not connected:** ask the operator for the frame link or an exported PNG plus the variable values. Never guess a design from memory or from the reference images.
- Exported sprite art comes from the Tile Pack (`tile-pack.md`) and `assets/gamification/adapted/`, not re-exported from Figma, so pixels stay exact.
- **Putting sprites into Figma:** Figma smooths scaled image fills, so pre-scale outside it.
  1. Crop the frame from the strip, using sizes from the `.aseprite` header.
  2. Scale it by a whole number with nearest-neighbour (e.g. System.Drawing `InterpolationMode.NearestNeighbor` plus `PixelOffsetMode.Half`).
  3. Create target frames at exactly the scaled size.
  4. Call `upload_assets` with `nodeIds`.
  5. POST each PNG as raw bytes (`curl -X POST -H "Content-Type: image/png" --data-binary @file`). Multipart also works, but renames the layer after the file. The URLs are single-use and expire in 10 minutes.
  6. Screenshot to confirm.

  Never resize the frames in Figma afterwards. Build world components from the approved cuts, never from re-cropped atlas art.
- **Figma API gotchas learned here:**
  - **Pages:** use `await figma.setCurrentPageAsync(page)`; assigning `figma.currentPage` throws. Call `await page.loadAsync()` before searching a page.
  - **Scripts:**
    - Run `use_figma` edits one at a time.
    - A script that throws is rolled back completely, so re-run the whole script. For multi-part edits, wrap each part in its own try/catch and return the errors, so one failure doesn't undo the rest.
  - **Mixed values:** properties such as `strokeWeight`, padding and `fontName` can return `figma.mixed`, a symbol. String concatenation then throws "cannot convert symbol to string", so guard with `typeof v === "symbol"`.
  - **Fonts:** load them before editing text. Text styles' fonts are not enough when a node has its own `fontName`, so call `await figma.loadFontAsync(t.fontName)` per node.
  - **Variable-bound paints:** build them with the variable's resolved colour as the base (`setBoundVariableForPaint({type:"SOLID", color: resolvedValue}, "color", v)`). A black base can render black, even though the binding is correct.
  - **Paint opacity on a bound fill:** it only sticks if you re-assign the existing fills. Even then it can render fully opaque inside instances, so use layer opacity (`node.opacity`) for anything translucent.
  - **Auto-layout sizing:**
    - Call `resize()` before setting auto-layout sizing modes.
    - Switching a frame to auto-layout discards an earlier `resize()`: set `layoutMode` and the sizing modes first, then resize.
    - A card cloned from a wider card keeps its old outer width. Set the outer frame to hug (`primaryAxisSizingMode`/`counterAxisSizingMode = "AUTO"`), or you get a strip beside the inner panel.
    - A wrapped row only wraps if its parent chain is fixed or fill width. Its container must hug its height, or the second row is clipped.
  - **Instances:** resizing a child layer inside an instance can be silently ignored (the top bar's tab slots stayed 120 px). Change the main component instead.
  - **Cloned bindings:** any cloned layer (vector or text) keeps its node-level `boundVariables.fills` and `boundVariables.strokes`. These override a rebound paint, so the clone keeps its old colour or renders near-black. Create a fresh node rather than recolouring the copy.
  - **Uploads:** an `upload_assets` POST can return `success` with an `imageHash` but no `placedOnNodeId`. The image was stored but never applied. Set it yourself (`node.fills = [{type:"IMAGE", imageHash, scaleMode:"FILL"}]`), then confirm the fill hash changed.
  - **Image effects:** effects on an image-filled rectangle apply to the rectangle's bounds, not the sprite's pixels, so they draw a box. Bake outlines into the PNG.
  - **Screenshots:**
    - `get_screenshot` of a node inside a clipping parent renders only the visible part. Clone large maps into a top-level review frame.
    - A panned world view must sit inside its own clipping viewport, or it draws outside its bevel frame.
  - **Doc pages:** dark doc pages need a dark page background, or light doc text is invisible on the canvas.

## Validation

- **Contract.** Component tests in `web/tests/` mock `../lib/api` (the existing pattern in `overview.test.tsx`). Render with fixture data covering every state. Assert that each displayed value comes from the fixture and that nothing appears when a field is absent (for example, no performance panel while `performance` is `null`).
- **Visual.** Run the web app (`npm run dev` in `web/`, port 3100, with the API on 3000). Screenshot each state at 1920 × 1080, 1440 × 900 and 1280 × 800, and compare with the Figma frames and their laptop variants. Below 1280 × 800 is not designed (`screens.md`).
- **Accessibility.** Check keyboard focus is visible on every control (`:focus-visible` → the cream ring). Check text contrast against the measured rules in `visual-language.md`, and that `prefers-reduced-motion` freezes sprites.
- **Before writing Next code,** read `web/AGENTS.md`: Next 16 / React 19 differ from older conventions, and the docs are in `web/node_modules/next/dist/docs/`.

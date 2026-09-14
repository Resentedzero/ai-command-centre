# Design-to-code workflow and Figma

## Sources of truth

| Question | Source |
|---|---|
| What the platform does, what data and states exist, what the operator may control | Spec → API routes → `web/lib/api.ts` |
| How it looks: layout, components, variants, tokens, interaction and responsive behaviour | Figma, once a file exists (see `design-decisions.md` D5). Until then, this skill. |
| How it is built | React/Next.js in `web/`, mapped to real read models |

Figma never adds runtime behaviour. A frame showing a feature the API lacks is built only in its mapped form (`runtime-truth.md`), and the gap is logged as a proposal.

## The workflow

1. **Runtime.** Read the read models this screen uses in `web/lib/api.ts` and the routes behind them. List the states that can occur.
2. **Purpose.** Write the operator question (`screens.md`).
3. **Hierarchy.** Split content into act now / working / detail on demand.
4. **World composition.** Decide what rooms, corridors, hub and objects mean on *this* screen.
5. **HUD layer.** Place telemetry and controls around or inside the world. Each value names its source.
6. **Primitives.** Reuse or define components (list below) before drawing anything bespoke.
7. **States.** Draw every state the runtime can produce for each primitive, plus loading, empty, error and SSE-offline states. Draw no others.
8. **Figma.** Capture or refine the frames, components and variables. Get operator approval on the frame.
9. **Implement.** Build the approved frame in `web/`, component by component.
10. **Validate.** Check it against the frame visually, and against the API contract in tests.

## Keeping Figma and code in step

- **Variables ↔ CSS custom properties, same names:** `--state-active` ↔ `state/active`. Colour, spacing, radius, type scale and motion durations are all variables.
- **Components ↔ React components, same names;** variants ↔ props. Variant values come only from the runtime vocabularies in `runtime-truth.md`: `AgentRoom` with `state=active|awaiting_approval|failed|…`, never a made-up `state=thinking`.
- **Initial primitives:**
  - World: `WorldViewport`, `Room`, `Corridor`, `Hub`, `AgentSprite`, `Station`, `StateSigil`, `StopBarrier`
  - HUD: `HudPanel`, `SectionLabel`, `TelemetryRow`, `UnitGauge`, `StatusLabel`, `CommandButton`, `Inspector`, `EventRow`, `ConnectionIndicator`
- **Built in Figma** (Components page of the D5 file):

  | Component | Figma node | Variants / properties | React |
  |---|---|---|---|
  | `StatusLabel` | `10:2` | `state` = pending, active, executing, awaiting_approval, completed, failed, in_progress, paused, approved, rejected, expired, stopped; `Label` (TEXT) | `<StatusLabel state="…" />` |
  | Tiles (approved cuts) | `24:2` | 34 image frames at 4×, named exactly like `tile-slices.json` slices, grouped by category | Source art for world components (not a component itself) |
  | Map scale 2× (source art) | `29:2` | The same 34 tile cuts plus `sprite/<character>-<pose>` for all 9 poses, at 2× (tile 96 px). Used on map screens (D9). | Source art (not a component itself) |
  | Sprites (source art) | `15:2` | Knight, Rogue and Wizard idle frame 1 at 4× | Source art (not a component itself) |
  | `AgentSprite` | `20:20` | `character` = knight, rogue, wizard (identity from the agent id hash, never a role); `pose` = idle, run, death, chosen from runtime state (see `tile-pack.md`); 256×256 cell with a bottom-centre anchor | `<AgentSprite character={identityFor(id)} pose={poseFor(taskStatus)} />` |
  | `Room` | `30:154` | 4× close-up, 512×672. `state`:<br>• pending: dim, closed door, no agent<br>• active: blue lamps, open door, run<br>• awaiting_approval: closed door, amber seal, idle<br>• paused: dim, amber seal, idle<br>• completed: green lamps, idle<br>• failed: red lamps, portcullis, death<br>• stopped: as failed plus bars, idle<br>`Agent` (TEXT) holds the Agent Definition name. Nests AgentSprite, StateSigil and StatusLabel. Identity is set through AgentSprite `character`, not a variant. | `<Room state={roomStateFor(task, run, activeStop)} agent={name} />` |
  | `StateSigil` | `27:14` | `state` = active, completed, failed (pack runes `sigil/rune-*`, 192×256 at 4×); awaiting_approval (designed amber seal and hourglass over unlit `floor/teal`); paused (dimmer seal with hold bars). No `pending` variant, because a pending room has no sigil. | `<StateSigil state="…" />`, always next to a `StatusLabel` |
  | `CommandButton` | `14:42` | `action` = approve, reject, stop, lift-stop, start-goal (the API's only commands); `state` = default, busy (request in flight, disabled); `Label` (TEXT) | `<CommandButton action="approve" busy={acting} />` |
  | `ConnectionIndicator` | `12:17` | `connection` = live, reconnecting, offline (the SSE state from `subscribeToActivity`; not system health); `Label` (TEXT) | `<ConnectionIndicator connection="live" />` |
  | `UnitGauge` | `11:18` | `limit` = known (bar only when `limitAmount` exists) or none (numbers only); `Unit`, `Consumed`, `Reserved`, `Limit` (TEXT) | `<UnitGauge unit consumed reserved limit? />` |

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
- Exported sprite art comes from the Tile Pack (`tile-pack.md`), not re-exported from Figma, so pixels stay exact.
- **Putting sprites into Figma:** Figma smooths scaled image fills, so pre-scale outside it.
  1. Crop the frame from the strip, using sizes from the `.aseprite` header.
  2. Scale it by a whole number with nearest-neighbour (e.g. System.Drawing `InterpolationMode.NearestNeighbor` plus `PixelOffsetMode.Half`).
  3. Create target frames at exactly the scaled size.
  4. Call `upload_assets` with `nodeIds`.
  5. POST each PNG by absolute path (`curl -F file=@<abs path>`). The URLs are single-use and expire in 10 minutes.
  6. Screenshot to confirm.

  Never resize the frames in Figma afterwards. The first three (Knight, Rogue and Wizzard idle frame 1 at 4×) are in "Sprites (source art)" on the Components page. The 34 approved tile cuts (`tile-slices.json`) are in "Tiles (approved cuts)" on the same page. Each is a 4× image frame named exactly like its slice, grouped by category. Build world components from these, never from re-cropped atlas art.
- **Figma API gotchas learned here:**
  - Paint opacity on a variable-bound fill only sticks if you re-assign the existing fills (`node.fills = node.fills.map(p => ({ ...p, opacity }))`). Even then, it can render fully opaque inside instances and nested components, so for anything translucent inside a component set layer opacity (`node.opacity`) and leave the paint at 1.
  - Call `resize()` before setting auto-layout sizing modes.
  - Any cloned layer (vector or text) keeps its node-level `boundVariables.fills` and `boundVariables.strokes`. These override any paint you rebind, so the clone keeps its old colour or renders near-black. When a clone needs a different colour, create a fresh node rather than recolouring the copy. This applies to glyphs from components and to text in cloned HUD strips.
  - Run `use_figma` edits one at a time.
  - An `upload_assets` POST can return `success` with an `imageHash` but no `placedOnNodeId`. When that happens the image was stored but never applied. Set it yourself in `use_figma` (`node.fills = [{type:"IMAGE", imageHash, scaleMode:"FILL"}]`), then confirm the fill hash changed.
  - Effects (drop shadow, glow) on an image-filled rectangle apply to the rectangle's bounds, not the sprite's pixels, so they draw a box. Outline a sprite by baking it into the PNG, or with a separate shape underneath.
  - A `use_figma` script that throws is rolled back completely, so re-run the whole script, not just the part after the error.
  - `get_screenshot` of a node inside a clipping parent renders only the visible part. To review a large scrollable map, clone it into a top-level review frame.
  - Dark doc pages need a dark page background, or light doc text is invisible on the canvas.

## Validation

- **Contract.** Component tests in `web/tests/` mock `../lib/api` (the existing pattern in `overview.test.tsx`). Render with fixture data covering every state. Assert that each displayed value comes from the fixture and that nothing appears when a field is absent (for example, no performance panel while `performance` is `null`).
- **Visual.** Run the web app (`npm run dev` in `web/`, port 3100, with the API on 3000). Screenshot each state at desktop and about 400 px width, and compare with the Figma frame.
- **Before writing Next code,** read `web/AGENTS.md`: Next 16 / React 19 differ from older conventions, and the docs are in `web/node_modules/next/dist/docs/`.

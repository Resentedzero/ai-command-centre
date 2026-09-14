# Reference images: what to take, and what not to take

The images live in `assets/References for Ui/`. They are untracked and intentionally not committed (D2). If they're missing, work from this file.

They are **style references only**. Their agents, roles, metrics, tabs, graphs and numbers are illustrations, not requirements. Content comes from `runtime-truth.md`.

## `Reference-for-ui-image1.jpg`: mission control over a dungeon (primary)

**Take:**
- The world dominating the centre, with lit rooms around a glowing hub
- Coloured room light as identity
- Floating name plates over characters
- A narrow left roster and right inspector framing the world
- Thin top telemetry strip; bottom world tools (zoom/pan/layers); a small legend
- Near-black panels with hairline borders
- The warm-torch plus cyan-tech lighting contrast

**Don't take:** 12 or 16 agents, role names, "Tokens" beside "USD" in one bar, "System Healthy", the level selector as progression, model names, file-editing activity, sub-task counts. Mappings are in `runtime-truth.md`.

## `Reference-for-ui-image-6in1.jpg`: six screens, one language

**Take:**
- Proof that screens can share a language while changing composition
- Dense list-plus-inspector patterns
- Timeline density for events
- Progress treatment on goals

**Don't take:**
- Its near-identical layout on every tab. Our screens diverge (`screens.md`).
- The branching workflow graph (ours is linear)
- Sub-goals
- The code-viewer artifact screen and its tags, versions and download (no API)
- Card-grid agent lists, which drift toward generic SaaS

## `Reference-for-ui-image2.jpg`: pixel-art GUI kit

**Take:**
- Chunky pixel framing, slot grids and header ribbons
- Pixel display lettering
- Readable pixel icons at whole-number scale

These are used **inside the world only**: room name plates, station sigils, artifact shelves.

**Don't take:**
- Parchment and wood panels as HUD chrome
- Stars, score, win/try-again screens, inventory and equipment metaphors, crafting UI
- The daylight farm palette

## Adding references

Add an image to the same folder, then add a section here with **Take** and **Don't take**. An image without that section is not used.

# Design review log

Each refinement cycle runs: observe → independent critic sub-agent → reconcile → refine → re-compare. This log records what the critic found, what was accepted or rejected and why, so implementation doesn't have to reverse-engineer intent.

## Reference grammar (what we translate, not copy)

1. **Light is the information.** Rooms are pools of saturated light in near-darkness. Lit means working; dark means quiet. The core is the brightest thing on screen.
2. **Radial composition.** Everything relates to a glowing core; corridors are spokes.
3. **Rooms are dense workshops.** The environment tells the story; the character is small but lit.
4. **Labels float in the world.** Glowing name tags sit over the thing they name, in its light colour. No caption strips.
5. **The HUD frames the world and never covers it.** Rails on the edges; world tools (minimap, legend) sit at the world's edge.
6. **Depth through contrast:** wall height, light falloff, edge vignette. No drop shadows.
7. **One accent per meaning:** cyan = system core, warm torchlight = ambience (small and faint so it never reads as amber state), state hues reserved for state.

## Cycle 1 (2026-09-14): Overview

**Critic's top findings (ranked):**
1. No lighting model; the world is evenly lit like a tile-set demo.
2. Hub is a vector disc.
3. System rooms read as a SaaS card row with caption strips.
4. Daylight wilderness clashes with the mood.
5. API field-path placeholders hijack the hierarchy.
6. Design notes rendered inside UI frames.
7. Agents hard to find.
8. Square rune glows and a vector selection box.
9. HUD too generic.
10. Goals world is wallpaper.
11. Pending approval shown blue.
12. Raw snake_case in chips.

**Accepted and applied:**
- **Lighting layer** over the keep: darkness at 55% plus three-step, hard-edged light pools snapped to the 8 px grid.
  - Pool colours come from real state: Researcher active is cyan, Publisher awaiting_approval is amber.
  - The Approvals seal glows, with an amber spill into the corridor.
  - The runtime core is the brightest cyan.
  - Cyan conduits run from the hub along the corridors.
- **Lit actors layer:** agent sprites, the seal and a new core crystal sit above the darkness, so characters read like the reference.
- **Floating in-world tags** replace the room caption strips. They are bordered in the state colour for agents and amber for Approvals.
- **Pixel corner brackets** replace the vector selection box. The 2× rune glow was removed.
- **Wilderness** night-graded at 58%, with small warm lamp pools. The minimap is dimmed.
- **Gated labels** (Registry, Cost) removed from the live map; those houses are now scenery.
- **Inspector** field-path values replaced by skeleton bars, and in-frame spec text removed.

**Rejected:**
- **Characters at 3× on the 2× map.** Mixed pixel scales break the world's consistency, so lit pools and tags solve findability instead.
- **Deleting the wilderness.** The operator approved it (night grade instead).

**Deferred:** HUD chrome (emblem, highlight, active-tab glow), Goals war table, display labels for states, the amber approval-pending label, and in-frame notes on other screens.

## Cycle 2 (2026-09-14): three directions and a varied-room world

The operator made sci-fi optional ("the dungeon/village is the computer"), allowed varied rooms with their own architecture and mood, opened every pack regardless of licence (D18), and allowed asset adaptation. Three directions were built on one composed "varied rooms" keep (`assets/gamification/adapted/`) and judged by an independent critic against the references.

**Critic scores (1–10):**

| Direction | Distinctive | Cohesive | Immersive | Living computer | Not SaaS | Not forced | Faithful |
|---|---|---|---|---|---|---|---|
| A: pure pixel village/dungeon | **8** | **7** | **7** | 5 | **8** | **7** | 6 |
| B: pixel + subtle instrumentation | 5 | 5 | 6 | 6 | 4 | 6 | 6 |
| C: futuristic mission control | 5 | 4 | 5 | **7** | 4 | 3 | 7 |

**Verdict: Direction A, taking only the detail panel's information structure from B.**
- B reads as a SaaS dev tool with a game embedded in it.
- C's holo brackets frame empty void.
- In B and C, vector conduits break the pixel art, and the cyan core reads as a third active agent.

**Accepted (building "A2"):**
- **Lighting:** pixel-dithered light pools clipped inside room walls, replacing the vector ellipses. Ambient light is a dim neutral warm grey; amber is reserved for approval states.
- **Core room is the heart:** an 8× crystal recoloured pale silver, never agent cyan, with rune channels carved from the core along the halls. The channels light only on real activity.
- **One continuous building:** dark stone ground, full-width halls with candles, an outer wall ring, a south gate. The map pans (D16).
- **Chrome:** pixel bevel frames (2 px outline plus highlight, square corners) for the bar, tags, board and buttons, with B's lineage rows on a parchment inset.
- **Event ticker** as a notice-board strip.
- **Text:** no duplicate tag text; "Live", not "Live telemetry".

**Rejected:** agents one scale step larger (3× on a 2× world) was proposed again and rejected again. Mixed pixel scales break the art. A ground shadow, light and an anchored tag do the job.

**Legibility call:** Pixelify for chrome, titles and labels; a mono face for raw state tokens and long reading text (Approvals, Events), because Pixelify is unreadable in dense passages.

**Varied rooms versus uniform rooms:** room identity is clearly better (library, council hall, war room, forge, vault). Composition was worse as a 3×3 grid floating in void, which is now fixed with the continuous building.

## Cycle 3 (2026-09-14): A2 critique, building A3

**Critic scores, A → A2:**

| Criterion | A | A2 |
|---|---|---|
| Distinctive | 6 | 7 |
| Cohesive | 5 | 8 |
| Immersive | 5 | 7 |
| Living computer | 5 | 6 |
| Not SaaS | 7 | 7 |
| Not forced | 4 | 7 |
| State at a glance | 6 | 7 |

The critic judged lighting and chrome technique to be at diminishing returns, and named one big change left: a night value pass plus a non-grid layout.

**Accepted and applied in A3** (frame "Direction A3", `compose-keep-v4.ps1`):
1. **Night keep:** darkness at 68%, no ambient pools in stateless rooms. State light is the only bright thing.
2. **Agent contrast:** a 1-logical-pixel dark outline baked into every 2× sprite (`adapted/sprites-outlined-2x/`), plus ground shadows. It was a contrast problem, not a scale problem.
3. **Honest skeletons:** grey bars under "consumed" and "reserved" looked like half-full meters, which is visually fake data. They became "…" glyphs.
4. **Dashes mean approval only:** the core's dashed ring became a groove of 4 px silver rune glyphs every 32 px.
5. **Tighter layout:** a larger command room (240×176 source), 24 px halls, 16 px rim. The whole keep and every room carrying state is visible in the default viewport.
6. **Crystal at 2×:** the 8× crystal broke the scale rule, so it became a hand-drawn faceted 2× crystal on a pedestal (`core-crystal-pedestal-2x.png`).
7. **Plaques** anchored to each room's top-wall line, and notice-board events became pinned parchment tabs.

**Rules for other screens (from the critic, accepted):**
- No Pixelify for body text, ids, JSON or diffs.
- Long reading goes on dark vellum, not cream parchment (glare). Parchment is for headers and summary cards.
- Never put readable content over the map or its light.
- Events is a real sortable log with state markers, plus at most a small keep thumbnail.
- Goals lineage is a real list or tree; the war room only frames it.
- Everything stays at whole-number 2× (4× only in dedicated close-ups).

**Deferred as motion spec:** sprite loops while working, a channel pulse on live activity, and a brief room flash when an event for that room arrives.

## Cycle 4 (2026-09-14): A3 critique, building A4

**Critic scores, A2 → A3:**

| Criterion | A2 | A3 |
|---|---|---|
| Distinctive | 7 | 7.5 |
| Cohesive | 6 | 7 |
| Immersive | 6.5 | 7 |
| Living computer | 6 | 7 |
| Not SaaS | 6 | 6 |
| Not forced | 6 | 7 |
| State at a glance | 7 | 8 |

**Verdict:** the map is nearly done. The last high-impact change is making the chrome match the world.

**Accepted (A4):**
1. **Non-state light removed.** Hall candle halos and the forge glow broke "light = real state". The halos are removed, and the forge fire is dimmed to embers in the composite.
2. **Minimap card removed** (redundant now that the whole keep is visible). A framed 4× portrait of the selected agent replaces it.
3. **Stronger card chrome:**
   - Cards get wood header tabs and a 2 px shadow bevel.
   - Skeletons sit inline after their label ("· · ·" in ink).
   - The active nav item is a bevelled tab.
4. **Core rune dots replaced.** The dots read as runway lights, so there are now four faint cross glyphs inside the command room only.
5. **Command room floor shifted teal → slate,** so cyan stays unique to "active".
6. **Letterbox gutters filled.** The keep is 1440 px wide, with rampart columns in the rim. The notice board uses pinned, staggered notes.

**Rejected:** none. All six findings were concrete and rule-consistent.

## Propagation (2026-09-14)

The pure-pixel language is applied to:
- **Agents:** the 4× workshop close-up, a roster board with 2× portraits, and a two-column board of tabbed parchment and vellum cards.
- **Approvals:** reading-first. A 2× council-hall vignette with amber light, seal and wizard; parchment request and artifact cards; vellum panels for the preview and JSON snapshot; bevelled Approve (dark green) and Reject (dark red).

A cross-screen cohesion critique (cycle 5) is judging Overview A4 with Agents and Approvals before the remaining screens are built.

## Cycle 5 (2026-09-14): cross-screen cohesion (Overview, Agents, Approvals)

**Critic scores:**

| Screen | Fits language | Composition | World presence | Legibility | Not SaaS |
|---|---|---|---|---|---|
| Overview | 8 | 7 | 9 | 7 | 8 |
| Agents | 7 | 5 | 7 | 7 | 5 |
| Approvals | 6 | 7 | 6 | 6 | 5 |

**Verdict:** mostly one product. Stop the loop after these fixes, then do one quick pass.

**Accepted and applied** (frames "Overview A5", "Agents v2", "Approvals v2"; component `PixelTopBar`):
1. **Fake state and notes-to-self removed from UI:**
   - A green "content matches" chip showed with no data; it is now a neutral hash-check skeleton.
   - Resolved rows showed invented statuses; they are now neutral status skeletons.
   - All design notes rendered as copy are gone.
2. **One approval, one place.** An agent awaiting approval stands on the council-hall seal and its workshop goes dark; its plaque keeps the amber marker.
3. **Fixed nav.** A shared `PixelTopBar` component with fixed 120 px tab slots, including Artifacts. The chips are text properties.
4. **Navy void only inside bevel-framed world views.** Reading areas sit on wood.
5. **Green/red rule written down:** decisions and controls only, never world light. "No stop" is neutral ink.
6. **Chrome consistency:**
   - A bevel frame on every world view.
   - A global full-width notice strip.
   - "· · ·" everywhere.
   - A marker on Stop.
   - A big name heading on Agents.
7. **Per screen:**
   - **Overview:** the stateless entrance is dimmed; recent events fill the board with Stop at the bottom.
   - **Agents:** a single ordered board (lineage full width, then parchment summaries and wood lists).
   - **Approvals:** the vignette is aligned with the request card, and the artifact strip is full width.

**Modified:** "hide the Resolved group until real rows exist" became neutral skeleton rows, so the layout's structure stays documented without claiming statuses.

**Rules for the remaining screens (from the critic, accepted):**
- **Workflows:** a corridor of step rooms lit by step state, with wood reading below.
- **Goals:** one war-room table with a banner per goal, a medium vignette and parchment summaries.
- **Events:** almost no world (a thin scribe strip at most); a full-width, dense wood mono log.
- **Artifacts:** chests in a grid, one per artifact, lit or gated by state; opening one shows a wood reading panel.

**Lesson:** Warm torch pools must be tiny and faint. At normal strength they read as amber `wait` state and flood the map with noise. Light only real torches and lanterns, never candles or props.

## Final quick pass (2026-09-14): all seven pixel screens

**Critic scores:** Overview 8, Agents 8, Workflows 6, Goals 6, Approvals 9, Artifacts 6, Events 8. **Verdict:** close; one short pass on consistency bugs.

**Accepted and applied:**
1. **One state per screen set.** Workflows showed Publisher active in a cyan Step 2 while Overview and Approvals showed it awaiting approval on the seal. Step 2 is now unlit, empty, with an amber "awaiting approval" plaque.
2. **Loading shows no sample data.** Real event-type names beside skeletons read as data; every loading event row is now "· · ·" with a dimmed neutral marker, so grey means only "not loaded".
3. **Notes-to-self removed:** the "GET /artifacts/:id" tab title and "goals (capped 500 → 500+)". The cap rule lives in `runtime-truth.md`, not in copy.
4. **Bevel frames** on the Overview keep and the Workflows corridor.
5. **Goals warning** is label ink, not amber (amber means waiting).
6. **Big name headings** on Goals and Artifacts, matching Agents.
7. **Artifacts vault:** 4 chests, matching the 4 listed outputs (one per artifact).

**Loop stopped: diminishing returns.** Remaining work is promotion and implementation, not direction.

## Promotion and state frames (2026-09-14)

The final pixel screens moved to the `04 — Screens` pages; the sci-fi frames are marked superseded. Seven state frames were built from clones: Overview (offline, no active agents, loading, load failed), Agents (execution stop active), Approvals (nothing pending), Workflows (step failed).

**Critic scores (first draft):** offline 5, no agents 5, loading 6, load failed 4, stop 4, approvals empty 7, workflow failed 4. **Verdict:** one more pass.

**Accepted and applied:**
1. **Rationale and notes-to-self removed from copy** ("returned no rows", "an unlit room would claim…", seal lore). Copy is for the operator: "Nothing is running. Start a goal to run a workflow."
2. **Recovery controls:** Reconnect (offline), Start a goal (no agents), Retry (load failed). They are neutral wood buttons, because recovery is not a destructive control. "Lift stop" is neutral for the same reason.
3. **One SSE label per state.** Offline says offline; stale light from the last REST load is dimmed to 45% while the feed is down.
4. **Stop is a real state.** `activeStop != null` renders "stopped" with a red marker (stop is a control state), and the stop strip is ink on parchment with scope, reason and time as skeletons.
5. **No fixed outcome text in templates.** Invocation rows said "started → completed", which contradicted a failed step; they now say "started → ended". The failed row carries the red marker.
6. **Cyan only means active.** The selected-run border is cream. The Researcher workshop floor was teal in the composite, so an unlit room looked active: the compositor now shifts it to slate (like the command room) and dims the pale Publisher stone. The 4× close-up is recoloured selectively (teal pixels only).
7. **Artifacts plaque "gated" removed:** no API source.

**Rejected:**
- Inspector and resolved-row skeletons: these frames are templates, so skeletons stand for API values.
- Disabling Stop while offline: commands go over REST, not SSE.
- Run budget "limit": `run.budget.limitAmount` is real.

**Finding for implementation:** `subscribeToActivity` exposes no connection status, so the connection chip has no client source yet (recorded in `runtime-truth.md`).

## State frames: Goals, Events, Artifacts (2026-09-14)

Seven more states: Goals (no goals yet, start goal failed), Events (feed reconnecting, no events received), Artifacts (content hash mismatch, artifact not found, agent has no outputs).

**Critic scores:** goals empty 7, goals fail 6, events reconnecting 5, events empty 7, hash mismatch 7, not found 5, no outputs 6. **Verdict:** one more pass.

**Accepted and applied:**
1. **One connection state per screen.** On the reconnecting frame the top-bar chip reads "Reconnecting" (neutral) to match the header; it had stayed green "Live".
2. **Routes and status codes are detail, not the message.** "Couldn't start the goal." and "This output's artifact wasn't found." are the messages; `POST /goals · · ·` and `GET /artifacts/:id · 404` sit on a dim detail line under them.
3. **Recovery controls, neutral:** "Refresh goals" after a failed `createGoal` (it is non-idempotent, so refresh comes before any retry) and "Retry" on not found.
4. **Operator words, not field names.** Event column headers read time / type / summary / cursor. The reconnect line is ink on parchment; the empty-log message is padded to the columns.
5. **Known empties are values.** The no-outputs frame shows "outputs 0" and names the agent ("Researcher's vault is empty"); the not-found frame keeps the selection bracket on the chest that is still selected.

**Rejected:**
- The "Start a goal" tab reading as a button: it is the shared tab style on every board.
- Keeping typed values after a failed `createGoal`: the inputs are client state and the frame is a template.
- "Produced by" on dark vellum and the lower panels cut off at the frame edge: both belong to the approved base Artifacts screen, not to its states. Revisit in implementation.

## Registry and Cost in pixel, Artifacts cleanup (2026-09-14)

Gated screens redrawn in D19 from real read models only. **Registry** (read-only armory): `AgentDetail.grants`, one key per grant, no autonomy or revoke controls. **Cost** (ledger): run budget counters per `resourceUnit` and per-agent `budgetTotals`, never summed, no scope totals. Neither has a top-bar slot; they are reached from Agents and Workflows. Artifacts base: the reading panels end above the notice strip, and "Produced by" became a short parchment card.

**Critic scores:** Registry 6, Cost 4, Artifacts 6. **Verdict:** one more pass.

**Accepted and applied:**
1. **Light matches state.** The Registry room is the Researcher's workshop, and the roster says active, so its cyan light is restored.
2. **Keys map to cards.** Keys carry tags 1 and 2, cards are titled "Key 1 · capability …", and the cards fill the column.
3. **Skeletons are never bars.** Cost's empty gauge tracks are removed; a gauge appears only with loaded values.
4. **Every pixel screen has a room.** Cost gets a small bevel-framed engine-room view: the forge burns fuel, which reads as consumption without claiming any value. The cards widen, and the footer states the gap plainly.
5. **No dev notation.** "invocation (kind · #seq)" became "invocation".

**Rejected (Registry/Cost round):** putting Preview and Referenced-by on parchment. The rule is parchment for short summaries and dark wood for lists and long reading, so the short parchment "Produced by" card next to two wood panels is correct. The dead band under the Registry room comes from the approved Agents layout.

## Contrast audit (2026-09-14)

Measured WCAG ratios for every pixel text token against wood-dark, wood, parchment and void, then audited the live frames on the `04` pages by script. The script walked each text to the surface it sits on and blended its effective opacity.

**Palette findings:**
- On wood and void, everything passes AA: label 13–16:1, label-dim 5.1–6.2:1, state colours 5.3–10.1:1.
- On parchment, only ink passes (8.0:1). State colours are 1.2–1.8:1 and light labels 1.4–1.9:1.

**Fixed in Figma:**
1. **State-coloured words on parchment → ink** (3 texts): "in progress" on the Workflows run header and on Cost, "failed" on the Workflows failed state. The outlined marker keeps the colour.
2. **Translucent text raised to ≥ 4.5:1** (67 of 127 checked):
   - 59 ink skeletons on parchment went from 55% (2.8:1) to 80% (5.1:1);
   - 8 light labels on wood went from 4.3:1 to 80%.
   - The other 60 already passed.

**Rule added to `visual-language.md`:** ink is the only text colour on parchment; state on parchment is marker plus ink word; translucent text must pass after blending; wood-edge is never text. Two stale lines were corrected at the same time: "parchment holds anything you read" (it contradicted the vellum rule) and "HUD panels stay sci-fi" (retired in D19).

**Not audited:** the experiment trail on page `05`, and graphic-only markers. A marker's 2 px outline gives it its edge contrast.

## Laptop sizes (2026-09-14)

Built "@1440×900" and "@1280×800" variants of Overview (world-first) and Approvals (reading-first), measured them by script, then checked screenshots.

**Found and fixed:**
1. **Top bar overflow.** Its minimum width is 1471 px, so it didn't fit at 1440 or 1280. Hiding the title and keeping the crystal emblem brings it to 1223 px. Narrowing the 120 px tab slots through instance overrides didn't apply, and isn't needed.
2. **Stop below the fold.** On the Overview board, Stop was the last item (bottom at 874 px), so a shorter screen cuts it first. It now sits directly under the agent heading at every size.
3. **Board overflow on Overview @1440×900** (874 px of content in 844). The 4× portrait is dropped below 1080 px tall, since the room shows the sprite and the heading names the agent. Content is now 712 px and fits both 844 and 744.
4. **Approvals reading area.** It became a vertical stack with wrapping rows. It first came out 926 px tall, because switching to auto-layout discarded the earlier resize; the size is now re-applied after the layout change.
5. **Hash check below the fold at 1280×800.** "What it will act on" carries the hash check, the signal that approving will fail. It sat under the action bar. The request card now hugs its content (it had about 80 px of empty padding) and the stack gap is 16 px, so the hash row ends at 602 px of 604 and only the strip's bottom edge scrolls.

**Rule recorded in `screens.md`:** world-first screens pan and narrow their board; reading-first screens stack and scroll with act-now controls pinned; the safety-relevant signal (Stop, hash match) stays above the fold. Below 1280 × 800 is not designed.

## Interaction states (2026-09-14)

Every pixel control had only a resting look: no hover, pressed, keyboard focus or disabled treatment. Built from the existing bevel styles as component sets on `03 — Components`:
- **PixelButton:** neutral, danger and approve, each in default, hover, pressed, focus and disabled (15 variants).
- **PixelTab:** inactive, hover, active, focus.
- **PixelPlaque:** default, hover, selected, focus.
- **PixelInput:** default, focus, error, disabled.

**Decisions:**
1. **Focus is a 2 px cream ring in a reserved slot.** Every variant carries the transparent slot, so focusing never shifts layout. Cream is 14:1 on wood-dark and visible on every surface.
2. **Pressed keeps the outer size;** the label drops 2 px inside.
3. **Disabled carries no state colour.** A disabled Stop or Approve must not look armed: wood-dark fill, wood-edge border, label-dim text, marker at 50%.
4. **Selection is cream, never a state colour.** Applied to the live Approvals frames: the selected pending row had an amber edge that doubled its amber marker, and now has a cream edge with the marker kept. The selected Workflows run already used cream.
5. **Input error** is a red edge plus a red message on wood (5.3:1). Focus is an ink edge plus the ring.

**Verified:** screenshots of all four sets and the Approvals screen.

**Follow-up for implementation:** `PixelTopBar` still draws its slots directly. When built, its slots should use `PixelTab`, so the top bar gets hover and focus.

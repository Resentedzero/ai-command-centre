# Implementation review (design QA for CLI1)

Design QA notes on the `web/` implementation of the D19 pixel UI. Each finding names the file, the design source, and a concrete fix. Findings are **recommendations for the implementer**: the reviewer does not edit `web/` code.

Severity:
- **High:** breaks a rule from `visual-language.md` or `runtime-truth.md`, or misleads the operator.
- **Medium:** a visible deviation from the Figma frames.
- **Low:** polish.

## Round 1 (2026-09-15): shared foundation, before the screens

**Reviewed (uncommitted work in progress):** `web/app/tokens.css`, `web/app/layout.tsx`, `web/lib/keep.ts`, `web/components/live.tsx`, `web/components/pixel/*`, `web/scripts/copy-world-art.mjs`, and the `web/lib/api.ts` diff.

**Faithful, keep as is:**
- **Tokens and fonts:** the pixel palette only, with no sci-fi tokens; Pixelify for titles, labels and buttons; JetBrains Mono for values (D4 as amended by D19).
- **Focus:** a 2 px cream outline at a 2 px offset, so the ring sits outside the bevel.
- **Reduced motion:** stops every animation, and sprites hold frame 1.
- **Skeletons:** "· · ·", at 85% ink on parchment (passes ≥ 80%).
- **Contrast:** ink is the only text colour on parchment (`.onParchment`, `.parchment .detail`).
- **Minimum size:** `body` keeps a 1280 × 800 minimum; the top-bar title hides at 1440 px wide or less.
- **Top-bar chips:** they show "n/a" when the API read fails, never a stale or invented number.
- **Notice strip:** offline and reconnecting get honest copy and a neutral Reconnect button.
- **Character identity:** comes from an id hash, and workshops are filled by the Agent Definitions the API returns, never by name.
- **Connection chip:** now backed by `onStatus`, which closes the gap in `runtime-truth.md`.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 1 | Medium | `components/pixel/topbar.module.css` `.tab`, `.tabActive` | Every tab is a bevelled box, and the active tab gets a brighter `wood-edge` fill. In Figma (`PixelTab` 132:125), inactive tabs are plain `label-dim` text with no box; only the active tab is a bevel (`wood` fill, `wood-edge` border, 2 px outline). Seven boxes make the bar read like a button toolbar. | `.tab`: no background, border or box-shadow (keep the 120 × 40 slot). Hover: `pixel/label` text plus a 2 px `wood-edge` underline 40 px wide. `.tabActive`: `background: var(--pixel-wood)`, `border: 2px solid var(--pixel-wood-edge)`, `box-shadow: 0 0 0 2px var(--pixel-outline)`, `color: var(--pixel-label)`. |
| 2 | High | `components/pixel/pixel.module.css` `.gaugeFill` | Consumed is filled with `--state-idle` (blue). `state-idle` means *pending or idle*, and a hue carries one meaning only, so a budget bar would read as a pending state. | Fill consumed with `var(--pixel-label)` (cream) on the `wood-dark` track. Keep reserved as the dim 2 px stripe. Colour a gauge only if the API ever returns an over-limit state; there is none today. |
| 3 | Low | `pixel.module.css` `.button:hover`, `:active`, `.plaque:hover`; `topbar.module.css` `.tab:hover` | Hover and pressed use `filter: brightness()`, which also brightens the outline, the edge colour and the text. Figma (`PixelButton` 132:109) changes only the fill. | Use explicit fills. Neutral: hover `#3A2618`, pressed `var(--pixel-wood-dark)`. Danger: default `#4A1510`, hover `#5E1C15`, pressed `#36100C`. Approve: default `#0F3A26`, hover `#145034`, pressed `#0A2A1B`. The current `color-mix` defaults are close; exact values match the frames. |
| 4 | Low | `components/pixel/PixelTopBar.tsx` Agents chip | The Agents chip carries a cyan "active" marker. In Figma the Agents chip is plain text: cyan is room light for a working agent, and the chip isn't a room. | Render `Agents {n}` without `StatusMark`. Keep the amber marker on Pending, and the green/neutral marker on the connection chip. |
| 5 | Medium | `lib/keep.ts` `STRIPS.wizard.death` | A failed wizard falls back to idle frame 1 because no outlined wizard death strip existed. | **Asset added by design:** `assets/gamification/adapted/strips-outlined-2x/wizard-death-strip-2x-outlined.png` (12 frames, 68 × 68 at 2×). Re-run `npm run world-art` (it copies the strips folder), then set `death: { src: "/world/strips/wizard-death-strip-2x-outlined.png", w: 68, h: 68, n: 12, ms: 100, once: true }`. |
| 6 | Medium | `lib/keep.ts` `WORKSHOP_SLOTS` | Only two workshop slots exist. With a third active Agent Definition, the third agent has no room, and a silent drop would hide real activity. | Until the keep has more workshops, render agents beyond the slots in a "More agents" list on the Overview board, each with its `StatusMark`, and log the gap. More workshops is a design task (a wider keep composition), recorded as D20 below. |

**API changes that widen the designs** (recorded in `runtime-truth.md` and `screens.md`):
- **`GET /registry`:** the armory can list every Agent Definition and grant, not only active agents.
- **`GET /costs`:** the ledger may show API-summed totals per (scope, unit) for run, task instance, agent definition, goal and day. Use one card per unit, and never add across units.
- **`costVsSuccess` and `AgentDetail.performance`:** measurements only. Show `sampleCount` beside every rate, list in a stable order (definition name, then tier), and never sort by success, badge a winner or recommend.
- **`GET /execution-stops`:** a global or goal-scope stop exists as data. On the Overview, show an active global stop as a red barrier across the keep gate plus a board notice with its reason. Agent-scope stops stay on the Agents screen.

## Round 2 (2026-09-15): Overview keep, commit `fab8323`

**Status of round 1:** findings 1–5 are still present in the committed code. **Finding 6 is resolved:** `app/page.tsx` lists every active agent in the board roster, and a selected agent without a workshop gets an explanatory detail line.

**Faithful, keep as is:**
- **Council hall:** lit amber only while approvals are pending; waiting agents stand on the seal and their workshop goes dark (one approval, one place).
- **Runtime core:** its light and runes show only while the live feed is up.
- **Stale state:** lights dim to 45% while the feed is reconnecting or offline.
- **Stopped agents:** a barrier and a frozen sprite; Lift stop is neutral.
- **Stop placement:** directly under the selected agent's heading, with a confirmation step.
- **Honest states:** loading dots, empty with Start a goal, load failed with Retry, and refresh failed keeps the last read with an alert.
- **Counts:** capped lists show `100+` / `500+`, and unreadable ones show `n/a`.
- **Missing room flash:** documented in `web/design/overview.md` as an API gap (events carry no agent id), not faked.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 7 | Low | `components/world/world.module.css` `.plaque` | Keep plaques use 14 px Pixelify. `visual-language.md` sets Pixelify at 16 px or larger, since it breaks up below that at 1× pixel density. | Use `font: 16px/20px var(--font-pixel)` and keep `padding: 3px 8px`. The plaques are short, so the wider text still fits the rooms. |
| 8 | Low | `app/page.tsx` board | The 4× portrait is dropped at every width. Figma keeps it at 1920 × 1080 and drops it only below 1080 px tall (`screens.md`, laptop rules). | Optional: show the 4× portrait when the viewport is at least 1080 px tall. If it's skipped, record it in `web/design/overview.md` (partly done). |
| 9 | Low | `app/page.tsx` `AgentBoard` detail line | "This agent has no workshop in the keep: the keep has two, and they are taken." explains the implementation to the operator. | Operator copy: "No free workshop in the keep, so it's shown here only." |

| 10 | Low | `app/page.tsx` Goals plaque | When the goals read fails, the plaque reads "Goals n/a goals". | Show the neutral unloaded mark plus "n/a" (`<StatusMark state={null} />`, or "Goals · n/a"), and only append "goals" to a real count. |
| 12 | High | `app/page.tsx` Approvals and Workflows plaques | A failed read renders as loading: `pending === "error"` and `inProgress === "error"` both give `<StatusMark state={null} />`, which shows "· · ·". In the 2026-09-15 capture, the Workflows plaque sat on "· · ·" indefinitely while `GET /workflow-runs` returned 404. `runtime-truth.md`: an API failure shows an error state, never a loading or substitute state. | Keep `null` for loading only. For `"error"`, render the neutral mark plus `n/a`, as the Goals plaque and the top-bar chips already do. A `title` of "Couldn't read this from the API" is optional. |
| 11 | Medium (asset, fixed by design) | `assets/gamification/adapted/compose-keep-v4.ps1` | The command room's pit tile was composited without the slate shift, so a flat teal square sat under the runtime crystal and read as a block of cyan "active" light in the dark room. | Fixed in the compositor and regenerated `keep-v4-2x.png`. The seven Figma Overview frames that use the keep (main, four states, two laptop variants) were updated to match. **CLI1:** re-run `npm run world-art` to pick it up. |

**Review environment note for CLI1 (blocking real-data visual review):** the API process on port 3000 (pid 46752) was **started 2026-09-12 22:19**, before `GET /registry`, `/costs`, `/execution-stops`, `/goals` and `/workflow-runs` existed. On 2026-09-15 all five answered 404, though the routes exist in `src/api/routes`. The UI correctly showed "n/a" and stops-unreadable warnings. Restart the API before a visual review, so screenshots show real data rather than error states.

**API gap confirmed for CLI1** (don't fake it): the event-arrival room flash (`visual-language.md` Motion) needs the Agent Definition id, or a run id resolvable to one, on `EventDisplayItem`. Today only the notice strip reacts to events.

## Round 3 (2026-09-15): Agents and Registry, commit `440cf64`

**Status of earlier findings:**

| # | Status |
|---|---|
| 1 top-bar tabs as boxes | **Open.** `.tab` still has a background, border and outline on every slot. |
| 2 gauge fill uses `--state-idle` | **Open.** |
| 3 `filter: brightness()` hover/pressed | **Resolved:** fills shift with `color-mix`, and the outline and text are untouched. |
| 4 cyan Agents chip | **Resolved:** cyan only while a Run is `active`, neutral otherwise. That is light-as-state, so accepted. |
| 5 wizard death fallback | **Open.** The outlined `wizard-death-strip-2x-outlined.png` exists in `assets/gamification/adapted/strips-outlined-2x/`. Run `npm run world-art` and point `STRIPS.wizard.death` at it (`n: 12`). |
| 6 agents beyond the workshops | Resolved (round 2). |
| 7 plaque type size | **Resolved:** 16 px. |
| 8 portrait at 1080 tall | Open (optional). |
| 9 no-workshop copy | Open (low). |
| 10 "n/a goals" | **Open:** `count()` returns "n/a" and the plaque still appends " goals". |
| 11 pit tile | Fixed by design; CLI1 still needs to re-run `npm run world-art`. |
| 12 error rendered as loading | **Resolved:** a failed read shows "n/a". |

**Faithful in the new screens, keep as is:**
- **Roster:** lists every Agent Definition version from `GET /registry`, joined with active Runs and stops. With no unfinished Run it says "no active run" (neutral), and "state unknown" when the active read fails.
- **Workshop:** lit cyan only while a Run is `active`, dark and empty while `awaiting_approval` (the agent is at the council seal), and a barrier plus a frozen sprite when stopped.
- **Keys:** numbered to match their "Key n" cards; a revoked key is dimmed.
- **Stop:** under the name, and a waiting agent links to its approval.
- **Performance:** shows `samples` beside every rate, says it "ranks and recommends nothing", and a missing minimum-sample flag is documented as an API gap rather than invented.
- **Registry:** read-only, with no autonomy or revoke controls, and the read-only statement is on parchment.
- **Honest states:** not found (404), load failed, refresh failed, and every empty section.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 13 | Medium | `components/world/workshop.module.css` `.keyIcon` | The key sprite is 16 × 16 source, drawn at 48 px: **3×, inside a 4× workshop.** Mixed pixel scales in one view read as blurry or wrong, and the design rule is one whole-number scale per view (D9). | `width/height: 64px; background-size: 384px 64px` (4×). Space keys 88 px apart instead of 72, so the tags still clear. |
| 14 | Medium | `app/agents/AgentsScreen.tsx` (no `id`) | `/agents` with nothing selected drops the world (`noWorld`) and shows "Choose an agent". The Agents tab, the screen the operator reaches first, opens with no pixel world at all, which is exactly what makes it read like a SaaS list. | When the roster loads, select an agent: first one needing attention (stopped, then awaiting approval, then active), otherwise the first definition. Use `router.replace` to `/agents/:id`. Keep the "Choose an agent" notice only for an empty Registry. |
| 15 | Low | `app/registry/page.tsx` grant card | `scope {JSON.stringify(g.scope)}` shows raw JSON to the operator. | Render each scope entry as `key: value` lines in mono. For nested values, show the key plus "· · · (open raw)" in a `<details>`. |
| 17 | Medium | `app/agents/AgentsScreen.tsx` (no `id`) | When the roster read fails (captured 2026-09-15: `GET /registry` → 404), the roster shows "Couldn't load the roster." with Retry, but the detail pane still says "Choose an agent from the roster to see what it is doing." That points the operator at a list that isn't there. | When `roster.error && !roster.registry`, the detail pane shows nothing, or a dim line "The roster couldn't load; retry it on the left." Keep the Retry action in one place only. |
| 16 | Low | `app/agents/AgentsScreen.tsx` Performance table | Rows render in API order. `runtime-truth.md` asks for a stable, non-ranking order, so a reorder by success can't look like a leaderboard. | Sort by task definition name, then model tier, before rendering. Don't sort by `successRate`. |

## Round 4 (2026-09-15): independent visual critic on all routes at 1920, 1440 and 1280

**Capture:** headless Edge at exact viewport sizes, after a 7 s settle, on commit `440cf64`. The API was stale (see the environment note), so most reads showed their error states.

**Critic verdict: "drifting".** The Overview keep and the shared chrome match the direction (Overview 7/10). But at this commit six of nine routes show no world and no pixel chrome, which is expected mid-rollout:
- **Not built yet:** Workflows, Goals and Approvals are still the pre-pixel pages; Artifacts, Events and Costs have no route (Next.js 404).
- **Re-review:** these screens get reviewed when CLI1 rebuilds them, against their `04 — Screens` frames.

**Accepted from the critic:**

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 18 | Medium | `app/page.tsx` board, empty state | With nothing running, the board is one line plus a button above about 650 px of empty wood. A dead pane is what makes a screen read as a SaaS page. | Below the empty notice, list every Agent Definition from `GET /registry` as plaques ("no active run", neutral), each linking to its agent. That's real data and a path into the world. Keep Recent events at the bottom. |
| 19 | Low | `components/pixel/NoticeStrip.tsx` on the Overview | The notice strip and the board's Recent events show the same latest rows. | The strip pins only events worth noticing (`approval_required`, `*_failed`, `execution_stop_engaged`, `run_halted`, `artifact_created`), and the board keeps the full recent list. When nothing notable has happened, the strip shows the feed status line. |
| 20 | Low | `components/pixel/strip.module.css` at 1280 | The last note is cut in half at the right edge. | Render only the notes that fit whole: a `flex-wrap: wrap` strip with a fixed height and `overflow: hidden` drops the ones that don't fit, instead of slicing one. |
| 21 | Low | `app/registry/page.tsx` | When the registry read fails, Retry appears in both the roster and the main pane (extends finding 17). | One Retry, in the roster; the main pane shows a dim pointer to it. |
| 22 | Low (rollout) | `components/pixel/PixelTopBar.tsx` | The Artifacts and Events tabs lead to a black framework 404 until those routes exist. | Until then, add `app/not-found.tsx` in pixel chrome (a wood board: "This room isn't built yet." plus a link back to the Overview), so a missing route stays inside the keep. |

**Rejected, with reasons:**
- **"Scale the keep to fit 1440/1280 so every room stays visible":** pixel art only scales by whole numbers (D9), so the keep can't shrink to fit a laptop without blurring. The approved laptop rule is to pan to what needs attention (D16, `screens.md`), and plaques cut at the viewport edge are the cost of panning. The one real risk (the act-now room out of view) is already handled by the focus logic.
- **"The HTTP detail under the error message is dev-speak":** the rule is an operator message plus a dim detail line with the route and status (`visual-language.md`, cycle "State frames"), which is what `StateNotice` renders.
- **"/registry lights Agents, /costs lights Workflows":** decided in `screens.md` (screens without a top-bar slot light their parent tab).
- **Red raw error lines on Workflows and Goals:** these belong to the pre-pixel pages, which the rebuild replaces.

## Round 5 (2026-09-15): Workflows corridor and Cost ledger, commit `6a5b3a6`

**Status:** finding 2 (gauge fill in a state hue) is **resolved**: the fill is cream.

**Faithful, keep as is:**
- **Corridor:** a corridor of step rooms in graph order, panned and pre-selected on the step needing attention (failed, then awaiting approval, then active).
- **Light:** cyan only on an `active` step. A step with no Task Instance is dimmed and says "not started".
- **No invented sprite:** the run's agent carries no id to key identity on, and that is documented in `web/design/workflows.md`.
- **Step detail:** attempts, an invocation table with failure reasons and output links, one budget counter per unit (never combined), and the run trace on demand.
- **Cost:**
  - gauges drawn only for run counters, whose limit is enforced;
  - other limits shown "as stored";
  - totals are API-summed per (scope, unit), with copy saying scopes are never added together;
  - a scope filter;
  - "cost and success" labelled a measurement that ranks nothing.
- **No invented controls:** pause, resume and advance are not built (no design frame or §15.2 command covers them).

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 23 | Medium | `app/workflows/WorkflowsScreen.tsx` `Corridor` | Every step room is the same `room-v5-engine-2x.png` crop, so a multi-step corridor reads as one tile repeated, like a list. `visual-language.md` says rooms differ in architecture and mood inside one keep. | Choose each step's room art per task definition, presentation only: hash `taskDefinition.id` over the non-system 2× crops (`room-v5-researcher-2x`, `room-v5-publisher-2x`, `room-v5-engine-2x`), with `null` definitions falling back to the engine room. The same task definition always gets the same room, and neighbours can differ. |
| 24 | Low | `app/workflows/WorkflowsScreen.tsx` (no `id`) | `/workflows` with nothing selected shows a board that only says "Choose a workflow run". It's the same dead-pane pattern as finding 14, on the screen reached first. | When the list loads, `router.replace` to the run needing attention: first `failed`, then `in_progress`, then `paused`, otherwise the newest. Keep the notice only when the list is empty. |
| 17 | Medium (extended) | `app/workflows/WorkflowsScreen.tsx` (no `id`) | The capture (1920, 1280; stale API) shows the same contradiction as Agents: the runs board says "Couldn't load workflow runs." with Retry, while the detail pane still says "Choose a workflow run to see where it is in its sequence." | Same fix as finding 17. When `runsError && !runs`, the detail pane shows nothing, or a dim pointer to the Retry on the left. With finding 24's auto-select, the "choose" notice only remains for an empty list. |
| 16 | Low (extended) | `app/costs/page.tsx` "Cost and success" | Rows render in API order, like the Agents performance table. | Sort by agent name, then task definition name, then model tier. Never by `successRate`. |

## Round 6 (2026-09-15): Goals war room and Approvals, commit `800914d`

**Still open from earlier rounds** (unchanged in the code at this commit):
- 1: top-bar tabs as boxes.
- 5: `STRIPS.wizard.death` still points at the idle strip; the outlined wizard death strip is ready.
- 10: "n/a goals".
- 13: 3× keys in the 4× workshop.
- 14 and 17: `/agents` opens with no world, and contradicts a failed roster.
- 23: identical engine-room step rooms.
- 24: `/workflows` opens on an empty pane.

**Faithful, keep as is:**
- **Goals:**
  - a war-room vignette that states no value;
  - the quota warning in label ink (not amber);
  - the non-idempotent failure path ("refresh the goals and check before trying again" plus Refresh goals);
  - zero counts neutral;
  - goal statuses with a neutral mark, because they are not runtime states and cyan would claim work;
  - banners on parchment with run chips linking to the corridor.
- **Approvals, the queue and reading:**
  - reading-first, with the queue on the left;
  - the council hall lit amber with the pulsing seal only while a pending request is selected, and dimmed while the feed or a refresh is down;
  - the preview rendered as text, never HTML;
  - the full content linked through `/artifacts/:id?full=1`;
  - the proposed-action snapshot on vellum.
- **Approvals, the hash check and decision:**
  - all three states: match (green), mismatch (red marker, "Approving will fail", preview marked untrusted), and no hash pinned (neutral);
  - Approve and Reject pinned in the action bar;
  - an "advanced but not continued" notice.
- **Honest gaps:** no invented "resolved" group (the API returns pending only), and no sprite on the seal (the approval context has no agent id), both documented in `web/design/goals-approvals.md`.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 25 | Medium | `app/approvals/page.tsx` action bar | On a hash mismatch, the only "Approving will fail" signal is in the artifact strip inside the scrolling reading area. At 1280 × 800 it can scroll out of view, while the pinned **Approve** is still a green, armed control at the decision point. The design rule is that the safety signal stays visible at the moment of decision (`screens.md` laptop rules). | When `selected.context?.artifact?.hashMatchesSnapshot === false`: repeat the warning in the action bar (red marker plus "Content changed since it was proposed: approving will fail."), and render Approve with `kind="neutral"` (no green edge or marker). Don't disable it; the API decides, and the UI only reflects the returned field. |
| 26 | Low | `app/approvals/page.tsx` `.actionText` | "The decision is recorded and the workflow continues from it." is only true for Approve; a rejection stops that step. | "Your decision is recorded. Approving lets the workflow continue; rejecting stops this step." |
| 28 | Medium | `app/goals/page.tsx` summary card | When `GET /goals` fails (captured at 1920 and 1280), the summary card keeps showing the loading "· · ·" under its heading while the error notice sits below. It's the same error-as-loading defect as finding 12. | Render the summary's value line from three states: `projects` loaded → counts; `loadError && !projects` → "n/a" (dim); otherwise → skeleton. |
| 29 | Medium | `app/approvals/page.tsx` reading area | With nothing pending (captured at 1920 and 1280), the queue correctly says "Nothing is waiting for approval.", but the reading area says "Choose a request from the queue.", pointing at an empty queue. The design state frame "Approvals — pixel state: nothing pending" uses the heading "No approvals are pending" plus one plain line. | When `approvals?.length === 0`, render the design's empty state beside the unlit council hall: `px.heading` "No approvals are pending" plus "A request appears here when an agent reaches an approval gate." Keep "Choose a request" only when the queue has rows and none is selected (not reachable today, because the first row is auto-selected). |
| 30 | Low | `app/goals/goals.module.css` `.summary` | The summary parchment grows to fill the row (`flex: 1 1 280px`). At 1920 it's about 1100 × 256 px of mostly empty cream beside the war room. `visual-language.md`: cream parchment over a large area glares, and parchment is for short cards. | `flex: 0 1 520px` (or `max-width: 560px`), with `align-self: flex-start` so it hugs its content. The war room keeps its fixed size, and the empty wood to the right is fine. |
| 27 | Check | `app/approvals/page.tsx` at 1280 × 800 | The laptop rule keeps the hash check above the fold: the request card hugs its content, and the artifact strip follows it. This is not verifiable at this commit, because the stale API returns no pending approvals. | Verify on the real-data recapture. If the strip falls below the fold, place `ArtifactToAct`'s status line directly under the request card's `dl`. |

## Round 7 (2026-09-15): CLI1's fix pass on Agents and Registry, commit `01037fc`

CLI1 worked from this review. Verified in the diff:

| # | Status |
|---|---|
| 14 `/agents` opens with no world | **Resolved:** with no id in the URL, the screen opens the agent needing attention (stopped or awaiting approval), otherwise the first definition, so the workshop is always shown. |
| 15 raw JSON grant scope | **Resolved:** the scope renders as `key: value` lines on vellum. |
| 17 "choose from the roster" when the roster failed (Agents) | **Resolved on Agents:** "No agent is open: the roster couldn't be read." **Still open on Workflows** (see the round-5 extension). |
| 21 double Retry on Registry | **Partly resolved:** a refresh failure now uses one `RefreshNotice`. With no registry loaded at all, Retry still appears in both the roster and the main pane. |
| 13 3× keys in the 4× workshop | **Open:** `workshop.module.css` is unchanged. |
| 16 performance order | **Open** on Agents and Cost. |

**Also improved in this pass (consistent with the design, no change asked):**
- **Workshop:** grows to 768 px on wide screens (the world as hero); pending workshops are unlit and empty (`tile-pack.md`: pending means absent).
- **Honest reads:** a failed read shows "state unknown", never loading; unreadable stops and refresh failures are said.
- **Stops:** a global stop shows as stopped, with no lift offered from the agent screen; Stop can't double-submit.
- **Registry:** it never substitutes another agent for an unknown id.
- **Grants:** revoked grants are neutral (a fact, not a failure); keys are numbered in one shared order on both screens.
- **Refresh notices:** `RefreshNotice` puts routes on the detail line on every screen.

## Round 8 (2026-09-15): Artifacts vault and Events log, commit `774d41e`: every screen now built

**Faithful, keep as is:**
- **Artifacts, browsing and vault:**
  - browsing is per agent through `AgentDetail.outputs`, stated honestly (no list route);
  - the vault at 2× with one chest per returned output (16 px source at 32 px, one scale), none drawn while loading, and the open chest selected with a cream outline.
- **Artifacts, reading:**
  - the hash check in all three states, with a mismatch marking the content untrusted;
  - provenance links to goal, agent and invocation;
  - the preview as text, never HTML, with the whole content on request or via `?full=1`;
  - reference fields of unknown shape shown as "not recorded" rather than guessed;
  - 404 and failure states with Retry.
- **Events:** a thin library strip (almost no world, as designed); a parchment header with the feed status, received count and Reconnect when stale; type filters built from received events only (client state, no list route); a dense mono table with a sticky header; honest connecting and empty states.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 31 | Medium | `app/events/page.tsx` `TYPE_TONES` | Log rows get a **cyan** marker for every `*_started` event and **amber** for `approval_required`. Those hues mean *active now* and *waiting now* (`visual-language.md`: light and colour carry real current state). A log row is history: an invocation that started an hour ago isn't active, and a past approval request may already be resolved. So the log paints stale state across the page. Red (failures, rejections) and green (completions, approvals) are outcomes, which the rule allows. | Keep `fail` and `done`. Map `started` and `approval_required` to `neutral`. If a type glyph helps scanning, use a neutral shape per family, never a state hue. |
| 32 | Low | `app/artifacts/ArtifactsScreen.tsx` meta card (no `id`) | When the selected agent's vault is empty, the outputs list says "…'s vault is empty." while the main card still says "Choose an output to read it and see where it came from." That points at outputs that don't exist, the same pattern as findings 17 and 29. | When `outputs?.length === 0`, the meta card shows `px.heading` "Empty vault" and nothing to choose. Keep "Choose an output" only when outputs exist. |
| 33 | Low | `app/artifacts/ArtifactsScreen.tsx` outputs detail line | "Recent outputs of this agent's recent runs (GET /agents/:id). No route lists every artifact." explains the implementation in operator copy. | "This agent's recent outputs." Record the missing list route in `web/design/artifacts-events.md` (already noted there), not on screen. |
| 34 | Low | `app/events/page.tsx` stale notice | "Missed events replay from the last cursor when it returns." is implementation language. | "Missed events will be filled in when it's back." (the design state frame's copy). |

## Round 9 (2026-09-15): CLI1's fix pass across the screens, commit `022557a`

CLI1 worked through this review. Verified in the committed tree:

| # | Status |
|---|---|
| 1 top-bar tabs as boxes | **Resolved:** inactive tabs have a transparent border and plain text; only the active tab is bevelled. |
| 5 wizard death fallback | **Resolved:** `wizard-death-strip-2x-outlined.png`, 12 frames. |
| 8 portrait at 1080 px tall | **Resolved** (per commit; confirm in the capture). |
| 13 3× keys | **Resolved:** 64 px keys (4×) in the 4× workshop. |
| 16 performance order | **Resolved** on Agents (task name, then tier) and Cost (agent, task, tier). Never sorted by success. |
| 18 empty Overview board | **Resolved** (per commit): every Agent Definition is listed when nothing runs. |
| 19 duplicate events | **Resolved:** the strip pins only notable events (`approval_required`, `*_failed`, stop engaged, run halted, artifact created). |
| 20 half-cut note | **Resolved** (per commit; confirm at 1280). |
| 21 double Retry on Registry | **Resolved.** |
| 22 framework 404 | **Resolved:** `app/not-found.tsx` in pixel chrome. |
| 23 identical step rooms | **Resolved:** the step room art is hashed from the task definition over the engine, researcher and publisher crops. |
| 24 `/workflows` empty pane | **Resolved** (per commit): it opens the run needing attention. |
| 25 mismatch warning at the decision point | **Resolved:** a changed hash is repeated in the action bar, and Approve renders `neutral`, not armed. |
| 26 decision copy | **Resolved:** "Approving lets the workflow continue; rejecting stops this step." |
| 28 Goals summary loading after a failure | **Resolved:** "n/a". |
| 29 empty Approvals state | **Resolved:** "No approvals are pending". |
| 30 oversized parchment summary | **Resolved** (per commit): it hugs its content. |
| 31 cyan/amber markers on historical log rows | **Open:** `TYPE_TONES` still maps `started` → active and `approval_required` → wait. |
| 32 empty vault still says "Choose an output" | **Open.** |
| 33 route language in the Artifacts detail line | **Open.** |
| 34 "replay from the last cursor" | **Open.** |
| 10 "n/a goals" | **Resolved, seen in capture** (1920): the Goals and Workflows plaques read "n/a". |
| 1, 20 | **Seen in capture:** plain tabs with one bevelled active tab (1920, 1280); the notice strip pins a single whole note, not a sliced one (1280). |
| 17 on Agents | **Seen in capture:** "No agent is open: the roster couldn't be read.", with one Retry. |
| 8, 18 | **Not confirmable yet:** they need a loaded registry and a running agent, which the stale API can't provide. Check on the real-data recapture. |
| 9, 17 (Workflows), 24, 30 | **To confirm** in the rest of this commit's capture. |

## Round 10 (2026-09-15): whole-app critic, reconciled against commit `022557a`

**Method:** an independent critic reviewed all nine screens at 1920, 1440 and 1280. Its captures came from the commit before CLI1's fix pass (`774d41e`), so each claim was re-checked against captures of `022557a` (headless Edge, exact viewports, stale API).

**Critic verdict at `774d41e`: "drifting".** The chrome, typography, colour discipline and room variety all held, and the rooms read as distinct places (library, council hall, war room, vault, forge, runtime core). But when a read fails, several screens lose their world entirely.

**Claims already resolved in `022557a`** (seen in captures): #10 "n/a goals", #17 on Agents and Workflows, #20 the sliced note, #21 double Retry, #28 and #30 Goals summary, #29 empty Approvals state.

**Fixed by design (assets):**
- **Vault chests.** The critic's "3 chests while the roster failed" is baked art: the `room-v5-vault-2x.png` in `web/public/world/` was cropped before the chests were removed from the keep, and the compositor also placed a small banded box in the vault that reads as a chest. Both are fixed: the box is gone from `compose-keep-v4.ps1`, and the keep plus all seven `room-v5-*` crops were regenerated from the current composite (which also carries the slate pit and workshop floors). **CLI1:** run `npm run world-art`; no code change needed.

**Accepted from the critic** (still true at `022557a`):

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 35 | Medium | Agents, Workflows, Registry: failed-read states | When the main read fails, the world disappears entirely: no workshop, no corridor, no armory, just a large empty wood pane with one line. The design rule is **unloaded means unlit, not absent** (the Overview load-failed state frame keeps the keep, unlit). Losing the room on failure is what makes these screens read as a SaaS console. | Keep the room on screen, unlit and without actors or keys, beside the error notice. **Agents/Registry:** `WorkshopCloseup` with `state="unknown"` using the first workshop close-up. **Workflows:** an unlit corridor of one engine room with no plaque. Keep the notice and its single Retry. |
| 36 | Low | `app/events/page.tsx` log | The summary repeats the event type in snake_case ("invocation_failed (reason=…)"), next to a type column that already says it. The cursor column is empty (the feed items have no `eventCursor`). | Strip a leading `${eventType} ` from `summary` for display, keeping the `title` attribute unchanged. Hide the cursor column when no row has a cursor. |
| 37 | Low | `app/page.tsx` Recent events | At 1440 and 1280 the event type truncates ("invocation complet…") while the full timestamp stays. | Show only `HH:MM:SS` for today's events, and ellipsize the time before the type. |
| 38 | Low | `app/artifacts/ArtifactsScreen.tsx` | With the roster failed, three "choose" prompts stack up ("Choose an agent to browse its outputs", "Choose an output to read it…") with nothing to choose. At 1280 and 1440 the roster card also clips "Couldn't read active stops, so a…" mid-line (its max height is 240 px). | With a failed roster, show only its notice plus Retry. The outputs and meta cards show a dim line ("The roster couldn't be read.") instead of instructions. Let the roster card grow to fit its notices, or drop the stops line while the roster itself has failed. |
| 39 | Low | `components/pixel/Pixel.tsx` `StateNotice` detail, and `lib/api.ts` error text | Every detail line ends with "404 Not Found: Not Found" (the status text repeated as the body). | In the displayed detail, collapse a body that equals the status text: "GET /registry → 404 Not Found". |
| 40 | Low | Goals and Approvals notice cards | The error and empty cards span the whole column (about 1490 px) for 2–3 lines, leaving the war room and council hall as small thumbnails beside large wood. | `max-width: 640px` on these notice cards. The world vignette keeps its size. |
| 41 | Low | Agents roster, stops warning | With the roster read failed, "Couldn't read active stops, so a stop may not show." adds a second warning under a roster that doesn't exist. | Show the stops warning only when the roster itself loaded. |

| 42 | Low | `app/costs/page.tsx` side board, failed ledger | With `GET /costs` failed (captured at 1920), the six scope filters stay live and the "Totals" tab sits under them in the same plaque style, so it reads as a seventh filter. The note on how totals are summed also stays up, over no data. A filter over nothing is a control without an object. | While `!data && error`, render the scope filters disabled and hide the totals note. Style "Totals" as a section tab (`px.tab`, not a plaque) with space above it, so it can't read as a chip. |

**Registry capture at `022557a`:** one Retry ("Retry from the roster on the left"), confirming #21 resolved. The missing world on a failed read is covered by #35.

**Still open from round 8:** #31 (cyan "started" and amber "approval required" on history rows, still in the capture), #32–#34.

**Rejected:** none new. The critic's laptop panning note was already an accepted decision.

**Next review:** Workflows, Goals and Approvals once rebuilt in pixel chrome; Artifacts, Events and Costs once their routes exist; and a real-data recapture of every screen once the API process is restarted.

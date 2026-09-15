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

**Update 2026-09-15 13:24: resolved.** The API was restarted (pid 23504), and every route the UI reads answers 200 (`/registry`, `/goals`, `/costs`, `/workflow-runs`, `/execution-stops`, `/agents/active`, `/approvals`). Reviews from round 13 on use real data.

**Original review environment note for CLI1 (was blocking real-data visual review):** the API process on port 3000 (pid 46752) was **started 2026-09-12 22:19**, before `GET /registry`, `/costs`, `/execution-stops`, `/goals` and `/workflow-runs` existed. On 2026-09-15 all five answered 404, though the routes exist in `src/api/routes`. The UI correctly showed "n/a" and stops-unreadable warnings. Restart the API before a visual review, so screenshots show real data rather than error states.

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

## Round 11 (2026-09-15): CLI1's second review pass, commits `8f6cde8` and `53036bd`

**Status of open findings:**

| # | Status |
|---|---|
| 31 cyan/amber on historical log rows | **Resolved:** past `started` and waiting rows are neutral; only outcomes keep red or green. |
| 33 route language in the Artifacts detail line | **Resolved:** "This agent's most recent outputs." |
| 42 Cost filters over a failed ledger | **Partly resolved:** "Totals", "Counters" and "Cost and success" are section tabs, and the totals note is trimmed. The scope filters still stay enabled while the ledger read has failed. |
| 32 empty vault still says "Choose an output" | **Open.** |
| 34 "replay from the last cursor" | **Open.** |
| 35 rooms absent on failed reads (Agents, Workflows, Registry) | **Open.** This is the largest remaining gap against "the world is the hero". |
| 36 Events summary repeats the type; empty cursor column | **Open.** |
| 37 recent-events truncation | **Open.** |
| 38 stacked "choose" prompts and clipped roster card on Artifacts | **Open.** |
| 39 "404 Not Found: Not Found" | **Open.** |
| 40 notice cards span the column | **Open.** |
| 41 stops warning under a failed roster | **Open.** |

**Also improved in this pass (consistent with the design, no change asked):**
- **Artifacts:** the outputs count shows `10+` at the route's cap (a capped list is never a total), and a failed refresh is shown.
- **Late replies:** stale artifact and cost replies can no longer land over a newer read.
- **Workflows:** the corridor dims while a refresh is down (stale light at 45%, as on the Overview).
- **Approvals:** after a decision, Approve no longer jumps to an unread request, and both buttons stay disabled while a decision is pending.
- **Events:** the type filter resets when its type ages out.
- **Copy and accessibility:** decorative vignettes are `aria-hidden`, table headers are scoped, and notes-to-self are trimmed from copy.

**Design-side asset update, verified:** the regenerated keep (no chest in the vault, slate pit and workshop floors) is now on all seven Figma Overview keep layers (upload registered via a temporary frame; see the corrected gotcha in `figma-workflow.md`). **CLI1:** `npm run world-art` picks up the same art for `web/public/world/`.

## Round 12 (2026-09-15): commit `ea547f5`

**CLI1 changes:** CSS floor patches cover the three chests painted into the vault art; "Standalone task" becomes "no goal"; the Goals summary counts only projects with goals; the Overview design note matches the portrait and wizard death strip.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 43 | Low | `app/artifacts/artifacts.module.css` vault floor patches | The patches work around a stale asset: the chest-free vault crop already exists (round 10, `assets/gamification/adapted/room-v5-vault-2x.png`, regenerated from the current keep). On top of the new art, the patches would cover clean floor with hand-placed rows that can drift out of alignment with the pixel grid. | Run `npm run world-art` so `web/public/world/room-v5-vault-2x.png` is the chest-free crop, then remove the floor patches. The world layer then carries only real outputs, and no correction is layered over the art. |

**Unchanged at this commit:** #32, #34, **#35** (rooms absent on failed reads: Agents, Workflows, Registry), #36, #37, #38, #39, #40, #41, #42 (scope filters still live over a failed ledger).

## Round 13 (2026-09-15): real data, after the API restart (web at `ea547f5`)

**Live data at capture:**
- **Registry:** Publisher v1 and Researcher v1, 2 capabilities with 2 grants, 2 task definitions, 1 workflow definition.
- **Goals:** 1 project ("Research Workflow") with 2 goals and 1 failed workflow run.
- **Costs:** 1 run-scope counter in usd.
- **Currently:** no active agents, no stops, no pending approvals.

**Newly reported concerns, judged against the rules:**
- **Fail-light: not a defect.** No failed step or agent gets a red room light (Overview workshops, Workflows corridor and workshop close-up light only `active`). `visual-language.md` rules that green and red are for decisions, outcomes and controls, never world light. Failure is carried by one sharp flash, a steady red marker and word, and the death pose, and the real failed run shows exactly that (red plaque, unlit room). `light-fail-4x.png` is an unused leftover from the lighting exploration. Don't wire it in. A failed run is also history: the Agents workshop shows "no active run" once nothing is unfinished, which is honest.
- **Trace refresh: a defect.** See #47.
- **Artifact loading: faithful in code, confirmed in capture below.** The detail shows a skeleton heading plus "Loading the artifact · · ·". While outputs load, the vault draws no chests (the outputs layer is empty). Opening `/artifacts/:id` without `?agent` shows a skeleton in the outputs board until the producing agent is known.

**Confirmed with real data:**
- **#18:** with nothing running, the Overview board lists "Publisher v1" and "Researcher v1" with a neutral "no active run".
- **#14:** `/agents` opens the first definition's 4× workshop (Publisher) instead of an empty pane.
- **#13:** the key is 64 px (4×) with tag "1", matching the "Key 1 · publish.report" card.
- **Overview:**
  - plaques show real values in neutral tones ("2 goals", "0 in progress", "0 pending");
  - the workshops are unlit with no actors while nothing runs;
  - Recent events show their cursors (#1–#4).
- **#23 and the Workflows screen:**
  - the real failed run's corridor shows two distinct step rooms (researcher, then publisher workshop);
  - step 1 is "failed" with no light, step 2 is dimmed and "not started";
  - invocation outcomes use red and green only;
  - the cream budget gauge reads "0.01 consumed of 1.00", with reserved hatched.
- **Goals:**
  - the summary hugs its content ("2 goals across 1 project with goals"), with zero counts neutral and "1 failed" red;
  - the project wing shows both goals as banners with a neutral goal status (not runtime state), and the failed run as a chip.
- **Agents, Researcher v1 (1920, 1280):**
  - lineage row "Unit 11 smoke test goal › Research-Report", red "failed", "latest #2 llm · failed";
  - "Key 1 · research.retrieve", READ · AUTONOMOUS · trust ≥ 1, matching the tagged 4× key;
  - usage in usd;
  - the real output "invocation_result · 591 bytes" with a chest;
  - the four real recent actions;
  - the workshop unlit with an idle sprite and "no active run", which is honest, since the only run has finished;
  - at 1280 the room is a centred crop and the board scrolls, with nothing act-now clipped.
- **Artifacts, Researcher's real output (1920, 1280):**
  - the vault draws exactly one chest, open and selected with a cream outline;
  - "Outputs · 1";
  - metadata: 591 bytes, created, stored inline, "summary none recorded", the full hash;
  - a green "the content matches its hash";
  - Produced by links to the goal and to "Researcher v1", with task "Research-Report v1" and invocation "tool #1";
  - the preview as text;
  - an honest "No compiled context has included this artifact.";
  - at 1280 the panels wrap with nothing clipped.

  This closes the artifact-loading concern: loading resolves into a correct populated state, and the world layer shows only the real output.
- **Approvals (#29):** with 0 pending, "No approvals are pending" plus one plain line appears beside an unlit council hall.
- **Events (#31):**
  - real rows show outcome colours only: "invocation failed" red, "invocation completed" green, "invocation started" neutral;
  - filter chips come from received types;
  - cursors 1–4 now render, so the empty cursor column in #36 was a stale-API artefact.
- **Registry:**
  - capabilities with risk tag, description and tool binding (trust level, internal function), task definitions with plan status, and the workflow definition, all from `GET /registry`;
  - the read-only line on parchment;
  - no controls.
- **Costs:**
  - the real run counter ("Researcher v1 · Research-Report", 0.01 consumed · limit 1.00) with a cream gauge;
  - an API total ("run · usd … across 1 counter");
  - "No performance measured yet." (no rows).
- **Artifacts:** an empty vault (0 outputs) draws no chests, and CLI1's floor patches hide the painted ones.

- **Artifacts without `?agent` (artifact-direct):** the page resolves the producing agent (Researcher v1) and renders the same populated page as the version with the param.

**Independent critic (all 45 real-data captures), verdict: on track.** Every checked value matched the live data. No cyan or amber is lit without current state, and red and green appear only on outcomes and controls. Each screen keeps its distinct room (keep, workshop, corridor, war room, council hall, vault, library, forge).
- **Accepted as findings #52–#56.**
- **New evidence for #43:** a chest pair beside the vault cabinets shows in the empty Publisher vault and on the Overview. The regenerated vault crop already removes it, but CLI1's CSS patches don't.
- **Asset follow-up (design side): done after the round.** The 4× researcher workshop close-up (`room-researcher-workshop-4x-slate.png`, 768 × 640) carried a decorative chest pair beside an agent with a real output. The pair is now covered with the floor tile one period to the right (grid continuous, same size and name; see `assets/gamification/adapted/README.md`), and the Figma workshop layers are updated. **CLI1:** `npm run world-art` picks up both this and the chest-free vault crop. Then the vault floor patches in `artifacts.module.css` can go (#43).
- **Rejected as acceptable choices:**
  - renaming the goal status "active": it's the API's goal status, and it already has a neutral marker;
  - the empty band under the Events filter chips;
  - the corridor hugging its two rooms at 1920;
  - Recent actions truncating in a half-width card: already #37.

**Still open, re-seen with real data:**
- **#32:** "Choose an output to read it…" beside "Publisher v1's vault is empty.".
- **#36 (summary half):** the summary still repeats `invocation_failed (…)`.
- **#40:** the Approvals empty card spans about 1000 px.
- **#44:** void bands appear on Registry as well as Agents.
- **#45:** the 18-decimal reserved amount shows on Cost counters and totals too.

**Round 13 status, at web commit `ea547f5` with the live API:**

| Status | Findings |
|---|---|
| **Verified resolved with real data** | #13 (4× keys), #14 (`/agents` opens a workshop), #18 (board lists definitions when idle), #23 (distinct step rooms), #29 (empty Approvals state), #31 (neutral historical log rows), #33 (operator copy on Artifacts), #36 cursor half (cursors render; the empty column was a stale-API artefact) |
| **Judged not a defect** | the missing fail-light (red and green are never world light; failure is a marker, word, flash and pose) |
| **Open, confirmed with real data** | #32, #34, #36 summary half, #37, #40, #43, #44, #45, #46, #48, #49, #50, #51, #52, #53, #54, #55, #56 |
| **Open, from code (not reproducible with healthy reads)** | #35 rooms absent on failed reads, #38, #39, #41, #42 filters over a failed ledger, #47 run trace never refreshes |

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 52 | Medium | `app/registry/page.tsx` (real data, Researcher v1) | **Honesty:** the heading scopes the page to one agent ("Registry · Researcher v1"), but Capabilities, Task definitions and Workflow definitions are registry-wide. Under Researcher it lists `publish.report`, which Researcher isn't granted, and both agents show identical definition lists, so the page implies an agent scope the data doesn't have. | Split the board into **"Researcher v1"** (its keys, and the capabilities those keys grant) and **"Whole registry"** (all capabilities, task and workflow definitions) under its own tab. Or keep one list and mark ungranted capabilities with a neutral "not granted to this agent". |
| 53 | Medium | `app/page.tsx` Overview board (real data) | With nothing running, the board says "Nothing is running. Start a goal…" and Workflows shows "0 in progress". That's true, but the only workflow run failed (a configuration error), and nothing on the Overview points at it except the notice strip. The Overview's question is "where must I act?", and a failed latest run is act-now. | When no Run is active and the newest workflow run is `failed`, add one board line under the empty notice: red marker plus "Latest run failed · <goal title>", linking to `/workflows/:id`. The data is the existing `GET /workflow-runs` read; no new route needed. |
| 54 | Medium | `lib/keep.ts` `characterFor` (real data) | Publisher v1 and Researcher v1 both render as the same knight: the id hash maps both ids to `knight`. With two real agents, the one world cue for which agent this is gets lost. | Keep identity deterministic, but make it distinct across the definitions that exist. Assign characters in the stable order of Agent Definition ids from `GET /registry` (first id knight, second wizard, …, cycling), falling back to the hash only when the registry is unreadable. |
| 55 | Medium | `app/events/page.tsx` log (real data, 1440 and 1280) | The failed row's summary is cut before the reason ends ("…is not set in this e…"), with no way to expand it. The failure reason is the most important fact on the row. This is separate from #36, which covers the repeated type. | Let rows with a `fail` marker wrap their summary (no `nowrap` or ellipsis on that cell), or expand on click or focus to the full text. The full summary also stays in `title`. |
| 56 | Low | laptop layout, several screens (real data) | Workflows run list at 1440 breaks the timestamp mid-token ("2026-" / "09-12"). The Agents key card at 1280 wraps "trust ≥" and "1" onto separate lines. At 1280 the step detail card cuts off "Run trace" at its bottom edge with a stray border fragment and no scroll cue. At 1440 the Artifacts "Referenced by" panel wraps in about 310 px beside about 1100 px of free space. | `white-space: nowrap` on timestamps and on "trust ≥ n". Let the step detail grow or show a visible scroll edge. Let "Referenced by" span the free columns, like `.reading`. |
| 51 | Low | `app/artifacts/ArtifactsScreen.tsx` preview (real data) | The real 591-byte `invocation_result` is JSON, shown as one unbroken blob that wraps mid-token, so the titles, snippets and source URLs inside it are hard to read. | When the preview parses as JSON, render `JSON.stringify(parsed, null, 2)`, still as text in the `pre`. Fall back to the raw string when it doesn't parse or is truncated. Never render it as HTML. |
| 50 | Medium | `app/agents/AgentsScreen.tsx` "Latest context" (real data, Researcher v1) | When `contextLineage` is null, the board says **"No model calls yet."** Researcher v1 did make a model call: its run's latest invocation is "#2 llm · failed" (shown two cards above). It failed before a context was recorded. The copy turns a missing record into a claim about the runtime that the data contradicts (`runtime-truth.md`: an absence says what is absent, not a guess why). | "No compiled context recorded." Or, when some run's latest invocation is `llm`, "No context was recorded for its model calls.". Never "No model calls yet" unless no `llm` invocation exists. |
| 48 | Low | `app/artifacts/ArtifactsScreen.tsx` default agent (real data) | With no `?agent`, the vault opens on the first roster entry (Publisher v1, 0 outputs), so the screen starts on "Publisher v1's vault is empty.". Researcher v1's real output stays one click away. On a screen whose question is "what did the agents produce?", the default hides the only artifact. | With no `?agent`, open the agent with the most recent output (compare `outputs[0].createdAt` from the agents' detail reads, or reuse the roster's active and attention order), falling back to the first entry only when none has outputs. |
| 49 | Low | `app/registry/page.tsx` grant card (real data, Publisher) | A grant whose `scope` is an empty object renders an empty dark vellum bar inside the parchment card: a list with no rows. It reads as a broken field. | Render the scope list only when `Object.keys(g.scope).length > 0`. For an empty scope, show nothing, or a dim "no scope limits" line if the absence is meaningful. |
| 47 | Medium | `app/workflows/WorkflowsScreen.tsx` `StepDetail` run trace | "Show the run trace" reads `GET /runs/:id/trace` once and never re-reads it. The run detail refreshes every 5 s while the run is unfinished, so on an `in_progress` run the trace goes stale beside a live step state, with no timestamp saying when it was read. The finished failed run in the live data isn't affected. | Keep the trace on demand (no automatic trace polling). Show "read at HH:MM:SS" beside it. Offer a neutral "Refresh the trace" button (a GET only). When the run's `status` or `invocations.length` changes after the trace was read, mark it "out of date" (dim) until refreshed. Never refresh it silently mid-read. |
| 46 | Medium | `app/workflows/WorkflowsScreen.tsx` Invocations table (1920 and 1280, real failed run) | The invocations table sits in a narrow column (about 360 px at 1920), so its "failure" and "outputs" columns are pushed behind a horizontal scroll. For the real failed run, the failure reason ("ANTHROPIC_API_KEY is not set…") is invisible without scrolling, although it answers this screen's question "…and what failed?", and the step detail has hundreds of empty pixels beside it. At 1280 even the time column is clipped. | Show the failure reason where it can't be hidden: under a failed invocation row, as a full-width line (red marker plus the reason in label ink, error code dim). Give the Invocations column the row's full width (`grid-column: 1 / -1`), with Budget beside or below it. |
| 45 | Low | `app/workflows/WorkflowsScreen.tsx` budget line (real data) | Reserved renders as "0.000000000000000000", the raw 18-decimal string. It's exact, but it can't be read at a glance. | Display the decimal with trailing zeros trimmed ("0"), which is numerically the same exact value. Keep the full string in a `title`. Apply the same formatting wherever `consumed`/`reserved`/`limit` amounts render (Agents usage, Cost counters and totals). |
| 44 | Medium | `components/world/workshop.module.css` `.closeup` / `.room` (Agents, Registry at 1920) | The 768 × 640 room sits centred in a world column about 940 px tall, leaving about 200 px of solid void above it and 150 px below. The void reads as letterboxing, not as part of the keep, and makes the hero room look like a pasted thumbnail. | Size the column to the room: `align-self: start; height: 644px` (room plus bevel) on wide screens, and let the board use the full height. Or keep the height and continue the keep around the room: tile the stone-wall strip above and the hall floor below (from `keep-v4-2x.png`), dimmed by the night layer. Don't scale the room fractionally. |

**Next review:** Workflows, Goals and Approvals once rebuilt in pixel chrome; Artifacts, Events and Costs once their routes exist; and a real-data recapture of every screen once the API process is restarted.

## Implementation pass (CLI1, commit `fix(ui): address real-data design QA findings`, on `9cd7c21`)

Implementation status only; nothing here is verified. Every item needs QA confirmation.

| # | Status |
|---|---|
| 53 latest failed run on the Overview | **Fixed in code, awaiting QA verification.** With no active Run and the newest `GET /workflow-runs` row `failed`, one plaque under the empty notice reads "Latest run failed · <goal title>" and links to `/workflows/:id`. |
| 50 "No model calls yet" | **Fixed in code, awaiting QA verification.** "No context was recorded for its model calls." when a run's latest invocation is `llm`, otherwise "No compiled context recorded.". "No model calls" is never claimed, because only each run's latest invocation is known. |
| 52 Registry scope | **Fixed in code, awaiting QA verification.** The fix-column option "mark ungranted": a capability with no unrevoked grant for the selected version shows a neutral "not granted to this agent". No tabs, no controls. |
| 54 identical knights | **Fixed in code, awaiting QA verification.** `characterFor(id, definitionIds)` assigns characters in sorted Agent Definition id order (cycling) and falls back to the hash without the Registry. Overview (workshops, seal, portrait) and `WorkshopCloseup` (Agents, Registry) all pass the Registry ids. |
| 55 truncated failure reason; 36 summary half | **Fixed in code, awaiting QA verification.** `fail` rows wrap their summary (full text kept in `title`), and a leading `${eventType} ` is stripped from the displayed summary. |
| 46 failure reason behind horizontal scroll | **Fixed in code, awaiting QA verification.** The failure column is gone. A failed invocation gets a full-width line under its row (red marker, reason in label ink, error code dim), and Invocations spans the row. |
| 47 stale run trace | **Fixed in code, awaiting QA verification.** Still on demand, with no trace polling. The trace shows "read at HH:MM:SS" and a neutral "Refresh the trace" (GET). The last read stays on screen while refreshing. It is marked "out of date" (neutral marker, dim list) when the 5 s run refresh changes `status` or `invocations.length`. |
| 43 (a) vault floor patches | **Fixed in code, awaiting QA verification.** `npm run world-art` copied the chest-free vault crop into `web/public/world/` (git-ignored), and the CSS floor patches and their markup are removed. |
| 43 (b) researcher 4× close-up chests | **Blocked (design-side asset).** The only 768 × 640 researcher close-ups in `assets/gamification/adapted/` (`room-researcher-workshop-4x-slate.png`, `room-researcher-workshop-4x.png`) both carry the chest pair. Nothing is hidden with CSS and no art was authored. |
| 56 laptop layout | **Fixed in code, awaiting QA verification.** Timestamps in the runs list and "trust ≥ n" (Agents, Registry) are `nowrap`. The step detail no longer shrinks inside the scrolling run column (`flex: none`). "Referenced by" spans the panel row. |
| 37 recent-events truncation | **Fixed in code, awaiting QA verification.** Layout half: the time column ellipsizes first (full timestamp in `title`), and the type keeps its width. The HH:MM:SS-for-today half was already true in `formatTime`. |
| 40 wide notice cards | **Fixed in code, awaiting QA verification.** `max-width: 640px` on the Goals notice cards and the Approvals empty card. |
| 41 stops warning under a failed roster | **Fixed in code, awaiting QA verification.** Shown only when the roster loaded. |
| 42 filters over a failed ledger | **Fixed in code, awaiting QA verification.** Scope filters are disabled while `!data && error`, and the totals note is hidden. Disabled plaques get the disabled treatment (no state colour). |
| 32 "Choose an output" in an empty vault | **Fixed in code, awaiting QA verification.** The heading reads "Empty vault" with nothing to choose. |
| 34 "replay from the last cursor" | **Fixed in code, awaiting QA verification.** "Missed events will be filled in when it's back." on the Events screen and in the notice strip. |
| 35 rooms absent on failed reads | **Fixed in code, awaiting QA verification.** Agents and Registry keep the first workshop close-up, unlit with "state unknown" and no actor or keys. Workflows shows an unlit one-room corridor with no plaque beside the error. |
| 38 stacked "choose" prompts | **Fixed in code, awaiting QA verification.** With the roster unreadable, the outputs and meta cards say "The roster couldn't be read." (the clipped stops line is gone via #41). |
| 39 "404 Not Found: Not Found" | **Fixed in code, awaiting QA verification.** `apiFetch` appends the body message only when it differs from the status text. |
| 44 void bands around the 4× workshop | **Fixed in code, awaiting QA verification.** `.closeup` is `align-self: start; height: min(100%, 644px)`. |
| 45 18-decimal amounts | **Fixed in code, awaiting QA verification.** `formatAmount` trims trailing zeros on Workflows budget, Agents usage, and Cost counters and totals. The exact strings stay in `title`, and gauges still use the raw values. |
| 48 default vault agent | **Fixed in code, awaiting QA verification.** With no `?agent` and no artifact, the screen reads each definition's `GET /agents/:id` once and opens the one with the newest `outputs[0].createdAt`, else the first. |
| 49 empty grant scope bar | **Fixed in code, awaiting QA verification.** The scope list renders only when the scope has keys. |
| 51 JSON preview blob | **Fixed in code, awaiting QA verification.** A preview or full content that parses as a JSON object or array is shown indented, still as text. A truncated preview is shown as stored. |

## Round 14 (design QA of web commit `15b7007`, live API, real data)

**Method:**
- Diff read in full. `npx vitest run` passes: 77 tests in 11 files.
- Every screen and detail route was captured at 1920, 1440 and 1280, by navigation only. Captures are in `qa10`, `qa10b` and `qa10c`.
- The run trace was opened with "Show the run trace" and refreshed once. Both are a `GET /runs/:id/trace`, with nothing started, approved or advanced.
- An independent critic reviewed every capture.
- **Capture caveat:** the first pass (`qa10`) raced the dev server's route compile, and about ten files hold the previous route's page (confirmed by hash). Every verdict below rests on a capture whose content was checked, not on its filename. Headless captures also hide scrollbars, and the Next.js dev "N" badge covers the notice strip. Both are capture artefacts, not product defects.

**Verified resolved with real data:**
- **#36 summary half:** the type is no longer repeated in the Events summary.
- **#40:** the Approvals empty card and the Goals notices are capped at 640 px.
- **#43a:** the vault shows only the real chest, with no CSS patches.
- **#44:** the 4× workshop hugs the room at 1920 on Agents and Registry.
- **#45:** "0.01 consumed · 0 reserved · limit 1" appears on Workflows, Agents and Cost.
- **#46:** the failure reason is a full-width line under the llm row at every width.
- **#47:** the trace shows "read at 14:33:29" with "Refresh the trace", and after a refresh the read time moved to 14:33:33. The "out of date" marker can't occur on a finished run; it's checked in code and in `workflows.test.tsx`.
- **#48:** `/artifacts` opens on Researcher v1, the agent with the output.
- **#49:** no empty scope bar.
- **#50:** Researcher reads "No context was recorded for its model calls."; Publisher reads "No compiled context recorded."
- **#51:** the JSON preview is indented, as text.
- **#52:** `publish.report` is marked "not granted to this agent" under Researcher.
- **#53:** "Latest run failed · Unit 11 smoke test goal" at 1920, 1440 and 1280 links to the run.
- **#54:** Researcher is a knight and Publisher a wizard, on Overview, Agents and Registry.
- **#55:** the failed Events row wraps its full reason.
- **#56:** runs-list timestamps and "trust ≥ 1" no longer break mid-token, and "Referenced by" spans the row. The step detail no longer shrinks; below the fold it scrolls with the run column, which is acceptable (the scrollbar is hidden only in headless captures).

**Verified in code only (error states can't be reproduced with a healthy API, and nothing was stopped to force them):**
- **#34:** "Missed events will be filled in when it's back." on Events and the notice strip.
- **#35:** an unlit "state unknown" workshop on Agents and Registry, and an unlit one-room corridor with no plaque on Workflows.
- **#38:** the "The roster couldn't be read." lines.
- **#39:** a body that repeats the status text is dropped.
- **#41:** the stops warning is shown only with a loaded roster.
- **#42:** scope plaques are disabled with the disabled treatment and no state colour.

**#43b is not blocked.** The chest-free `room-researcher-workshop-4x-slate.png` has been in `assets/gamification/adapted/` since `efd821c`. `web/public/world/` still holds the Sep 14 copy (different hash), because `world-art` ran before the patch. **CLI1:** run `npm run world-art` again. No code change is needed. The chest pair still shows in `agent-researcher-1920` and `registry-researcher-1920`.

**Critic reconciliation:**
- **Accepted:** #37 is still open on Agents, #57 (new), #58 (new).
- **Rejected as acceptable choices:**
  - Overview plaques cut at the world edge at 1440 and 1280: already ruled out in the laptop rule (D16 panning, line "Scale the keep to fit…" above), and unchanged since round 13.
  - The Agents board and step detail running below the fold with "no scroll cue": the scrollbar is hidden only in headless captures.
  - The "(reason=…)" parentheses in Events summaries: that's the API's summary text.
  - Cost highlighting the Workflows tab and Registry highlighting Agents.
  - The red "Stop agent" on idle agents: it's a control.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 37 | Low | `app/agents/AgentsScreen.tsx` Recent actions (1920, 1440) | **Still open on Agents.** The Overview half is fixed, but the Agents board's Recent actions still ellipsizes the event *type* ("invocation completed…" at 1920, "invocation faile…" at 1440) while the full timestamp keeps its width. | Apply the Overview fix here too: the time column shrinks first, and the type keeps `max-content`. See #57 for how the time should shrink. |
| 57 | Low | `app/overview.module.css` `.events li` (1440, 1280, real data) | The #37 fix gives each `li` its own grid, so each row ellipsizes its timestamp at a different point ("22:20:14", "22:20:…", "22:2…"). The time column is ragged, and minutes are lost on some rows but not others. | Share one column track across rows: put the grid on the `ul` and use `display: contents` or `subgrid` on the `li`. Better still, shorten the timestamp before truncating: when the date isn't today, `formatTime` could give "09-12 22:20:14" in this compact list (full value in `title`), which fits at 1280 without an ellipsis. |
| 58 | Low | `app/goals/goals.module.css` goal cards (1920) | At 1920 the goal cards stay about 340 px wide beside a mostly empty board, so the workflow-run chip wraps into "Workflow / run" and "2026-09-12 / 22:20:14". At 1280 the same chip fits on one line because the cards are wider. | Let the goal grid grow its cards (`repeat(auto-fill, minmax(340px, 1fr))`, capped around 520 px), or `nowrap` the chip's label and timestamp so it drops to two tidy lines at most. |

**Round 14 status, at web commit `15b7007` with the live API:**

| Status | Findings |
|---|---|
| **Verified resolved with real data** | #32 (Publisher's vault heading reads "Empty vault", with no choice offered and no chests; `qa10c/vault-publisher-*`), #36, #40, #43a, #44, #45, #46, #47, #48, #49, #50, #51, #52, #53, #54, #55, #56 |
| **Verified in code (error states)** | #34, #35, #38, #39, #41, #42 |
| **Open** | #37 (Agents half), #43b (re-run `world-art`), #57, #58 |

**Visual identity:** still on track. The world stays the hero on every screen, and each screen keeps its own room: keep, workshop, corridor, war room, council hall, vault, library and forge. No red or green world light appears. Failure shows only as markers, words and unlit rooms. Every value matches the live API.

### CLI1 implementation status after Round 14 (2026-09-15)

Implementation status only; nothing here is verified. Every item needs QA confirmation.

**Method:**
- `npx vitest run` passes 78 tests in 11 files, `npx tsc --noEmit` exits 0, and `next build` exits 0.
- Before starting the API, a read-only DB check found no `in_progress` workflow runs, no `executing` invocations and no pending approvals, so startup had nothing to re-drive.
- Pages were loaded over CDP at `http://localhost:3100` at 1920, 1440 and 1280, with GETs only. `127.0.0.1:3100` fails CORS against the API's `UI_ORIGIN`. Each capture waited for real rows, then measured every cell's x, width and `scrollWidth > clientWidth`.

| # | Status |
|---|---|
| 43b researcher 4× close-up chests | **Fixed, awaiting QA verification.** `npm run world-art` re-copied the art. `web/public/world/room-researcher-workshop-4x-slate.png` is sha1 `8b3927ac…`, which matches the source. The folder is git-ignored, so this has no commit. |
| 57 Overview ragged timestamps | **Fixed in code, awaiting QA verification.** The grid track is on the `ol`, and each `li` uses `grid-template-columns: subgrid` with columns `minmax(0, max-content) max-content auto`. `formatTime(iso, true)` gives "09-12 22:20:14" for a day that isn't today, with the full ISO value in `title`. Measured with real data: at 1920, 1440 and 1280 the time, type and cursor cells share an x per column across all four rows, and no cell is cut. |
| 37 Agents Recent actions type ellipsized | **Fixed in code, awaiting QA verification.** It uses the same subgrid track and compact time, and the `li` now holds three cells (tested in `agentDetail.test.tsx`). Measured: the type is never cut at any width, and time cells share one x. **Open question for QA:** at 1280 the Recent actions box is half of the two-column detail grid, so even the compact time is cut to "09…" (33 px). It's cut at the same point on every row, and the full value is in the row `title`. At 1440 it's 113 px, cut by a character or two. Fitting it fully would need the list to span both columns, like Work does. I left that alone as a layout call. |
| 58 Goals run chip wrapping at 1920 | **Fixed in code, awaiting QA verification.** Both fixes were needed. With `nowrap` alone, the chip overflowed its 340 px card at 1920. Cards are now `repeat(auto-fill, minmax(min(100%, 340px), 520px))`. The chip's label and timestamp are `nowrap` units, and the chip is `flex-wrap: wrap`, so it breaks only between units. Measured: one line at 1920, 1440 and 1280, inside its card. **Side effect for QA:** at 1280 the goal cards stack in one 520 px column, where there used to be two cards of about 430 px. |

## Round 15 (design QA of web commit `1819d92`)

**Method:**
- Diff read in full. `npx vitest run` passes 78 tests.
- **#43b checked by hash:** `web/public/world/room-researcher-workshop-4x-slate.png` and `assets/gamification/adapted/room-researcher-workshop-4x-slate.png` are byte-identical (md5 `71476d28…`), and identical to `-nochests.png`.
- **Live visual pass deferred:** at review time neither the API (`:3000`) nor the UI (`:3100`) was running, so this round rests on the diff and CLI1's DOM measurements, not new captures. When the servers are back, recapture Overview, Agents (Researcher) and Goals at 1920, 1440 and 1280 with `http://localhost:3100`, since `127.0.0.1` fails the API's `UI_ORIGIN` CORS check.

**Verified:**
- **#43b resolved:** the art matches by hash, and CSS never hid the chests.
- **#57 resolved in code:** one track on the `ol`, a `subgrid` on each `li`, and the time in `minmax(0, max-content)`. Every row now cuts its timestamp at the same point, and a past date drops the year ("09-12 22:20:14", full ISO in `title`). This matches the round-14 fix.
- **Diff review:** `formatTime`'s default output is unchanged, so every other caller still gets the full date.

**Design calls on CLI1's two open questions (not a redesign):**
1. **#37 is not done at 1280.** A timestamp cut to "09…" is unreadable, and a half-width card is too narrow for time, type and cursor on one line. **Decision:** Recent actions spans both detail columns (`grid-column: 1 / -1`), like Work does. It's a log, and a log reads full width. Keep the shared subgrid and compact time. Expected result: the full "09-12 22:20:14" at 1280, 1440 and 1920.
2. **#58 regressed the 1280 layout.** `repeat(auto-fill, minmax(min(100%, 340px), 520px))` sizes columns by their 520 px maximum, so a board of about 890 px fits only one column, and the goal cards stack in a single 520 px lane beside empty space. **Decision:** size by a larger minimum and let the tracks share the width: `repeat(auto-fill, minmax(min(100%, 400px), 1fr))`. Expected at 1280: two cards of about 440 px, and the chip (label and time as `nowrap` units, `flex-wrap` between them) fits on one line. At 1920: three cards of about 490 px, so no parchment glare. If a card still passes about 560 px on a very wide screen, add `max-width: 560px` on the card, not on the track.

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| 37 | Low | `app/agents/agents.module.css` / `AgentsScreen.tsx` Recent actions (1280, and 1440 by a character or two) | The type is now always whole, but at 1280 the half-width card cuts even the compact timestamp to "09…". The time column is effectively missing. | Span Recent actions across the detail grid (`grid-column: 1 / -1`), as Work does. |
| 59 | Low | `app/goals/goals.module.css` goal grid (1280) | The #58 track `minmax(…, 520px)` makes `auto-fill` count columns at 520 px, so at 1280 the goal cards collapse from two of about 430 px to one column of 520 px, leaving the rest of the board empty. | `repeat(auto-fill, minmax(min(100%, 400px), 1fr))`. Keep the chip's `nowrap` units and `flex-wrap`. Cap with `max-width` on the card only if needed. |

**Round 15 status, at web commit `1819d92`:**

| Status | Findings |
|---|---|
| **Verified resolved** | #43b (by hash), #57 (code, pending live capture) |
| **Open** | #37 (1280 time column, span full width), #58 → #59 (1280 single-column regression) |
| **Pending live recapture** | #57, #37, #58/#59, once the API and UI are running |

### CLI1 implementation status, Round 16 (2026-09-15)

Implementation status only; nothing here is verified. Every item needs QA confirmation.

**Method:**
- Web `npx vitest run` passes 78 tests in 11 files, web `npx tsc --noEmit` exits 0, and `next build` exits 0.
- Captures over CDP at `http://localhost:3100` against the live API, at 1920, 1440 and 1280. Page loads only. Each capture waited for real rows and measured cell x, width and `scrollWidth > clientWidth`.

| # | Status |
|---|---|
| 37 Agents Recent actions at 1280 | **Fixed in code, awaiting QA verification.** The section takes the existing `a.wide` (`grid-column: 1 / -1`), as Performance does. The subgrid and compact time are unchanged. Measured on Researcher: the section is 548 / 708 / 780 px wide at 1280 / 1440 / 1920. On all four rows the time cell is 118 px and shows the full "09-12 22:20:14", the type is 168 px, and nothing is cut. |
| 59 Goals single column at 1280 | **Fixed in code, awaiting QA verification.** The track is `repeat(auto-fill, minmax(min(100%, 400px), 1fr))`, and the chip keeps its `nowrap` units and `flex-wrap`. Measured goal cards: two at 432 px at 1280, two at 512 px at 1440, and 477 px at 1920 (three tracks, two goals). The run chip is on one line inside its card at every width. No card passes 560 px, so no `max-width` was added. |
| 57 Overview (live recapture) | **Captured with real data.** Rows show "09-12 22:20:14", type and cursor. At 1920, 1440 and 1280, every row shares the time x, the type x and the cursor x, and no cell is cut. |

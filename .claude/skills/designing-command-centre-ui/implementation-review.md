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

**Review environment note for CLI1:** the API on port 3000 answered 404 for `GET /goals`, `/workflow-runs` and `/execution-stops` (2026-09-15), though those routes exist in `src/api/routes`. The process looks older than the code. The UI correctly showed "n/a" and stops-unreadable warnings. Restart the API before a visual review, so screenshots show real data rather than error states.

**API gap confirmed for CLI1** (don't fake it): the event-arrival room flash (`visual-language.md` Motion) needs the Agent Definition id, or a run id resolvable to one, on `EventDisplayItem`. Today only the notice strip reacts to events.

**Not yet reviewable:** the screen pages (`app/page.tsx`, `agents`, `approvals`, `goals`, `workflows`) are still the pre-pixel versions. A visual review at 1920, 1440 and 1280 follows once they are rebuilt and the web app runs against the API.

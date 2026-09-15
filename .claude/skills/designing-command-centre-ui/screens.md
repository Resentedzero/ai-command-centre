# Screens: one world, different rooms and views

Each screen answers a different operator question, so each gets its own composition. What they share is the language in `visual-language.md`, not a layout. Screen numbers follow spec §15.1.

"Build status" means the state of the data the screen needs, not its styling.

| Screen | Operator question | Composition | World share | Data (see `runtime-truth.md`) | Build status |
|---|---|---|---|---|---|
| **Overview** (1) | Is the system working, and where must I act? | A scrollable map (D16), a viewport panned by drag or scroll. The minimap was removed in cycle 4, once the whole keep fits the default view. The dungeon keep sits at the centre, surrounded by ambient wilderness. The keep holds system rooms on a main corridor and one room per active agent around the central hub. The pixel top bar (`PixelTopBar`) holds the live connection, pending approvals and active count. A board on the right shows the selected room's agent. A notice strip runs along the bottom edge. | 70–75% | `GET /agents/active`, `GET /approvals`, SSE | Data exists (restyle). Figma frame `33:2` on the Overview page, with its design note in `34:25` and the full map in `46:655`. **Approved for now** by the operator on 2026-09-14, and may be revised later. (Those node ids are the superseded sci-fi frames; the pixel screen and its state frames are listed below.) |
| **Agents** (2) | What is this agent doing, why, and can I stop it? | One room at large scale on the left: character, station, sigils. A dense inspector on the right: lineage (goal → workflow → step → invocation), grants as keys, context-lineage tier bars, one per-unit gauge per unit, and the stop control always visible. | 50–60% | `GET /agents/:id` | Data exists. An all-agents roster needs a new route (active agents only today). Figma frame `52:2` on the Agents page, with its design note in `52:217`. |
| **Workflows** (3) | Where is this run in its sequence, and what failed? | Structural. A corridor of rooms, left to right, in step order, with the current step lit. Below it, a dense invocation timeline per step: kind, status, failure reason, per-unit budget. | 40–50% | `GET /workflow-runs[/:id]` | Data exists. Linear only; no branching visuals. Figma frame `57:2` on the Workflows page, with its design note in `57:327`. |
| **Goals** (5) | What missions exist, and how are they going? | A war-table or mission board. Projects are wings of the map; goals are banners with their workflow runs as small corridors. The start-goal form keeps its cost and non-idempotency warnings. | 30–40% | `GET /goals`, `createGoal` | Data exists. Figma frame `59:2` on the Goals page, with its design note in `59:203`. |
| **Approvals** (4) | What exactly am I being asked to allow? | Reading-first. A small vignette of the sealed station for context, then the exact snapshot, capability and permission, risk tier, TTL, the content preview as plain text, and the hash-match state. Approve and reject are large, plain and never decorative. | 15–25% | `GET /approvals`, approve/reject | Data exists. Figma frame `56:2` on the Approvals page, with its design note in `56:170`. |
| **Events** | What happened, and in what order? | A dense timeline in mono: time, event type glyph, summary. World glyphs sit in the margin as type markers. Filter by type. Shows live or reconnecting state. | 10–20% | SSE `GET /events/stream` | Feed exists. No dedicated page or filter route yet. Figma frame `60:2` on the Events page, with its design note in `60:204`. |
| **Artifacts** (8) | What did the agents produce, and where did it come from? | An archive room: shelves of scrolls and tablets by type, and a reading pane with provenance (producing invocation → run → agent). | 30–40% | `GET /artifacts/:id`, `AgentDetail.outputs` | **Partly gated.** Detail route exists; no list route and no `api.ts` client yet. |
| **Registry** (6) | What are agents allowed to do? | Armory or vault: definitions and grants, with autonomy state per grant | 20–30% | `GET /registry` (all definitions, capabilities, grants) | **Read-only, route exists (2026-09-15).** Still no write routes; autonomy changes are safety-critical (spec §9.4). The armory can list every Agent Definition and its grants, not just active agents. Pixel frame: "Registry — pixel armory (gated: read-only)" on the Artifacts/gated page. It is reached from the Agents tab (no top-bar slot), with one key per grant in the 4× room and a read-only line instead of controls. |
| **Cost** (7) | What is being consumed, by unit? | Hub telemetry room: one gauge per resource unit per scope, never summed | 20–30% | `GET /costs` (counters, per-scope totals, cost vs success) | **Route exists (2026-09-15).** API-summed totals per (scope, unit) for run, task instance, agent definition, goal and day may be shown, one card per unit, never added across units. Cost vs success is a measurement with its `sampleCount`, listed in a stable order and never ranked. The frame notes below predate this route; where they say "no day/goal totals", the route now provides them. Pixel frame: "Cost — pixel ledger (gated: per run and per agent only)" on the Artifacts/gated page. It is reached from the Workflows tab. It shows one card per `resourceUnit` counter (limit, reserved, consumed) and per-agent `budgetTotals`. A gauge is drawn only once values have loaded; an empty track would read as a half-full meter. A small bevel-framed engine-room view gives it a room (the forge burns fuel) without claiming any value. There are no summed totals and no day/goal/global totals. |

A world share below 65% is intentional for screens where exact text is the job.

**Pure-pixel direction (D19), current source of truth.** Promoted 2026-09-14: each final pixel screen now sits at (0, 0) on its `04 — Screens` page, with a pixel design note at x 2000. The superseded sci-fi HUD frames were moved to x ≥ 6000 and prefixed `[superseded: sci-fi HUD]`. Registry and Cost stay gated (no write routes, no scope totals), but now have pixel frames on the Artifacts/gated page (see their rows above). The earlier pixel iterations remain on `05`.

**Pixel state frames** (on the `04` pages, built from clones of the final screens):
- **Overview** (y 1300 and y 2500 rows): live feed offline, no active agents, loading, load failed.
- **Agents:** execution stop active.
- **Approvals:** nothing pending.
- **Workflows:** step 2 failed.
- **Goals:** no goals yet (counts of rows returned = 0); start goal failed (the `createGoal` error, with a non-idempotency hint: check the goal list before retrying).
- **Events:** feed reconnecting (missed events replay from `sinceEventCursor`); no events received yet.
- **Artifacts** (y 1300 and y 2500): content hash mismatch (`contentHashMatches` false: red marker, preview marked untrusted); artifact not found (`GET /artifacts/:id` 404); agent has no outputs (empty vault, no chests).

State rules applied: unloaded or failed means no room is lit; zero counts and offline or connecting chips are neutral, never amber or green; a halted agent's status is a skeleton until the API returns it, never cyan "active" in an unlit room.

**Laptop sizes** (measured on "@1440×900" and "@1280×800" variants of Overview and Approvals, on their `04` pages):
- **Top bar:** its full minimum width is 1471 px. At 1440 px wide or less, hide the "Command Keep" title and keep the crystal emblem; that brings it to 1223 px. The seven 120 px tab slots stay.
- **Overview:**
  - The world viewport shrinks and pans the full keep (D16); the board is 400 px.
  - Stop moves directly under the agent heading, so the safety control is never below the fold.
  - Below 1080 px tall, drop the 4× portrait: the room already shows the sprite and the heading names the agent. The board content is then 712 px and fits both an 844 px and a 744 px board.
- **Approvals** (reading-first):
  - The queue narrows to 340 or 300 px.
  - The reading area becomes a vertical stack with wrapping rows, so the request card drops under the vignette and still ends above the fold (578 px, within 704 / 604).
  - Previews and the snapshot scroll inside the area.
  - Approve and Reject stay pinned in the action bar at every size.
- **The other five screens** have "@1280×800" variants on their `04` pages, measured the same way:

  | Screen | Laptop layout | Above the fold (of 700 px) |
  |---|---|---|
  | **Agents** | 240 px roster; a 400 px world column shows a centred crop of the 4× room; the detail board's columns wrap and scroll. | Stop ends at 120 px. |
  | **Workflows** | 280 px runs board. The corridor pans so the step needing attention is centred (clamped at both ends); step detail wraps below. | Step 2 plaque at x 380–621 of 32–968. |
  | **Goals** | 320 px start-goal form; war room, summary and projects wrap and scroll. | Start goal ends at 404 px. |
  | **Events** | The library strip keeps 356 px and the header card fills the rest. The log fills the height; the summary column shrinks and truncates (976 → 360 px) so the cursor column stays visible. Filter chips wrap to a second row and the header card grows to hold them (140 → 170 px). | 14 of 20 rows; the log scrolls. |
  | **Artifacts** | 280 px output list; vault, metadata and reading panels wrap and scroll. | Heading ends at 336 px, hash check at 476 px. |

- **Pattern:** world-first screens pan or crop their world and narrow their board; reading-first screens stack and scroll with act-now controls pinned. A world view pans to the element that needs attention, never just to its left edge. Below 1280 × 800 is not designed.

The frame names below are the pre-promotion names used on page 05:
- **Overview:** "Overview A5 — pixel keep (cycle 5 cohesion fixes)". Earlier A–A4 frames are the review trail.
- **Agents:** "Agents v2 — pixel (cycle 5 cohesion fixes)".
- **Approvals:** "Approvals v2 — pixel (cycle 5 cohesion fixes)".
- **Shared top bar:** component `PixelTopBar` on `03 — Components`, with `active` = Overview | Agents | Workflows | Goals | Approvals | Artifacts | Events.
- **Remaining screens, also in this direction** (same page), following the rules at the end of cycle 5 in `design-reviews.md`:
  - "Workflows — pixel (corridor of steps)"
  - "Goals — pixel (war room)"
  - "Events — pixel (dense log)"
  - "Artifacts — pixel (vault)"
- **Artifacts is no longer fully gated.** `GET /artifacts/:id` exists: detail, preview, provenance and referencedBy. There is still no list route (browsing is per agent via `AgentDetail.outputs`) and no `web/lib/api.ts` client yet.
- The `[superseded: sci-fi HUD]` frames listed below are the earlier direction, kept for reference only.

Figma status (2026-09-14):
- **State frames:**
  - Overview: offline, no active agents, loading, load failed.
  - Agents: execution stop active.
  - Approvals: nothing pending.
  - Workflows: failed step.
- **Gated screens** (Artifacts, Registry, Cost) are designed on the Gated page. Only existing read models are used. The superseded sci-fi frames marked gated sections with a dashed amber border. The pixel frames don't, because amber means waiting; they state the limit in a plain read-only line instead. They are not built until their routes exist.

## Per-screen design notes

Before designing a screen, write a short note (in the Figma page description, or `web/design/<screen>.md` once implementation starts) with:
1. The operator question, in one sentence.
2. Its hierarchy, as three tiers: act now / working / detail.
3. The world composition, and what each world object represents.
4. Every displayed value and its `api.ts` source. Values without a source go under "Proposed API fields".
5. Which state treatments from `tile-pack.md` appear.

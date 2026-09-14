# Screens: one world, different rooms and views

Each screen answers a different operator question, so each gets its own composition. What they share is the language in `visual-language.md`, not a layout. Screen numbers follow spec §15.1.

"Build status" means the state of the data the screen needs, not its styling.

| Screen | Operator question | Composition | World share | Data (see `runtime-truth.md`) | Build status |
|---|---|---|---|---|---|
| **Overview** (1) | Is the system working, and where must I act? | A scrollable map (D16), a viewport panned by drag or scroll, with a minimap in the inspector column. The dungeon keep sits at the centre, surrounded by ambient wilderness. The keep holds system rooms on a main corridor and one room per active agent around the central hub. A thin top HUD strip holds the live connection, pending approvals and active count. An inspector slides in from the right on room select. An event ticker runs along the bottom edge. | 70–75% | `GET /agents/active`, `GET /approvals`, SSE | Data exists (restyle). Figma frame `33:2` on the Overview page, with its design note in `34:25` and the full map in `46:655`. **Approved for now** by the operator on 2026-09-14, and may be revised later. The empty and offline state frames are still to draw. |
| **Agents** (2) | What is this agent doing, why, and can I stop it? | One room at large scale on the left: character, station, sigils. A dense inspector on the right: lineage (goal → workflow → step → invocation), grants as keys, context-lineage tier bars, one per-unit gauge per unit, and the stop control always visible. | 50–60% | `GET /agents/:id` | Data exists. An all-agents roster needs a new route (active agents only today). Figma frame `52:2` on the Agents page, with its design note in `52:217`. |
| **Workflows** (3) | Where is this run in its sequence, and what failed? | Structural. A corridor of rooms, left to right, in step order, with the current step lit. Below it, a dense invocation timeline per step: kind, status, failure reason, per-unit budget. | 40–50% | `GET /workflow-runs[/:id]` | Data exists. Linear only; no branching visuals. Figma frame `57:2` on the Workflows page, with its design note in `57:327`. |
| **Goals** (5) | What missions exist, and how are they going? | A war-table or mission board. Projects are wings of the map; goals are banners with their workflow runs as small corridors. The start-goal form keeps its cost and non-idempotency warnings. | 30–40% | `GET /goals`, `createGoal` | Data exists. Figma frame `59:2` on the Goals page, with its design note in `59:203`. |
| **Approvals** (4) | What exactly am I being asked to allow? | Reading-first. A small vignette of the sealed station for context, then the exact snapshot, capability and permission, risk tier, TTL, the content preview as plain text, and the hash-match state. Approve and reject are large, plain and never decorative. | 15–25% | `GET /approvals`, approve/reject | Data exists. Figma frame `56:2` on the Approvals page, with its design note in `56:170`. |
| **Events** | What happened, and in what order? | A dense timeline in mono: time, event type glyph, summary. World glyphs sit in the margin as type markers. Filter by type. Shows live or reconnecting state. | 10–20% | SSE `GET /events/stream` | Feed exists. No dedicated page or filter route yet. Figma frame `60:2` on the Events page, with its design note in `60:204`. |
| **Artifacts** (8) | What did the agents produce, and where did it come from? | An archive room: shelves of scrolls and tablets by type, and a reading pane with provenance (producing invocation → run → agent). | 30–40% | `GET /artifacts/:id`, `AgentDetail.outputs` | **Partly gated.** Detail route exists; no list route and no `api.ts` client yet. |
| **Registry** (6) | What are agents allowed to do? | Armory or vault: definitions and grants, with autonomy state per grant | 20–30% | Grants inside `AgentDetail` only | **Gated.** No write routes. Autonomy changes are safety-critical (spec §9.4). |
| **Cost** (7) | What is being consumed, by unit? | Hub telemetry room: one gauge per resource unit per scope, never summed | 20–30% | Per-run and per-agent budgets only | **Gated.** No scope-level read model. |

A world share below 65% is intentional for screens where exact text is the job.

**Pure-pixel direction (D19), current source of truth.** Promoted 2026-09-14: each final pixel screen now sits at (0, 0) on its `04 — Screens` page, with a pixel design note at x 2000. The superseded sci-fi HUD frames were moved to x ≥ 6000 and prefixed `[superseded: sci-fi HUD]`. Registry and Cost stay gated, with no pixel version. The earlier pixel iterations remain on `05`.

**Pixel state frames** (on the `04` pages, built from clones of the final screens):
- **Overview** (y 1300 and y 2500 rows): live feed offline, no active agents, loading, load failed.
- **Agents:** execution stop active.
- **Approvals:** nothing pending.
- **Workflows:** step 2 failed.

State rules applied: unloaded or failed means no room is lit; zero counts and offline or connecting chips are neutral, never amber or green; a halted agent's status is a skeleton until the API returns it, never cyan "active" in an unlit room.

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
- **Gated screens** (Artifacts, Registry, Cost) are designed on the Gated page. Only existing read models are used, and the gated sections are marked with a dashed amber border. They are not built until their routes exist.

## Per-screen design notes

Before designing a screen, write a short note (in the Figma page description, or `web/design/<screen>.md` once implementation starts) with:
1. The operator question, in one sentence.
2. Its hierarchy, as three tiers: act now / working / detail.
3. The world composition, and what each world object represents.
4. Every displayed value and its `api.ts` source. Values without a source go under "Proposed API fields".
5. Which state treatments from `tile-pack.md` appear.

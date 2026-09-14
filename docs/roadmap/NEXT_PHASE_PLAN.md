# Next-Phase Plan — From the V1 MVP to the Full AI Command Centre Vision

**Status: advisory planning documentation only. This document authorizes nothing.**
No runtime code, UI code, database schema, configuration, or the frozen architecture
spec was modified to produce it. Every claim below is sourced from
`docs/superpowers/specs/2026-09-12-ai-command-centre-design.md` (Phases 1–20,
frozen) or from direct inspection of the current V1 codebase (`src/db/schema.ts`,
Units 1–11) — nothing here invents new infrastructure "because it could be
useful." Where this plan proposes work not explicitly named in the frozen spec,
it says so and ties the proposal back to an existing Phase 19 roadmap stage or a
Phase 14 rubric evaluation, never to convenience alone.

Implementation of anything in this document requires separate, explicit
authorization. This is planning only.

## 0. Governing principle (restated from Phase 19)

> "Staged by evidence, not calendar time — each stage advances when a concrete
> need or enough real data exists, not on a schedule."

Every section below inherits this. "Complexity: Small" does not mean "build it
next" — it means "cheap once the evidence/prerequisite arrives." The single
biggest risk this document is written to avoid is Phase 20 Risk #1: **scope
creep back into "a collection of chatbots"** by building integrations, UI
surfaces, or infrastructure because they are convenient or novel rather than
because a real, existing, near-term need clears the Phase 14.2 rubric.

## 1. Master roadmap timeline (Phase 19, restated and cross-referenced)

This table is the frozen roadmap's own staging, verbatim in substance, with each
of this document's 15 numbered work items mapped onto it. Nothing in this table
is new — it is Phase 19 reorganized as a lookup.

| Stage | Frozen-spec content (Phase 19) | Work items in this doc |
|---|---|---|
| **V1** (done — this is the MVP just completed) | Two workflows, full governance chain proven once, manual process start, minimal UI (Overview/Activity/Approvals) | — |
| **V1.1** | NSSM service wrapping (unattended operation); UI expands to Agent Detail, Workflow graph, Registry admin UI | §4 Agent Detail, §5 Workflow Visualization, §6 Registry |
| **V2** | `agent_performance` + `agent_xp_projection` come online; Cost dashboard and gamification UI surfaces appear, backed by real projections | §1 Gamified UI, §2 Tile Pack, §3 Gamification Projections, §7 Cost/Budget Views, §9 Agent Performance |
| **V3** | New Capabilities strictly per Phase 14 rubric; Workflow Interpreter gains branching/looping only once a real workflow needs it; Memory scopes implemented only against concrete gaps | §10 Advanced Branching/Loops, §11 Memory Implementation, §15 Future Integrations, (Memory/Artifact browser half of §8) |
| **V4** | Model Router's confidence-based escalation loop activates; `CONDITIONAL` autonomy activates (with a defined minimum sample-size/confidence criterion); pgvector/Langfuse/evaluation reconsidered only on concrete gap | §12 Model Routing/Escalation, §14 Evaluation/Quality |
| **V5** | Capabilities progressively graduate `ALWAYS_APPROVE → CONDITIONAL → AUTONOMOUS`, always by explicit logged human decision; SPEND/TRADE/PUBLISH/DELETE keep their ceiling indefinitely | §13 Progressive Autonomy |
| **V6+** | Multi-user generalization or a move off single-machine infra, only if the platform genuinely outgrows solo use | (not separately sectioned below — see §15's closing note) |

The rest of this document expands each work item with purpose, dependencies,
architectural components affected, frozen-spec status, complexity, risks,
prerequisites, and explicit non-goals — in the order the user requested, not
roadmap order.

---

## 2. Work items

### 1. Gamified Command Centre UI (presentation layer)

- **Purpose:** A stylized ("sci-fi ops center") presentation layer over the
  same data every other screen uses — visual polish, not new functionality.
- **Dependencies:** Phase 15's screens must exist first (Overview exists at V1;
  Agent Detail/Workflow/Registry arrive at V1.1). Needs `agent_xp_projection`
  (§3) if XP is to be shown, which needs the async projection loop.
- **Architectural components affected:** `web/` only. Zero backend/schema
  changes — Phase 15.4 is explicit that this is styling over existing
  projections.
- **Frozen-spec status:** Specified. Phase 15.4: "the 'sci-fi ops center'
  aesthetic... is styling over the data sources above," and the boundary is
  explicit: "must never read raw Events directly, make business decisions,
  award XP, or contain runtime logic."
- **Roadmap stage:** V2 ("gamification UI surfaces appear, now backed by real
  projections instead of imagined mockups" — Phase 19).
- **Complexity:** Medium (mostly CSS/component work, but real work: glowing
  status indicators, progress bars, agent-card layout per Phase 15's original
  mockup intent).
- **Major risks:** (a) Building this before `agent_xp_projection`/
  `agent_performance` exist produces "imagined mockups" against fake data —
  Phase 19 explicitly calls this out as the wrong order. (b) Blurring the
  Phase 15.4 boundary by letting a component compute a derived value
  client-side instead of rendering a server-provided one.
- **What must be built first:** Agent Detail/Workflow/Registry (V1.1, §4–§6),
  then `agent_xp_projection` (V2, §3) and `agent_performance` (V2, §9) so the
  gamified surfaces have real data to render.
- **What must NOT be built yet:** Any XP bar, level indicator, or leaderboard
  before `agent_xp_projection` exists and is populated by real Events — Phase
  16.3's idempotent-projection guarantee must exist before any UI reads it, or
  the UI will display numbers that can silently double-count on a crash
  replay.

### 2. Tile Pack Integration

- **Purpose:** Determine if/how the already-unpacked "Pixel Crawler - Free
  Pack" asset pack (`assets/gamification/Tile Pack/`) contributes art to the
  gamified UI in §1.
- **Dependencies:** §1 (Gamified UI) must be underway; an explicit
  art-direction decision (see below) must be made first.
- **Architectural components affected:** `web/public/` (or equivalent static
  asset directory) only, if adopted. Per `docs/gamification/TILE_PACK_INVENTORY.md`'s
  own recommended structure, sliced/exported assets would live under
  `web/public/sprites/agents/`, `web/public/sprites/world/`, never touching
  Events/Runs/Invocations/business logic.
- **Frozen-spec status:** Not specified as a required asset source. Phase
  15.4 names a "pixel-art tileset/game-world view" as one *possible* future
  presentation layer, not a commitment to this specific pack. The already-completed
  inventory (`docs/gamification/TILE_PACK_INVENTORY.md`) found: **no direct
  match for the actual V1–V2 UI needs** (no status indicators, no
  progress/XP/badge assets, no UI chrome anywhere in the pack's 169 exported
  PNGs). Its one genuine, non-speculative tie to the spec is Phase 15.4's
  "pixel-art tileset/game-world view" idea — the tilesets/buildings/stations
  are coherent scenery *for that specific idea only*, if it is ever pursued.
- **Roadmap stage:** V1.1/V2 at the earliest per the inventory's own
  classification (nothing rated HIGH priority; the inventory's MEDIUM-priority
  items are contingent on decisions not yet made).
- **Complexity:** Small if only used for a literal game-world map view (assets
  are ready, just need slicing); Medium-to-Large if used for agent avatars,
  since it requires sprite-sheet slicing (no pre-sliced frames exist anywhere
  in the pack) and an explicit reconciliation of the pack's fantasy-dungeon
  aesthetic against the spec's stated "sci-fi ops center" visual framing
  (Phase 1/15.4) — these are stylistically inconsistent, and the inventory
  explicitly declined to resolve that inconsistency.
- **Major risks:** (a) Committing to a mismatched aesthetic (dungeon-crawler
  art in a "sci-fi ops center") without an explicit human art-direction
  decision — the inventory flags this exact risk and deliberately does not
  make the call. (b) Treating "the assets happen to exist in the repo" as
  justification for using them (the Phase 14.2 rubric's "usefulness" test
  applies to art assets too, in spirit — an asset earns its use by fitting a
  real screen's real need, not by already being present).
- **What must be built first:** §1's gamified UI framework and an explicit
  human decision: (a) lean into this pack's dungeon aesthetic, (b) source a
  sci-fi/ops-center-themed pack instead, or (c) keep the UI icon/typography-only
  with no illustrated agent avatars.
- **What must NOT be built yet:** Any asset pipeline that copies the *whole*
  338-file pack into `web/`. The inventory is explicit: only a small,
  deliberately-chosen subset should ever be copied out, never the whole
  directory, and `.aseprite` source files must never ship to the frontend (not
  browser-renderable). The one icon-relevant file
  (`Icons/Resources.aseprite`) has no PNG export and cannot be evaluated for
  use — let alone shipped — until someone exports it.

### 3. Gamification Projections (XP / progression)

- **Purpose:** `agent_xp_projection` — a pure, async, derived aggregate over
  Events, purely for the Command Center UI's motivational display (leaderboard,
  agent-card XP bar).
- **Dependencies:** The async projection loop infrastructure itself (Phase
  8.3's "background loop reading new events via `sequence_no` watermarks,
  still just Postgres, no broker" — needed by §9 `agent_performance` too, so
  this infrastructure should be built once and shared).
- **Architectural components affected:** New `agent_xp_projection` table
  (Phase 12), a new async projector process/loop (Phase 8.10: "an in-process
  background loop... no new service"), new read-only API routes, new UI
  surfaces (§1).
- **Frozen-spec status:** Fully specified, Phase 16 entire + Phase 8.6. Key
  binding constraints already designed: (a) XP is computed only by the async
  XP Projector reading Events, never authored by an agent inline (16.1); (b)
  the Projector must be idempotent, keyed by `event_id`, never double-counting
  on replay (16.3); (c) **XP must never be interchanged with
  `agent_performance`** — only `agent_performance` may ever feed a Policy or
  Model Router decision (16.2, restated in Phase 8's central claim).
- **Roadmap stage:** V2, explicitly ("agent_performance and agent_xp_projection
  (both deferred at V1) come online").
- **Complexity:** Medium. The projection logic itself is a small pure function
  over event patterns; the non-trivial part is the idempotent, crash-safe
  async loop infrastructure (shared with §9).
- **Major risks:** (a) The Phase 16.2 boundary violation risk is the single
  most important one to actively test for at review time: any code path where
  a UI component, Policy check, or Model Router decision reads
  `agent_xp_projection` instead of `agent_performance` is a Critical finding,
  not a Minor one. (b) Non-idempotent replay handling causing double-counted
  XP after any crash-recovery replay.
- **What must be built first:** The shared async-projector infrastructure
  itself. *(Corrected 2026-09-14: this section originally said that
  `task_instance_completed` and `artifact_created` were "already-emitted" in V1.
  They were not. They have been emitted since the lifecycle-events change; see
  the spec §8.2 implementation note. `artifact_referenced` is still not emitted,
  so the "artifact created + referenced" XP rule needs it first.)*
- **What must NOT be built yet:** The "human-graded high-value outcome ->
  largest XP" rule (Phase 16.1's fourth bullet) — it explicitly depends on
  Phase 8.9's evaluation system, which is itself deferred to V4. Build the
  first three XP rules at V2; defer the fourth until §14 lands.

### 4. Agent Detail Views

> **BUILT (2026-09-14).** `GET /agents/:id` and `web/app/agents/[id]`, with the
> agent-scope emergency stop (engage, and lift by stop id) through
> `/execution-stops`. Performance is shown as unavailable until
> `agent_performance` exists. The pause/stop mechanism questioned below exists:
> see Appendix A #2. Spec §15.1 implementation note.

- **Purpose:** Per-Agent-Definition drill-down: current Task Instance and its
  Goal/Workflow Run lineage, current Invocation, capabilities in use (context
  lineage), recent actions (event trace), outputs (Artifacts), performance,
  token usage/cost, permissions (read-only Grant display), and pause/resume/stop
  controls.
- **Dependencies:** None beyond what V1 already has for most fields — `runs`,
  `task_instances`, `events`, `budget_counters`, `capability_grants`, and
  `artifacts` all already exist and are populated. The "performance" field is
  the one exception (needs §9, `agent_performance`, deferred to V2) — this
  screen can ship at V1.1 with that one panel simply absent/deferred, same
  discipline Phase 18.1 already applied to the Overview screen.
- **Architectural components affected:** New read-only API routes (thin joins,
  same shape as Unit 11's `GET /agents/active`), new `web/app/agents/[id]/`
  page and components. Pause/resume/stop are **not** new Invocations (Phase
  15.2) — they are deterministic control-plane API commands hitting Phase
  9.7's emergency-pause mechanism (an immediate synchronous Postgres row flip),
  which already exists in the frozen design but was not built as part of V1's
  Unit 1–11 scope (worth confirming at V1.1 planning time whether Unit
  10's API surface needs a new pause/resume/stop route set, since none exists
  today).
- **Frozen-spec status:** Fully specified, Phase 15.1 screen 2.
- **Roadmap stage:** V1.1, explicitly ("UI expands to Agent Detail...").
- **Complexity:** Medium — mostly composing existing data through new joins;
  the pause/resume/stop control-plane wiring is the one piece with real new
  backend logic (see architectural question in Appendix A about whether V1's
  Unit 10 already covers this).
- **Major risks:** Implementing pause/resume/stop as ad hoc route logic
  instead of routing through Phase 9.7's actual revocation/pause semantics
  (global / per-Agent-Definition / per-Capability-Grant / per-Goal-Workflow-Run
  scopes, and the "revoking a Grant auto-cancels its still-pending Approvals"
  rule) would silently create a second, inconsistent pause mechanism.
- **What must be built first:** Confirm (at V1.1 implementation-planning time,
  not now) whether Phase 9.7's pause/revocation mechanism has a concrete
  Postgres column/flag anywhere in the current schema — it does not appear to
  yet (no pause/revoked flag was found on `runs`, `capability_grants`, or
  `agent_definitions` in the current V1 schema beyond `capability_grants.revoked_at`
  added in Unit 3 for a different purpose — see Appendix A).
- **What must NOT be built yet:** The "performance" panel — leave it visibly
  absent (not showing zeros or placeholder data) until `agent_performance`
  exists at V2, per Phase 18.1's precedent for how V1 already handled fields
  it couldn't populate yet.

### 5. Workflow Visualization

> **BUILT, linear only (2026-09-14).** `GET /workflow-runs[/:id]` and
> `web/app/workflows`, rendering steps as an ordered list with no graph
> library; a library is warranted once branching (§10) exists. Spec §15.1
> implementation note.

- **Purpose:** A Workflow Run's graph (Task Instance nodes + status),
  drillable into a Task Instance's Run(s) and each Run's Invocation sequence.
- **Dependencies:** `workflow_definitions.graph_definition` and
  `task_instances` already exist and are populated by V1 (Units 1, 7).
- **Architectural components affected:** New read-only API route(s) exposing
  a Workflow Run's graph + live task-instance status, a new `web/` page using
  a visual graph library. Zero backend logic changes beyond exposing existing
  data — Phase 15.1 screen 3 is explicit that "the library only renders; the
  Workflow Interpreter (backend) is the only thing that ever decides the
  graph's actual state."
- **Frozen-spec status:** Fully specified, Phase 15.1 screen 3, naming React
  Flow as an example library (not a commitment — "e.g.").
- **Roadmap stage:** V1.1, explicitly ("Workflow graph").
- **Complexity:** Medium — the data-plumbing is straightforward (matches
  existing schema exactly); the graph-rendering itself is genuine new
  frontend work with a real library dependency (would need explicit
  authorization to add, per this plan's "no new frameworks merely for
  convenience" constraint — but a graph-rendering library is not "merely for
  convenience," it is what the spec's own Phase 15.1 screen 3 calls for).
- **Major risks:** Only one worth naming: today's V1 `LinearGraphDefinition`
  (Unit 7's actual implementation) is a linear chain, not a branching graph —
  visualizing it is trivial today, but the visualization component should be
  built generically enough not to assume linearity, since §10 (branching/
  looping) arrives later and the same screen must keep working once the
  underlying graphs stop being linear.
- **What must be built first:** Nothing new — this can be built directly
  against V1's existing `workflow_runs`/`task_instances`/`graph_definition`
  data.
- **What must NOT be built yet:** Any UI affordance implying the graph can
  branch/loop/be edited at runtime — Phase 11 is explicit that Workflow
  topology is fixed per Definition version; only Definitions (not running
  Workflow Runs) can ever change shape, and only through the Registry (§6),
  never through this view.

### 6. Registry (admin UI)

- **Purpose:** Read/edit surface for Agent Definitions, Capability Grants, and
  Policies. Editing creates a new Definition version, never mutates history.
  Where `autonomy_state` changes happen (the explicit-human-action requirement
  behind all progressive-autonomy promotion).
- **Dependencies:** Versioned Definition tables already exist
  (`agent_definitions`, `capability_grants`, `task_definitions`,
  `workflow_definitions` — all present in V1's schema with version columns).
- **Architectural components affected:** New CRUD-ish API routes (with real
  authorization/versioning logic behind them — this is not a thin read-only
  join like §4/§5, since **writes** here are the actual mechanism for
  `autonomy_state` promotion, Phase 9.4's single most safety-critical human
  action), new `web/app/registry/` pages.
- **Frozen-spec status:** Specified, Phase 15.1 screen 6 — with one
  discovered gap, see Appendix A: **no `policies` table currently exists in
  V1's schema.** Policy evaluation (`src/governance/policy.ts`) is
  implemented as in-code logic, not data-driven rows, in the current MVP.
  Phase 12's data model does specify a `policies(id, scope, rule_definition,
  version)` table, so this is not a spec contradiction — it is a legitimate
  V1 implementation choice (in-code MVP policy logic, consistent with Phase
  18.1's "V1-real vs V1-stub" philosophy) that V1.1's Registry work will need
  to resolve one way or the other before it can offer a real "edit a Policy"
  surface.
- **Roadmap stage:** V1.1, explicitly ("Registry admin UI (so Definitions no
  longer require redeploying config files by hand)").
- **Complexity:** Large. This is the most safety-critical of the V1.1 items —
  it is the human control surface for `autonomy_state` (Phase 9.4) and for
  editing live authorization data (Capability Grants). Needs careful review
  discipline matching Unit 3/6/9's Opus-level scrutiny, not Unit 4/5/7/8's
  standard-tier review.
- **Major risks:** (a) Allowing an edit that mutates history instead of
  creating a new Definition version (the frozen rule: "editing creates a new
  Definition version, never mutates history"). (b) Allowing `autonomy_state`
  to reach `AUTONOMOUS` for SPEND/TRADE/PUBLISH/DELETE through this UI — Unit
  3's `validateCapabilityGrant` ceiling (a `Set`-based structural check, not a
  runtime `if`) must be re-exercised at this new write path, not assumed to
  still hold just because it held in Unit 6's execution path. (c) The
  in-code-vs-table Policy question above: building a Policies editor against
  no `policies` table would either require inventing one now (real schema
  work, needs its own review) or scoping V1.1's Registry down to Agent
  Definitions + Capability Grants only, deferring Policies editing until a
  `policies` table is justified.
- **What must be built first:** A resolution to the Policies-table question
  (Appendix A) — this determines whether §6 is one deliverable or two.
- **What must NOT be built yet:** Bulk/batch editing, or any UI shortcut that
  lets a human change multiple Capability Grants' `autonomy_state` in one
  action — Phase 9.4 frames autonomy promotion as a deliberate, individually
  logged act; a bulk-promote button works against that intent even if
  technically "explicit."

### 7. Cost and Budget Views

- **Purpose:** `budget_counters` by scope, and the (task type, model tier)
  cost-vs-success comparison from Phase 10.5.
- **Dependencies:** `budget_counters` already exists and is populated by V1
  (Unit 2). The cost-vs-success comparison half needs `agent_performance`
  (§9, V2) — Phase 10.5's "concrete mechanism for discovering when a cheaper
  tier's retry rate makes its total cost per successful outcome higher than a
  stronger tier's" is meaningless without that projection existing.
- **Architectural components affected:** New read-only API routes over
  `budget_counters` (already-existing table, straightforward), new `web/`
  page. The cost-vs-success comparison additionally needs `agent_performance`.
- **Frozen-spec status:** Specified, Phase 15.1 screen 7.
- **Roadmap stage:** V2, explicitly ("Cost dashboard... appear[s]"). Phase
  20 Risk #4 explicitly names the interim state: "In V1 (Cost dashboard
  deferred to V2), this must be watched via direct `budget_counters` queries
  rather than a UI."
- **Complexity:** Small for the basic `budget_counters`-by-scope view (pure
  read-only rollup of existing data); Medium once the cost-vs-success
  comparison is added (depends on §9).
- **Major risks:** Displaying a cost/success comparison before
  `agent_performance` has enough sample size to mean anything — same risk
  Phase 20 Risk #10 names for autonomy/routing decisions, applies equally to
  a human-facing dashboard implying false confidence.
- **What must be built first:** Can ship the basic `budget_counters` view
  immediately (no blockers) even before V2, if a real operational need
  appears earlier — this one sub-piece isn't actually gated on anything
  V1 doesn't already have. The cost-vs-success comparison specifically waits
  for §9.
- **What must NOT be built yet:** Any UI framing of the cost-vs-success
  numbers as a recommendation ("switch to STRONG tier") before Phase 19's V2
  minimum-sample-size/confidence criterion (defined as part of V2's own
  implementation work) exists and is met.

### 8. Memory and Artifact Views

- **Purpose:** Artifacts and Memory Items by scope, with provenance chains
  visible.
- **Dependencies:** Split into two independent halves with very different
  readiness: **Artifacts** already exist and are populated by V1 (Unit 8/9's
  `artifacts` table, `persistInvocationResultAsArtifact`/
  `persistReportArtifact`). **Memory Items** do not exist at all in V1 — no
  `memory_items` table exists in the current schema (confirmed by direct
  inspection), and no memory-scope code exists anywhere in `src/`.
- **Architectural components affected:** Artifact browser: new read-only API
  routes over the existing `artifacts` table, new `web/` page — no blockers.
  Memory browser: entirely blocked on §11 (Memory Implementation) landing
  first.
- **Frozen-spec status:** Specified, Phase 15.1 screen 8 (as one combined
  screen in the spec's list, though this plan treats the two halves
  separately given their very different readiness).
- **Roadmap stage:** The Artifact-browser half has no explicit Phase 19
  gating — it could reasonably ship alongside V1.1's other UI expansion work
  once there's a concrete need to browse Artifacts outside the two Task
  Instances' own detail views. The Memory-browser half is gated on V3
  ("Agent/Project/Organizational memory scopes are implemented only against
  concrete gaps that appear in practice").
- **Complexity:** Small (Artifact browser, read-only join over an existing
  table); the Memory browser's complexity is inherited entirely from §11.
- **Major risks:** Building a "Memory browser" placeholder/stub before §11
  exists, implying a feature is further along than it is — better to omit
  the screen entirely until real data exists behind it (same discipline as
  the Overview screen's revenue-stat rule in Phase 15.1: "a Project with no
  defined revenue-outcome projection simply omits that stat rather than
  showing a fabricated or zero value").
- **What must be built first:** Nothing, for the Artifact-browser half. The
  Memory-browser half needs all of §11.
- **What must NOT be built yet:** The Memory browser, full stop, until §11
  produces real `memory_items` rows to show.

### 9. Agent Performance

- **Purpose:** `agent_performance` — async projection aggregated per Agent
  Definition version: success rate, average cost, average retries, average
  duration, approval-rejection rate, per (task type, model tier) — feeds
  Phase 9.4's `CONDITIONAL` autonomy logic and Phase 10.5's routing.
- **Dependencies:** Same shared async-projector infrastructure as §3
  (`agent_xp_projection`) — build once, feed both projections from it.
- **Architectural components affected:** New `agent_performance` table
  (Phase 12), the shared async projector loop, new read-only API routes for
  §4 (Agent Detail)/§7 (Cost views)/§1 (Gamified UI, if ever surfaced there).
  **Governance-affecting**, unlike §3's XP: this projection eventually feeds
  real Policy/Router decisions (§12, §13), so its correctness bar is the
  Unit-3/6/9 Opus-review tier, not the Unit-4/5/7/8 standard tier.
- **Frozen-spec status:** Fully specified, Phase 8.8. Phase 19 is explicit
  that `agent_performance` "may be displayed in the UI as soon as it exists,
  even before it is statistically meaningful — but it must not be allowed to
  influence Model Router tier-preference adaptation (10.5) or feed Phase
  9.4's `CONDITIONAL` autonomy logic until a defined minimum sample-size/
  confidence criterion is met. Defining and testing that threshold is an
  explicit part of V2's implementation work."
- **Roadmap stage:** V2. The minimum-sample-size/confidence criterion itself
  must be defined and tested as part of this same V2 work — not left for V4
  when `CONDITIONAL` autonomy (§13) actually starts consuming it.
- **Complexity:** Medium-Large. The projection math itself is bounded
  (success rate, avg cost/retries/duration, rejection rate — all simple
  aggregates), but the confidence-criterion design (what counts as "enough
  sample size") is real design work with direct governance consequences if
  gotten wrong (Phase 20 Risk #10).
- **Major risks:** Phase 20 Risk #10 verbatim: "acting on Phase 9.4's
  `CONDITIONAL` logic or Phase 10.5's tier-preference adaptation before
  there's enough data is worse than not having the data at all." The
  mitigation (the minimum-sample-size/confidence criterion) must ship
  *with* this projection, not as a follow-up.
- **What must be built first:** The shared async-projector infrastructure
  (can be built once for both §3 and §9 together, since both are Phase 8.3
  "asynchronous... kept async so the hot execution path never blocks on
  rollups" projections reading the same Event stream).
- **What must NOT be built yet:** Any consumption of `agent_performance` by
  Policy (§13) or the Model Router (§12) — those integrations wait until V4,
  per Phase 19, even though the projection itself lands at V2. Displaying it
  in a UI (§4, §7) is fine before then; *acting* on it is not.

### 10. Advanced Workflow Branching/Loops

- **Purpose:** Give the Workflow Interpreter real conditional branching and
  looping, beyond V1's `LinearGraphDefinition`.
- **Dependencies:** A real, concrete workflow whose logic actually needs
  branching/looping — not a hypothetical one.
- **Architectural components affected:** `src/workflow/graphTypes.ts` (new
  graph-definition shape beyond `LinearGraphDefinition`),
  `src/workflow/interpreter.ts` (the interpreter itself), §5's visualization
  (must already be built generically, per that section's stated risk).
- **Frozen-spec status:** Specified at the principle level (Phase 11: "the
  Interpreter decides what runs next" for Structured Workflows; "an LLM
  Invocation's output can determine the next Invocation... but only within
  the Run's fixed Task/budget/Agent scope — never spawning new Task Instances
  or altering Workflow topology" for the Agentic-loop pattern), but the
  *specific* branching/looping graph-definition schema is explicitly left
  undesigned until needed: "Workflow Interpreter gains branching/looping only
  once a real workflow's logic actually requires it" (Phase 19, V3).
- **Roadmap stage:** V3, explicitly.
- **Complexity:** Large. This touches the Workflow Interpreter, a
  governance-critical-adjacent module (Unit 7 was standard-tier reviewed in
  V1, but a topology change of this magnitude likely warrants Opus-tier
  review given how much downstream logic — §5's visualization, event
  correlation, budget scoping — assumes the current linear shape).
- **Major risks:** (a) Designing a generic branching/looping schema
  speculatively, ahead of the real workflow that needs it, is exactly the
  anti-pattern Phase 19/20 Risk #1 warns against — the schema should be
  derived from the actual second-or-third real workflow's actual needs, not
  designed abstractly first. (b) The Agentic-loop boundary ("never spawning
  new Task Instances or altering Workflow topology") must survive whatever
  new interpreter logic gets added — a loop-capable interpreter could
  accidentally blur this line if not carefully scoped.
- **What must be built first:** A concrete new Workflow Definition (via §15's
  Phase 14 rubric) whose real, demonstrated logic cannot be expressed as a
  linear chain — this is the "concrete need" Phase 19 requires before this
  work starts.
- **What must NOT be built yet:** Any branching/looping graph schema at all,
  until that concrete workflow exists. This is the most explicitly
  "don't build ahead of evidence" item in the entire roadmap.

### 11. Memory Implementation (when justified)

- **Purpose:** The four durable memory scopes (Task/Agent/Project/
  Organizational) from Phase 7 — curated, deliberately-written facts/lessons,
  distinct from raw Event history and from Artifacts.
- **Dependencies:** "A concrete gap that appears in practice" (Phase 19, V3)
  — i.e., a real, observed case where an Agent repeatedly needs a fact that
  Task History (Events) or Artifacts don't cleanly provide.
- **Architectural components affected:** New `memory_items` table (Phase 12
  schema, not yet built), new Capability-Grant-gated write paths (Phase 7:
  "Writing to Task/Agent/Project memory requires a Capability Grant + Policy
  check like any other action"), Context Compiler changes (Phase 5.6 "Memory
  selection" — the compiler needs to actually pull from memory once it
  exists), §8's Memory browser UI.
- **Frozen-spec status:** Fully specified, Phase 7 entire. Every mechanic is
  already designed: authority/confidence/provenance/supersession fields,
  conflict resolution order (authority first, confidence second, recency only
  as final tiebreaker), Organizational writes defaulting to
  `REQUIRE_APPROVAL`, and explicit non-membership rules (raw Events aren't
  memory; Artifacts aren't memory; general long-term knowledge is explicitly
  out of scope "until a concrete gap appears").
- **Roadmap stage:** V3, explicitly.
- **Complexity:** Large. Four scopes, a governed write path per scope, a
  conflict-resolution algorithm, and Context Compiler integration are all
  real, non-trivial work — nothing here is a stub.
- **Major risks:** (a) Building this speculatively before a real gap
  motivates it — Phase 7 and Phase 19 both explicitly gate this on "concrete
  gap," not on the feature being obviously eventually useful. (b) Conflating
  Memory with either Task History (Events) or Artifacts, which Phase 7
  explicitly and repeatedly distinguishes. (c) A vector store for memory
  recall — Phase 7's "Why no vector store for memory" section is explicit
  that "embedding-based recall is deferred until structural+lexical filtering
  demonstrably fails," which won't have been tested until this scope exists
  at all.
- **What must be built first:** The concrete gap itself must be observed
  first — this is evidence-gathering, not engineering, and happens
  automatically as real V1/V1.1/V2 usage accumulates.
- **What must NOT be built yet:** Any memory scope before its own concrete
  gap appears — this includes not building "just Task memory" speculatively
  because it seems like the easiest scope to start with. Also explicitly not
  yet: pgvector-backed memory recall (see Phase 19 V4: "pgvector... [is]
  reconsidered only if a concrete gap in structural retrieval... demonstrably
  appears").

### 12. Model Routing / Escalation Improvements

- **Purpose:** Phase 10.4's confidence-based escalation loop: attempt at a
  selected tier, validate the output deterministically, escalate one tier on
  insufficient output (bounded retry count), surface as failure/
  `REQUIRE_APPROVAL` if exhausted at `STRONG` — never silent infinite
  escalation. Plus Phase 10.5's tier-*preference* auto-tuning (adapting which
  tier is tried first, based on real cost-vs-success data — an efficiency
  choice, not an authorization change).
- **Dependencies:** `agent_performance` (§9) for the tier-preference
  adaptation half; a deterministic output-validator mechanism (per-Task-Definition
  "expected shape/success criteria") for the escalation half — not yet built
  in V1 (V1's `modelRouter.ts` selects a tier once per invocation and does
  not currently escalate).
- **Architectural components affected:** `src/router/modelRouter.ts`
  (escalation loop logic), `src/router/tierConfig.ts` (unaffected — tier
  definitions stay a config table), the Executor (needs to allow a
  multi-attempt Invocation sequence for one logical task step — "each
  escalation step is its own LLM Invocation with a fresh Context
  Compilation," per Phase 10.4).
- **Frozen-spec status:** Fully specified, Phase 10.4 + 10.5.
- **Roadmap stage:** V4, explicitly ("Model Router's confidence-based
  escalation loop (Phase 10.4) activates").
- **Complexity:** Large. Real new control flow in a governance-adjacent
  module (every escalation step re-enters the full Grant→Policy→Budget→
  Approval chain per Unit 6's existing design — an escalation loop must not
  create a shortcut around any of those checks on its second/third attempt).
- **Major risks:** (a) An escalation loop that silently retries past a
  budget ceiling — each escalation attempt is a new Invocation and must go
  through Unit 2's budget reservation again, not reuse the first attempt's
  reservation. (b) Model self-reported confidence being treated as
  authoritative instead of "ADVISORY ONLY — never bypasses a deterministic
  validator or a required Approval" (Phase 10.4's own explicit warning).
- **What must be built first:** A real deterministic output-validator
  mechanism per Task Definition (this doesn't exist in V1 at all — V1's
  `executeRun` treats an LLM invocation's completion as terminal, with no
  validate-then-maybe-escalate step). `agent_performance` (§9) for the
  tier-preference half specifically.
- **What must NOT be built yet:** Tier-preference auto-tuning acting on
  `agent_performance` data before that projection clears its own minimum-
  sample-size/confidence criterion (same criterion as §13, defined at V2 per
  §9's own entry above).

### 13. Progressive Autonomy

- **Purpose:** `CONDITIONAL` autonomy state actually consulting
  `agent_performance` to auto-`ALLOW` below-threshold instances (still
  escalating anything above threshold); eventually, human-elected graduation
  `ALWAYS_APPROVE → CONDITIONAL → AUTONOMOUS`.
- **Dependencies:** `agent_performance` (§9) with its minimum-sample-size/
  confidence criterion actually defined and enforced.
- **Architectural components affected:** `src/governance/policy.ts`'s
  `evaluatePolicy` (currently, per Unit 3's V1 implementation, `CONDITIONAL`
  is a stored `autonomy_state` value but nothing in the current codebase
  actually branches on it differently from `ALWAYS_APPROVE` — confirming this
  precisely is worth a quick check at V4 planning time, not asserted here),
  §6's Registry (the UI surface where a human performs the graduation act).
- **Frozen-spec status:** Fully specified, Phase 9.4 + restated in Phase 19's
  V4/V5 entries. The ceiling rule is load-bearing and must never regress:
  "SPEND/TRADE/PUBLISH/DELETE default to a policy-enforced ceiling of
  `CONDITIONAL` at most; reaching `AUTONOMOUS` for these always requires an
  explicit human policy change, never earned automatically" — this is Unit
  3's `validateCapabilityGrant` structural ceiling (already built and Opus-
  reviewed in V1, even though nothing yet exercises `CONDITIONAL`'s
  performance-consulting behavior).
- **Roadmap stage:** `CONDITIONAL` activation at V4; `AUTONOMOUS` graduation
  (always human-elected) at V5.
- **Complexity:** Medium for `CONDITIONAL`'s policy-engine logic itself (a
  threshold check against `agent_performance`); the graduation-to-`AUTONOMOUS`
  mechanism is mostly already built (it's a Registry write, §6) — the
  remaining work is making sure that write path is exercised and reviewed
  once §6 exists.
- **Major risks:** Phase 20 Risk #3, named explicitly and not treated as
  solvable by architecture: "a human eager to reduce approval friction can
  still make that act carelessly (promoting SPEND/TRADE without real track
  record). No architecture prevents a human from overriding their own
  governance design; this is a discipline risk on you, not a gap in the
  system." Worth restating in any V5 implementation plan's own risk section,
  not just here.
- **What must be built first:** §9's `agent_performance` and its
  confidence criterion (V2); the Registry (§6, V1.1) as the write surface.
- **What must NOT be built yet:** Any UI/API shortcut that treats
  `agent_xp_projection` (§3) as an input to this decision — Phase 16.2's
  explicit boundary ("only `agent_performance` ever feeds a Policy or Model
  Router decision") is exactly the kind of thing worth a dedicated review
  checklist item once this work starts.

### 14. Evaluation / Quality Measurement

- **Purpose:** An evaluation run comparing an outcome against a success
  criterion, writing `evaluation_completed` — extends the same event model,
  not a parallel system. Feeds the fourth, highest-value XP rule (§3) and
  gives Phase 10.4's escalation validator a richer signal than pure
  deterministic shape-checking.
- **Dependencies:** A concrete gap in grading/quality-measurement that
  deterministic validation and human approval don't already cover.
- **Architectural components affected:** New `evaluation_completed` event
  type (Phase 8.2's taxonomy gains one entry), whatever produces that event
  (could be deterministic, could be a dedicated LLM-graded evaluation
  Invocation — undesigned on purpose).
- **Frozen-spec status:** Deliberately deferred, not designed in detail —
  Phase 8.9: "Same pattern deferred: an evaluation run compares an outcome
  against a success criterion and writes `evaluation_completed`... not a
  parallel system." This is intentionally underspecified; designing it in
  full now would itself be building ahead of evidence.
- **Roadmap stage:** V4 ("reconsidered only if a concrete gap in... grading
  demonstrably appears").
- **Complexity:** Unknown/TBD by design — genuinely depends on what gap
  motivates it. Do not estimate further than this without a real gap in hand.
- **Major risks:** Building a generic "evaluation system" speculatively
  (exactly Phase 20 Risk #1's pattern) before a concrete grading gap exists.
- **What must be built first:** The gap itself, observed in practice.
- **What must NOT be built yet:** Anything. This entire item is explicitly
  "not built now" per its own Phase 8.9 heading, and stays that way until V4
  evidence appears.

### 15. Future Integrations/Capabilities

- **Purpose:** New Capabilities (research, productivity, commerce, finance,
  development, creative, execution categories) added as real Goals demand
  them.
- **Dependencies:** An existing, approved, near-term Task Definition/
  Capability that genuinely needs the integration — never a speculative one.
- **Architectural components affected:** New `capabilities`/`tool_bindings`
  rows (Phase 12), a new Tool Adapter module per Phase 6's decision framework
  (internal/direct API/MCP/browser/scheduled/webhook), Phase 9's Grant/Policy
  wiring for the new Capability.
- **Frozen-spec status:** Fully specified, Phase 14 entire (the rubric and
  decision rule) + Phase 6 (implementation-kind decision framework). Phase
  14.5's category checklist is explicitly "a useful lens, not a build list."
- **Roadmap stage:** V3, explicitly ("New Capabilities added strictly per the
  Phase 14 rubric as real Goals demand them... never speculative").
- **Complexity:** Varies per capability — this is the one item in this
  document whose complexity is intentionally unbounded/case-by-case, by
  design (Phase 14.2's rubric exists precisely because each candidate is
  evaluated on its own merits).
- **Major risks:** Phase 20 Risk #1, restated for the third time in this
  document because it is the single risk every one of these deferred-work
  items shares: adding an integration "because it's convenient," not because
  a Task Definition genuinely needs it, with Phase 14.3's decision rule as
  the concrete test ("an existing, approved, and near-term Task Definition
  needs it" AND "it clears a minimum bar on usefulness + reliability +
  trust").
- **What must be built first:** A real Task Definition that needs the
  capability — worked example already in the spec (Phase 14.4: Shopify's
  direct API for a real e-commerce need beats generic browser automation for
  the same need, on trust/reliability/latency grounds).
- **What must NOT be built yet:** Anything from the Phase 14.5 category
  checklist speculatively. Also: V6+'s multi-user generalization (Phase
  9.8) or any move off single-machine infrastructure (object storage, managed
  Postgres) — Phase 19 gates this on the platform "genuinely outgrow[ing]
  local/solo use," which is not close to true today and isn't part of this
  planning pass's near-term scope at all.

---

## Appendix A: Architectural questions discovered during this planning pass

None of the following are contradictions requiring a stop — the frozen
architecture is internally consistent — but each is a real open question
worth resolving explicitly before the relevant work item's implementation
plan is written, rather than leaving it implicit:

1. **No `policies` table exists in V1's schema**, even though Phase 12
   specifies one (`policies(id, scope, rule_definition, version)`) and Phase
   15.1's Registry screen (§6) explicitly names "Policies" as one of its
   three read/edit surfaces. V1's `src/governance/policy.ts` implements
   policy evaluation as in-code logic — a reasonable, already-reviewed V1
   choice, but V1.1's Registry work needs an explicit decision: introduce a
   real `policies` table now (real schema/migration work, needs its own
   review), or scope V1.1's Registry down to Agent Definitions + Capability
   Grants only and defer a Policies editor until a table is justified.

2. > **RESOLVED (Phase 8, `ce7155c`).** The emergency stop exists: the
   > `execution_stops` table, checked by the Executor before every Invocation,
   > with scopes global / agent_definition / capability_grant / goal /
   > workflow_run / run, and the `/execution-stops` routes. See
   > `src/governance/executionStop.ts` and spec §9.7's implementation note.
   > The original question follows.

   **Confirmed by direct code inspection:** the only pause/revocation-related
   field anywhere in V1's schema is `capability_grants.revoked_at`
   (`src/db/schema.ts:127`), added in Unit 3 for material-change invalidation
   — a Grant-scoped concern, not Phase 9.7's emergency-pause mechanism. Phase
   9.7 describes pause/revocation as "an immediate, synchronous state flip (a
   Postgres row update, not a queued event)" with scopes global /
   per-Agent-Definition / per-Capability-Grant / per-Goal-Workflow-Run — none
   of that broader mechanism exists in V1's schema or API surface yet. This
   needs to be designed and built (new columns/flags at the appropriate
   scopes, checked by the Executor "before *every* Invocation, including
   free/deterministic ones," per 9.7) before §4's Agent Detail pause/resume/
   stop controls can be wired to something real, rather than assumed to
   already exist.

3. **Confirmed by direct code inspection:** `src/governance/policy.ts:139`'s
   own comment states the current rule precisely: `"ALWAYS_APPROVE ->
   REQUIRE_APPROVAL; CONDITIONAL -> REQUIRE_APPROVAL for V1"`, and line 178's
   decision expression only ever returns `ALLOW` for `autonomyState ===
   "AUTONOMOUS"` — `CONDITIONAL` is stored but behaviorally identical to
   `ALWAYS_APPROVE` today. This is a disclosed, deliberate V1 simplification
   (the code comment names it as such), correct for V1 since `CONDITIONAL`'s
   real behavior depends on `agent_performance`, which doesn't exist until
   V2. Flagged here so §13's V4 implementation plan starts from this exact,
   verified baseline rather than assuming more of today's code is already
   wired up than actually is.

4. > **RESOLVED (2026-09-14, after Phase 9).** `invocations.tool_binding_id` is
   > persisted at propose time (migration 0010). On resume, a different
   > `toolBindingId` fails as `resume_spec_mismatch`; a stored null fails closed
   > the same way. After `reauthorize`, Policy is re-evaluated against the
   > persisted binding's current trust and the current Grant, and a DENY fails the
   > invocation as `reauthorization_policy_denied` before any side effect runs.
   > The original analysis is kept below for the record.

   **KNOWN LIMITATION, NOT SOLVED — `reauthorize` cannot independently
   re-check Tool Binding trust level at resume time.** `invocations`
   currently does not persist a `tool_binding_id` column (confirmed by
   direct schema inspection — `src/db/schema.ts` has no such column).
   `resumeToolSpec` (`src/execution/executor.ts`) validates
   `capabilityId`/`permission`/`costClass`/`proposedActionSnapshot` against
   the stored invocation before resuming, and `reauthorize`
   (`src/governance/approvals.ts`) re-checks Grant existence, revocation,
   TTL, and snapshot equality — but neither re-evaluates
   `evaluatePolicy`'s trust-bar/unverified-binding rules (added to
   `src/governance/policy.ts` in the fix-round-2 commit). A caller-supplied
   `toolBindingId` on resume is not validated against anything persisted,
   so re-resolving trust from it would be *weaker* than not checking at
   all — there is currently no sound way to close this without schema
   work.
   **Why this is safe in the current V1 configuration, and only there:**
   each seeded capability (`research.retrieve`, `publish.report`) has
   exactly one static `tool_bindings` row, `trust_level` is config no
   runtime code writes, and both seeded bindings already clear their
   Grant's `max_trust_level_required` bar. Nothing in V1 can cause a
   Grant's binding to change out from under an in-flight Approval.
   **Why this becomes a real gap, and when:** the moment a Capability gets
   a *second*, swappable, or lower-trust Tool Binding (§15 of this plan —
   new capabilities, added per the Phase 14 rubric), or the moment a human
   downgrades a binding's `trust_level`/raises a Grant's
   `max_trust_level_required` while an Approval is genuinely pending
   (Phase 20 risk #7, "trust-level drift"), an Approval created against
   one trust state could execute against a different one with no
   re-check. This is a **hard prerequisite**, not a nice-to-have, before
   either of those two things happens.
   **The fix, when it's time:** persist `tool_binding_id` on `invocations`
   at propose time (schema + migration), then have `resumeToolSpec` and/or
   `reauthorize` validate it against the resuming spec and re-run (or
   re-derive) the trust check from the persisted binding — mirroring how
   `capabilityId`/`permission`/`costClass` are already validated on
   resume. Scope this as its own reviewed unit when §15 first adds a
   capability with more than one binding, or sooner if trust-level drift
   is observed in practice.

## Appendix B: Cross-cutting non-goals (collected)

Repeated across multiple sections above; collected here as a single
checklist for whoever plans the next implementation phase, so none of these
get built "for free" as a side effect of an adjacent item:

- No vector database/pgvector usage anywhere (memory, context, or otherwise)
  until a concrete structural/lexical-retrieval failure is demonstrated
  (Phase 19 V4, Phase 7, Phase 4).
- No Langfuse or other tracing infrastructure — Events + projections already
  provide trace/cost data (Phase 4 infra-justification ledger).
- No evaluation system (§14) until a concrete grading gap appears.
- No memory scope (§11) until a concrete gap appears, and never all four
  scopes at once "for completeness."
- No workflow branching/looping (§10) designed ahead of a real workflow that
  needs it.
- No `agent_performance` consumption by Policy or the Model Router before its
  V2-defined minimum-sample-size/confidence criterion is met (§9, §12, §13).
- No `AUTONOMOUS` autonomy state for SPEND/TRADE/PUBLISH/DELETE, ever,
  regardless of stage (Phase 9.4, permanent ceiling — not merely a V1
  limitation).
- No copying the Tile Pack's full 338-file directory into `web/`; no shipping
  any `.aseprite` source file to the frontend (§2).
- No multi-user/auth generalization or move off single-machine Postgres
  until the platform genuinely outgrows solo use (Phase 19 V6+).

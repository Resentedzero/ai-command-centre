# Runtime truth: what the UI can actually show

The runtime decides what exists. This file is the map from real data to what a screen may render. If it is not here, or in `web/lib/api.ts`, it does not exist yet.

Authority, highest first: spec (`docs/superpowers/specs/2026-09-12-ai-command-centre-design.md`, Phase 15) → `src/api/routes/*` → `web/lib/api.ts` → this file → Figma → reference images.

## The contract for every rendered value

Every value, count, gauge, badge and animation state on a screen names its source: an `api.ts` type and field, or client-only state (clock, connection status, UI selection).

- A value with no source is not rendered. It becomes a proposed API route, recorded in the screen's design notes, not a client-side computation.
- `web/` reaches data only through `web/lib/api.ts`. It never imports `src/`.
- The UI never computes cost, XP, policy, health or workflow state. It renders what the API returns (spec §15, §15.4).
- Counting rows the API returned is allowed, but lists are capped (`GET /workflow-runs` 100, `GET /goals` 500). A count from a capped list shows as `100+`, never as a total.

## Data available today

| Read model (`api.ts`) | Route | Fields worth visualising |
|---|---|---|
| `AgentCardData[]` | `GET /agents/active` | agent name, `taskStatus`, `latestActivitySummary`, `runId` |
| `AgentDetail` | `GET /agents/:id` | role, objective, `activeStop`, grants (capability, permissions, `autonomyState`, trust, revoked), runs with goal lineage and latest invocation `kind`/`status`, `budgetTotals` per unit, `recentEvents`, `outputs`, `contextLineage` (tiers, exclusions, token estimate vs max). `performance` is always `null`. |
| `WorkflowRunSummary[]` | `GET /workflow-runs` | status, goal title, definition name/version, timestamps |
| `WorkflowRunDetail` | `GET /workflow-runs/:id` | ordered `steps` (task definition, task instance status, run, invocations with failure reason, budget per unit), `stepsUnavailableReason` |
| `ProjectGoals[]` | `GET /goals` | projects → goals → workflow runs with status |
| `ApprovalData[]` | `GET /approvals` | risk tier, status, TTL, snapshot, `context` (capability, permission, agent, goal, artifact preview, `hashMatchesSnapshot`) |
| `EventDisplayItem` stream | `GET /events/stream` (SSE) | `eventType`, `occurredAt`, `eventCursor`, summary |
| Artifact detail (route exists; **no client function in `web/lib/api.ts` yet**) | `GET /artifacts/:id` | `artifact` (type, version, size, hash, summary, createdAt, storedInline, `preview` shown as text, truncated, `contentHashMatches`); `producedBy` (invocation kind/seqNo → runId → agent name/version → taskDefinition → workflowRunId → goal title); `referencedBy[]` (compiled contexts: occurredAt, kind, tier, version, hash) plus `referencedByTruncated`. There is **no artifact list route**: browsing is per agent via `AgentDetail.outputs`. |

Commands (§15.2): `createGoal`, `approveApproval`, `rejectApproval`, `engageAgentStop`, `liftAgentStop`. Nothing else is controllable from the UI. No per-agent pause exists. Workflow pause/resume exists in the runtime but has no UI route yet.

Seeded reality: 2 agents (Researcher, Publisher), 2 capabilities (`research.retrieve`, `publish.report`), linear 1–2 step workflows. Design for N agents, but never draw placeholder agents that don't exist.

## State vocabularies

| Entity | States |
|---|---|
| Workflow Run | `in_progress`, `paused`, `completed`, `failed` |
| Task Instance | `pending`, `active`, `awaiting_approval`, `completed`, `failed` |
| Invocation | `proposed`, `awaiting_approval`, `executing`, `completed`, `failed` |
| Invocation kind | `llm`, `tool`, `retrieval`, `deterministic` (`browser` in the spec; not built) |
| Approval | `pending`, `approved`, `rejected`, `expired` |
| Execution stop scope | `global`, `agent_definition`, `capability_grant`, `goal`, `workflow_run`, `run` |
| Autonomy | `ALWAYS_APPROVE`, `CONDITIONAL` (behaves as approve today), `AUTONOMOUS` |
| Resource unit | `usd`, `subscription_tokens`, `local_tokens`: separate counters, never summed or converted |

`blocked` and `skipped` exist in the spec (§3d) but the runtime never produces them. Keep a visual token reserved; do not render them.

Events emitted today: spec §8.2 implementation note. `run_halted`, `approval_*`, `execution_stop_engaged/lifted`, `budget_consumed`, `artifact_created` and the lifecycle events are the ones worth distinct feed treatments.

## When a reference shows something the runtime doesn't have

1. Keep the visual idea if it can carry real data.
2. Map it to the closest real concept.
3. No real concept: use a treatment that doesn't imply the feature, or leave it out.
4. Genuinely valuable? Record it as a proposal in `design-decisions.md`. Never build backend support to match a picture.

| In a reference | Real mapping |
|---|---|
| "Agents 12/16" | Count of `GET /agents/active` rows. No "total agents" read model exists, so there is no denominator. |
| "Tokens 42.3K" plus "USD $12.47" as one chip | One gauge per `resourceUnit`, each with its own unit label. Never combined. Only shown where a read model returns it (run or agent scope; there is no global or day read model yet). |
| "System Healthy" | No health read model. Show the real SSE connection state (live / reconnecting / offline) from `subscribeToActivity`. |
| XP, level, "Level 2" floor selector | `agent_xp_projection` doesn't exist (V2). A floor or level can be a world-navigation device (e.g. one floor per project), never a progression score. |
| Minimap | Real if it navigates rooms that exist. |
| Branching workflow graph | Workflows are linear. Draw a corridor of rooms in step order; branching waits for the interpreter (roadmap §10). |
| Agent roles (Architect, Coder, Tester…) | Only the Agent Definitions the API returns, with their real `role`. |
| Capabilities chips (`read_files`, `git`…) | `AgentDetail.grants[].capabilityName` with `permissions` and `autonomyState`. |
| "Model: claude-3.5-sonnet", tokens in/out | Not in any read model today. Propose an API field; don't hard-code. |
| Sub-goals with checkmarks | Goals have no sub-goals. The real hierarchy is goal → workflow run → steps. |
| "Editing: src/…/analytics.tsx", "Ran tests (12 passed)" | No such capabilities exist. Recent activity comes from `recentEvents` / the SSE feed. |
| Artifact code viewer, "View History", "Download", tags | Artifacts have type, size, hash and a text preview in approvals. No artifact browser API yet (screen 8 not built); no versions or tags. |
| Revenue or outcome stats | Omitted unless a real projection exists (spec §15.1). |

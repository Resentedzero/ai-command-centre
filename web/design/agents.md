# Agents (screen 2) and Registry (screen 6) — implementation note

1. **Questions:** Agents — what is this agent doing, why, and can I stop it? Registry — what are agents allowed to do?
2. **Tiers:** act now = Stop under the name (asks once; Lift is neutral); working = workshop light, lineage rows; detail = keys, usage per unit, context lineage, outputs, recent actions, performance.
3. **World:** the agent's 4x workshop (centred crop), preferred slot from the id hash (same room as Overview when free). Cyan light only while a Run is `active`; dark and empty while `awaiting_approval` (the agent is at the council seal); barrier and frozen sprite when stopped. One key per grant, numbered like its card; revoked keys dimmed.
4. **Values:** roster `GET /registry` agentDefinitions + `GET /agents/active` + `GET /execution-stops`; board `GET /agents/:id` (`AgentDetail`, including typed `performance` rows); performance task names from `GET /registry` taskDefinitions. Registry board: `GET /registry` grants, capabilities with bindings, task and workflow definitions.
5. **States:** roster loading/failed/empty; agent loading, not found (404), load failed, refresh failed (last read kept); no runs, no grants, no consumption, no model calls, no outputs, no performance rows.

**Registry is read-only** (Figma frame is "gated: read-only"). The create and revoke routes exist (ROADMAP §7) but have no design frame and change safety-critical authority (spec 9.4), so no controls are built.
**Performance** shows every row as a measurement. Whether a row meets the minimum sample criterion is not in any read model, so it is not shown (see the report's API gaps).

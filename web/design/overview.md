# Overview (screen 1) — implementation note

1. **Question:** is the system working, and where must I act?
2. **Tiers:** act now = Stop under the selected agent's name, pending approvals (council hall), stopped agents; working = lit workshops, in-progress workflows, live feed; detail = board runs, recent events.
3. **World:** `keep-v4-2x.png` in a panning viewport. System rooms (Approvals, Goals, Workflows, Events, Artifacts) are links with real values; two anonymous workshops hold active Agent Definitions in stable id order; the runtime core glows only while the feed is live; the entrance is scenery.
4. **Values:** agents and missions `GET /agents/active` (`AgentCardData`, grouped by `agentDefinitionId`); stops `GET /execution-stops`; pending `GET /approvals` rows; goals `GET /goals` rows (500+); in progress `GET /workflow-runs` status (100+ when capped); feed status and events are client state from `subscribeToActivity`.
5. **States:** loading (dots), empty ("Nothing is running…" + Start a goal), load failed (Retry), refresh failed (last read kept, alert), feed reconnecting/offline (lights 45%, notice strip Reconnect), stopped (barrier, frozen sprite, Lift stop), awaiting approval (agent on the seal, workshop dark).

**Not drawn, and why:** the event-arrival room flash needs an agent id on events (not in `EventDisplayItem`); a third active agent has no workshop (listed on the board); the 4x portrait is omitted (the room shows the sprite).

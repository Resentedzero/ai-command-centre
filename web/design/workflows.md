# Workflows (screen 3) and Cost (screen 7) — implementation note

1. **Questions:** Workflows — where is this run in its sequence, and what failed? Cost — what is being consumed, by unit?
2. **Tiers:** act now = the step needing attention (failed, then awaiting approval, then active), centred in the corridor and selected; working = lit step rooms, run status; detail = attempts, invocation timeline, per-unit budget, run trace on demand. Cost: totals per (scope, unit), counters, cost and success.
3. **World:** a corridor of engine-room crops, one per step in graph order, joined by the keep's own hall art. Cyan light only on an `active` step; a step with no Task Instance is dimmed and says "not started". No agent sprite: the run's agent carries no id to key identity on. Cost has a small engine-room frame that states no value.
4. **Values:** runs `GET /workflow-runs` (100+ when capped); run `GET /workflow-runs/:id` (steps, `attempts`, invocations, `artifactIds`, budget counters); trace `GET /runs/:id/trace`. Cost `GET /costs?scope=`: counters (gauge only for run counters, whose limit is enforced), API totals per (scope, unit), `costVsSuccess`.
5. **States:** runs loading/empty (Start a goal)/failed/refresh failed; run loading/not found/failed/refresh failed; steps unavailable (API reason); no run for a step; no invocations; no counters; trace loading/empty/failed. Cost loading/failed/empty per scope, truncated counters, no performance rows.

Not built: workflow pause/resume/advance controls (routes exist, but no design frame or §15.2 command covers them).

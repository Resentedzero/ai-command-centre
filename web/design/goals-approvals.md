# Goals (screen 5) and Approvals (screen 4) — implementation note

1. **Questions:** Goals — what missions exist, and how are they going? Approvals — what exactly am I being asked to allow?
2. **Tiers:** Goals: act now = Start goal (with its cost warning and non-idempotency hint); working = in-progress runs; detail = projects, goals, run corridors. Approvals: act now = Approve / Reject pinned in the action bar, and the hash check; working = the queue; detail = request, preview, snapshot.
3. **World:** Goals frames the list with a war-room vignette (no values on it). Approvals shows the council hall at 2x, lit amber with a pulsing seal only while a request is selected from the pending queue; dimmed while the feed or a refresh is down. No agent sprite on the seal: `ApprovalContext.agent` carries no id to key identity on.
4. **Values:** Goals `GET /goals` (projects → goals → workflow runs; run counts by status are counts of returned rows, 500+ when capped) and `createGoal`. Approvals `GET /approvals` (`ApprovalData` with `context`), `approveApproval`, `rejectApproval`; full content through `/artifacts/:id?full=1` (ROADMAP §7).
5. **States:** Goals loading/failed/empty/refresh failed; starting; start failed (red message, route detail, "refresh before retrying", Refresh goals); started (link). Approvals loading/failed/nothing pending/refresh failed; hash matches (green), mismatch (red marker, preview untrusted), no hash pinned (neutral); no inline content; decision refused (alert); decision recorded but not advanced (notice).

Goal status words are shown with a neutral marker: goal statuses are not in the runtime state vocabulary, and cyan would claim work. No resolved-approvals group: `GET /approvals` returns pending requests only.

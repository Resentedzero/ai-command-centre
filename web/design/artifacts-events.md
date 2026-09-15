# Artifacts (screen 8) and Events — implementation note

1. **Questions:** Artifacts — what did the agents produce, and where did it come from? Events — what happened, and in what order?
2. **Tiers:** Artifacts: act now = the content hash check (a mismatch marks the content untrusted); working = the vault of outputs; detail = provenance, preview or full content, references. Events: act now = the feed state (Reconnect); working = the newest rows; detail = filter by type, summaries.
3. **World:** Artifacts: the vault at 2x with one chest per output the API returned (the open one selected with a cream bracket; none drawn while loading). Events: a thin library strip only; the log is the screen. The base art has three chests painted on the floor; clean floor rows from the same image cover them until a chestless vault base exists (asset gap).
4. **Values:** roster `GET /registry` (+ active, stops); outputs `GET /agents/:id` `outputs` (recent only; no artifact list route); artifact `GET /artifacts/:id` (and `?full=1` for the whole inline content); events from `subscribeToActivity` (client state: received this session, replayed from cursor 0, latest 1,000 kept), filter chips from received types.
5. **States:** Artifacts: no agent / roster failed; outputs loading, failed, empty ("…'s vault is empty."); no artifact chosen; loading; not found (404) with Retry; load failed; hash matches / mismatch / no inline content; no producing invocation; nothing inline; full content failed; no references; references truncated. Events: connecting; no events yet; reconnecting / offline with Reconnect (strip dimmed); filtered.

Type markers on the log are presentation only: fail for failed, halted, denied, rejected, expired, revoked and stop engaged; wait for approval required; done for completed and approved; active for started; the rest neutral.

## V1.1: Document, Evidence, Raw (D21)

- **Document** (default for `deliverable`, `report`, `keeper_answer`): the whole inline content is read (`GET /artifacts/:id?full=1`) and parsed by `web/lib/deliverable.ts`. Title, completion word and reason, the evidence basis line (recorded by the runtime, never the model's claim; "No external research was performed." when none was), executive summary, body (GFM), findings, recommendations, sources. Content that isn't a document says so and offers Raw. A hash mismatch keeps the red untrusted note and edge.
- **Evidence:** integrity (id, version, sha256, storage, created, **Verify integrity** re-reads the artifact so the API recomputes the hash, with the time checked), produced by (goal, task, agent, invocation, run), sources with each capability's evidence class and call count, referenced by.
- **Raw:** the stored bytes as before (indented JSON as text).

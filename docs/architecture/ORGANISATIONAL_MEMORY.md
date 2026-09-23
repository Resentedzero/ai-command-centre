# Organisational memory and operational notices

What the Keep remembers about its own work, and how it tells anyone. **Both are read models over Events.
Neither is a store, neither is a runtime, and neither adds a table.**

## Memory is not raw history

`src/api/organisationHistory.ts` composes what already happened into answers. There is no memory table, no
embedding, no retrieval and no summarisation pass — the questions organisations actually ask ("what did we
do last week", "what is still outstanding", "what has this agent worked on") are relational, and Postgres
answers them.

- **Bounded by construction.** `WINDOW = { defaultHours: 168, maxHours: 720, defaultLimit: 20, maxLimit: 50 }`,
  clamped on the way in. There is no unbounded history read.
- **Every fact carries its basis.** `Basis` is `"recorded"` (an Event said so) or `"calculated"` (derived
  from records at read time, e.g. a count or an elapsed time). A fact that is neither is not returned —
  there is no third category that quietly means "we think so".
- **Provenance-linked.** Every entry names the Goal, Run, meeting or artifact it came from, so the UI can
  link to the thing itself rather than paraphrasing it.
- `drizzle/0029_events_goal_index.sql` gives `(goal_id, global_seq)` the partial index the per-goal
  question deserves. An index is additive and derived: dropping it only makes reads slower.

### The Manager may read it; it is still data

`MANAGER_INSPECT_HISTORY_CAPABILITY` (READ) lets the Manager's plan step see the last `HISTORY_DAYS = 7`,
at most `HISTORY_LIMIT = 8` entries, through `src/capabilities/organisationHistory/adapter.ts` — which
refuses any argument but `{ days: 7 }`. A Manager version without the Grant **skips the step**
(`skip("no_history_grant")`) rather than failing the mission.

The adapter lives outside `src/capabilities/manager/` because that directory may not import `src/api/`;
the structural invariant caught the first attempt and was not weakened to accommodate it.

Historical records reaching a prompt are **untrusted artifact data**, fenced like any other. Summaries and
decision texts inside them were written by models. See `TRUST_BOUNDARIES.md` §3.

## Notices are derived, never invented

`src/api/operationalNotices.ts` maps an Event type to zero or more notices. A notice is never a new fact:
each one is derived from a record the runtime already wrote, and carries that record's identity.

- **Idempotency key is `<kind>:<eventId>:<recipient>`** — the event's own identity plus who is told,
  because one failure legitimately tells both the operator and the Manager. The key is unique and writes
  conflict-do-nothing, so re-deriving is free.
- **No watermark.** Nothing is stored about where the sweep reached, so there is nothing to keep in step,
  rebuild or corrupt. One pass looks back `LOOKBACK_HOURS = 24`, at most `SCAN_LIMIT = 500` events. A Keep
  that was off for a week announces the last day; the rest is history, which is read rather than announced.
- **Two facts come from the clock, not an Event.** `goal_overdue` is derived from `goals.due_at` and
  written once per goal, only while the goal is still active — a goal that finished late is history, not an
  alert. The pending-approval notice is deliberately *not* here: `GET /workplace/notifications` derives it
  live from the approvals themselves, so it disappears when the approval resolves and can never go stale.
  Two sources for one fact would be worse than one.
- **A notice grants nothing.** Deriving them starts no work, changes no authority and awards no XP.

The sweep runs once a minute alongside the others in `src/api/start.ts`. It is not a queue and not a
service.

## Keeper

The Keeper explains what the records say, in a `READ ONLY` transaction, and can create nothing. Its
intents route a question to a deterministic answer where one exists; the model is asked only to phrase
what code already found. Numbers its answer adds that the records do not contain are flagged rather than
printed. See `KEEPER.md`.

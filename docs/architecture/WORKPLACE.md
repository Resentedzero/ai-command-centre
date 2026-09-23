# Workplace: calendar, meetings, rooms, internal notifications

The Command Keep's internal office. **Office records, not runtime work, and never authority.**

## Model

| Table (migration 0025) | What it holds |
|---|---|
| `workplace_settings` | One row: the Keep's IANA timezone, working hours and days, whether meetings may fall outside them, default meeting length, reminder and gather lead times, notification switches |
| `workplace_agent_settings` | An agent's own working hours (by persistent name); null falls back to the Keep's |
| `workplace_rooms` | Name, purpose, capacity, active, and `locationAreaName` — the world area it occupies, by name |
| `workplace_meetings` + `workplace_meeting_participants` | Title, agenda, organiser (actor), room, start, end, `cancelledAt`, notes/decisions/actions (each stamped with who recorded it), provenance (Goal, Run, Invocation), revision |
| `workplace_calendar_events` | Appointments, breaks, unavailable periods, scheduled work, deadlines (per agent or the whole Keep) |
| `workplace_notifications` | Internal records: invitation, reminder, changed, cancelled, work assigned, announcement, message. `channel` is `internal`; `deliverAt`; `withdrawnAt` for a reminder whose meeting moved or was cancelled |

All rules live in `src/workplace/workplace.ts`; zone arithmetic in `src/workplace/zonedTime.ts` (`Intl`, no dependency); availability and slot search are pure functions in `src/workplace/availability.ts`.

## Decisions

- **Status is derived, never ticked.** `cancelled` if cancelled, `completed` once `endsAt` passed, `in_progress` once `startsAt` passed, `starting` inside the gather window (`startsAt − gatherMinutes`), else `scheduled`. No scheduler exists. A meeting that has not begun (`scheduled` or `starting`) can still be moved or cancelled.
- **Code decides every time, room and conflict.** Half-open ranges; 15-minute slot grid; earliest start is now + gather time; smallest active room that seats everyone (a named room or purpose first). Conflicts: participant double-booking, room double-booking, unavailable/stopped participant, outside working hours (when forbidden), invalid duration or time, inactive room. Writes take advisory locks on the rooms and participants, re-check inside the lock, then write rows and one event.
- **Rooms link to world areas by name**, resolved in the browser. The workplace module never reads world tables (structural invariant); a room whose area is not in the current world is "not on the map" and draws nobody.
- **Events.** `meeting_scheduled`, `meeting_rescheduled` (key per revision, previous time in payload), `meeting_cancelled`, `meeting_outcome_recorded`, `meeting_action_started`, `workplace_calendar_entry_created/cancelled`, `workplace_room_created/changed`, `workplace_settings_changed`, `workplace_agent_hours_changed`, `workplace_message_sent`. Meetings a Manager scheduled carry the mission's Goal, Run and Invocation.
- **Presence is event-verified.** `GET /workplace/presence` counts a meeting only while its row matches the latest scheduled/rescheduled event for its revision and no cancellation event exists; one place per agent (the meeting it is in beats the next it would gather for). A row written or altered without its event puts nobody anywhere.

## Governance

- **Manager v2** (seed): `workplace.inspect_calendar` READ and `workplace.schedule_meeting` CREATE (schedule) + WRITE (move, cancel), both AUTONOMOUS: they change internal office records only. An operator who wants approval changes the Grant to ALWAYS_APPROVE; Policy holds the write for approval (tested). Revoked Grant → Policy DENY → nothing written (tested). DELETE is never used: a cancelled meeting is kept.
- **The Manager plan** (`manager_plan`): inspect workforce → inspect calendar (only for meeting objectives) → LLM plan (tasks **or** one meeting request) → code validation (participants, availability, room, duplicates, stale references) → `workplace.schedule_meeting` naming the code-written record → deterministic apply (every rule re-checked inside the write's locks; a stale plan fails with its real reason) → plan record. The model never does date arithmetic, conflict detection or room selection.
- **Operator routes** (`/workplace/*`) act as `human:operator`, like Goals and the world.
- **Structural invariants**: only `db/schema.ts` and `workplace/workplace.ts` touch the workplace tables; the workplace module imports no governance, Registry writer, router, provider, projection, world, API or capability code, and writes no runtime or authority table.

## Holding the meeting (R2 Stage 4)

A scheduled meeting is a diary row. A **held** meeting is a Workflow Run, and the runtime holds it through
the ordinary chain — there is no meeting engine.

- `sweepMeetingsToConvene` (one of the sweeps in `src/api/start.ts`, 60s) finds meetings whose start has
  passed and which have not been convened. `convene(db, meetingId)` (`src/api/routes/meetings.ts`) takes the
  advisory lock `meeting:convene:<goalId>` and builds a **Goal in the Meetings Project** with one strictly
  linear Workflow Run: one `meeting_contribution` Task Instance per participant, in turn, then one
  `meeting_outcome` step the Manager runs.
- **Attendance is decided by code, before any model call.** A participant who is stopped, unavailable or
  already elsewhere cannot attend; if that leaves the room unusable the meeting is recorded through
  `markMeetingNotConvened` with the real reason, and `meeting_not_convened` is emitted. Nothing is invented,
  and no contribution is written for someone who was not there.
- **A contribution is an Artifact of type `meeting_contribution`, never a `deliverable`.** No later step can
  take what someone said in a room as verified evidence.
- **The outcome is code-written from a validated model proposal.** The Manager's close step proposes notes
  and decisions, code validates them against `MEETING_LIMITS`, and `workplace.record_outcome` (a governed
  WRITE Capability) writes the record. `meeting_closed` carries the counts.
- **A decision is not work until the operator says so.** `meeting_action_started` exists only when the
  operator turns a recorded decision into a Goal; the room cannot start its own follow-up.
- **A meeting earns nothing.** `meeting_contribution` and `meeting_outcome` are declared in
  `src/capabilities/progressionFacts.ts` as Task kinds that are attendance rather than work, so the
  progression projector skips those Runs entirely: no turn XP, no capability XP, no Workflow Run XP, no
  mission XP, no achievement. Without that the Manager — which schedules meetings autonomously — could mint
  progression for the whole Keep by calling an all-hands (`tests/api/meetings.test.ts`, "earns nobody
  anything").

## Working hours vs. the runtime (R2 Stages 7–8)

Three things are kept apart, because merging any two of them makes working hours a hidden emergency stop:

1. **Availability / scheduling** — `availabilityOf` and `availableAt` in `src/workplace/availability.ts`
   answer "may this agent be booked?", returning available / busy / unavailable with a reason. `BLOCKING`
   includes `break`: time off is not work.
2. **Runtime execution** — the interpreter never consults working hours. A Run in flight keeps running past
   17:00; the only things that halt execution are an emergency stop, Policy, and budget. Working hours reach
   the runtime in exactly one place: `unavailabilityCode` in `src/capabilities/manager/mission.ts`, which
   stops the *Manager* from delegating new work to someone who is not at work. `workplace_settings.work_outside_hours`
   (migration 0028) governs that and defaults to `allow`, so no existing install changed behaviour.
3. **Ambient presentation** — `src/api/agentState.ts` derives one state per agent from real rows, in a fixed
   priority: `stopped › awaiting_approval › in_meeting › working › waiting_dependency › on_break ›
   outside_hours › unavailable › available`. `GET /agents/state` serves it and the world renders it.
   Ambient behaviour creates no event, task, run, invocation or artifact, spends no runtime token, and
   changes no score, availability or authority.

## Deadlines

`goals.due_at` (migration 0027) is a time, not an outcome. A goal past its due date is **overdue**, which is
a fact the UI states alongside the real status; it never becomes `failed`, never stops work, and never
changes governance. `overdueNotices` in `src/api/operationalNotices.ts` writes one notice per overdue goal
while the goal is still active — a goal that finished late is history, not an alert.

## Truthful world

A meeting desire (web `lib/activity.ts`) exists only for a presence the API reported. One priority order, no second state machine: stopped › awaiting approval › **real meeting** › working › queued › ambient. A real meeting outranks a run in progress — the agent is at the meeting, and its run keeps running without it. Participants walk to the room at the hurried pace, stand facing the room's middle as "in a meeting" (never "working"), and return to ambient life when the meeting ends. Idle agents do not wander into a room hosting a meeting. An agent in a meeting cannot be given new work: Talk refuses `in_meeting`; the Manager's roster marks it unavailable.

## Role icons (identity)

`[icon] Name` wherever an agent is named. The catalogue is `src/definitions/roleIconCatalogue.json` (12x12
bitmaps, one identity colour token each); `src/definitions/roleIcon.ts` resolves an agent's icon, and
`GET /role-icons` serves the catalogue and every agent's icon. `POST /agent-role-icons/:name` lets the
operator choose one (`agent_role_icons`, keyed by name).

- **Identity, never authority.** An icon grants nothing, implies no capability, and changing one changes no
  Grant, Policy decision, budget, route, context or score. A structural invariant keeps the tables and the
  module out of everything else, and the Manager may never write one. No model picks an icon: only ids in
  the catalogue exist.
- **Stable across versions.** The icon follows the persistent NAME, derived from that agent's FIRST
  version's role and objective — the earliest row, which never changes — so a reworded v2 keeps its icon.
- **Colour is never status.** Role colours are their own `--role-*` tokens, none of them a `--state-*` hue,
  and every role also has its own symbol, so the icons are still told apart without colour. Icons are
  decorative in the DOM: the name remains the accessible label, and the tooltip names the role.
- **Web.** `RoleIconsProvider` reads the catalogue once; `AgentLabel` / `AgentLabels` render `[icon] Name`
  in the world tags and agent panel, the Overview and agent rosters and profile, Calendar (participants,
  organiser, entries, notifications, the participant chooser), Command (plan tasks, meeting participants,
  steps, evidence), History, workflow steps, the Keeper's explanations and Settings. Select options stay
  text-only (an `<option>` cannot hold an icon). An unknown agent or unreadable catalogue shows the name
  alone.

## Not built

External calendars, email/Slack/Teams, OAuth, recurring events (the model has one-time rows; recurrence would add a rule column and expansion in `loadCommitments`), model-authored meeting notes, sitting animations (the kit has no sitting pose: agents stand), meeting-room furniture art (rooms are placed on drawn rooms that already have tables).

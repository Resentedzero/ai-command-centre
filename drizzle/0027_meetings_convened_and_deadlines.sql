-- Stage 4-6: a meeting that actually HAPPENED, and a Goal that is due by a time.
--
-- `workplace_meetings.convened_goal_id` / `convened_at`: a meeting whose time has passed is only
-- `completed` in the sense that its end time is behind us. These two columns record the other thing —
-- that the Keep actually held it: the Goal of the round-table Workflow Run that convened it, and when.
-- Null means it was never held, which is a fact worth showing rather than hiding.
--
-- `workplace_meetings.not_convened_reason`: why the runtime could not hold it (a participant was busy,
-- stopped, or the room's meeting had already been cancelled). Recorded once, never guessed.
--
-- `goals.due_at`: when the operator needs it by. Nothing estimates durations and nothing promises to
-- finish on time; "overdue" is derived from the clock exactly like a meeting's status.
ALTER TABLE "workplace_meetings" ADD COLUMN "convened_goal_id" uuid REFERENCES "goals"("id");
ALTER TABLE "workplace_meetings" ADD COLUMN "convened_at" timestamp with time zone;
ALTER TABLE "workplace_meetings" ADD COLUMN "not_convened_reason" text;
ALTER TABLE "goals" ADD COLUMN "due_at" timestamp with time zone;

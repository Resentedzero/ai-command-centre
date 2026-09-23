/**
 * The workplace Capability contracts (no imports: loaded by the adapter registry and the seed).
 *
 * `workplace.inspect_calendar` (READ): a compact view of the Keep's clock, working hours, rooms and the
 * coming week's meetings, computed by code. `workplace.schedule_meeting`: puts a code-validated meeting
 * record into effect — CREATE schedules a meeting, WRITE moves or cancels one. Internal office records
 * only: no external calendar, message or other side effect, which is why the Manager's Grants for them are
 * autonomous. An operator who wants approval changes the Grant, and Policy does the rest.
 */
export const WORKPLACE_INSPECT_CALENDAR_CAPABILITY = {
  id: "workplace.inspect_calendar",
  description: "Read the Command Keep's calendar: the workplace clock and working hours, meeting rooms, and the coming week's meetings",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

export const WORKPLACE_SCHEDULE_MEETING_CAPABILITY = {
  id: "workplace.schedule_meeting",
  description: "Schedule (CREATE), move or cancel (WRITE) an internal meeting from a code-validated record; internal records only",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

/**
 * `workplace.record_outcome` (WRITE): put a code-validated record of what a meeting produced — notes and
 * decisions written by the agents who actually attended — onto the meeting. Its own Capability, separate
 * from scheduling, so an operator can require approval for what a meeting concluded while leaving the
 * diary autonomous. It records; it starts no work. Turning a decision into work is a separate act.
 */
export const WORKPLACE_RECORD_OUTCOME_CAPABILITY = {
  id: "workplace.record_outcome",
  description: "Record what a meeting produced (notes and decisions) from a code-validated record; internal records only, starts no work",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

export const MEETING_ACTIONS = ["schedule", "reschedule", "cancel"] as const;
export type MeetingAction = (typeof MEETING_ACTIONS)[number];
export const permissionForMeetingAction = (action: MeetingAction) => (action === "schedule" ? "CREATE" : "WRITE");

export const WORKPLACE_CALENDAR_READ = "workplace.calendar.read";
export const WORKPLACE_MEETING_RECORD = "workplace.meeting.record";
export const WORKPLACE_OUTCOME_RECORD = "workplace.outcome.record";

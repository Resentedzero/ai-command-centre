/**
 * The internal functions behind the workplace Capabilities. Reading and checking happen in `prepare`
 * (the builder's transaction, from stored rows); `execute` only returns what `prepare` settled. Nothing
 * here writes: a meeting takes effect in the Manager plan's following deterministic position, and only
 * after this invocation passed Grant, stops, Policy and budget and completed.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { codeWrittenRecord } from "../manager/mission.js";
import { calendarView, type MeetingRecord } from "../manager/meeting.js";
import { MEETING_ACTIONS, WORKPLACE_CALENDAR_READ, WORKPLACE_INSPECT_CALENDAR_CAPABILITY, WORKPLACE_MEETING_RECORD, WORKPLACE_OUTCOME_RECORD, WORKPLACE_RECORD_OUTCOME_CAPABILITY, WORKPLACE_SCHEDULE_MEETING_CAPABILITY } from "./capability.js";

export const workplaceCalendarRead: InternalToolFunction = {
  capabilityName: WORKPLACE_INSPECT_CALENDAR_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const keys = Object.keys(proposedActionSnapshot);
    if (keys.length !== 1 || keys[0] !== "days" || proposedActionSnapshot.days !== 7) throw new Error(`${WORKPLACE_CALENDAR_READ}: the request must be exactly { days: 7 } (fail closed).`);
    return { inputs: { calendar: await calendarView(tx, new Date()) }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  async execute({ inputs }) {
    return inputs.calendar as Record<string, unknown>;
  },
};

/**
 * The snapshot names the code-written plan record and its action; `prepare` confirms the record was written
 * by code in a Manager plan step and carries a valid meeting for exactly that action. The Grant checked is
 * CREATE for scheduling and WRITE for moving or cancelling (the plan resolves it from the action).
 */
export const workplaceMeetingRecord: InternalToolFunction = {
  capabilityName: WORKPLACE_SCHEDULE_MEETING_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot }) {
    const record = await codeWrittenRecord(tx, proposedActionSnapshot.recordArtifactId);
    const meeting = record?.content.meeting as MeetingRecord | undefined;
    if (!record || record.content.valid !== true || !meeting || !(MEETING_ACTIONS as readonly unknown[]).includes(meeting.action) || meeting.action !== proposedActionSnapshot.action) {
      throw new Error(`${WORKPLACE_MEETING_RECORD}: no valid code-written meeting record was named for this action (fail closed).`);
    }
    return { inputs: { meeting: { action: meeting.action, meetingId: meeting.meetingId, title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, roomName: meeting.roomName, participants: meeting.participants.length, recordArtifactId: proposedActionSnapshot.recordArtifactId } }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  async execute({ inputs }) {
    return { meeting: inputs.meeting };
  },
};

/**
 * The snapshot names a code-written meeting-outcome record. `prepare` confirms the record was written by
 * code in a meeting's outcome step and holds notes or decisions for exactly the meeting named. Like the
 * scheduling adapter it writes nothing: the following deterministic position records the outcome, and only
 * after this invocation has passed Grant, stops, Policy and budget.
 */
export const workplaceOutcomeRecord: InternalToolFunction = {
  capabilityName: WORKPLACE_RECORD_OUTCOME_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot }) {
    const record = await codeWrittenRecord(tx, proposedActionSnapshot.recordArtifactId);
    const outcome = record?.content.outcome as { meetingId?: string; notes?: unknown[]; decisions?: unknown[] } | undefined;
    if (!record || record.content.valid !== true || !outcome || outcome.meetingId !== proposedActionSnapshot.meetingId || (outcome.notes ?? []).length + (outcome.decisions ?? []).length === 0) {
      throw new Error(`${WORKPLACE_OUTCOME_RECORD}: no valid code-written outcome record was named for this meeting (fail closed).`);
    }
    return {
      inputs: { outcome: { meetingId: outcome.meetingId, notes: (outcome.notes ?? []).length, decisions: (outcome.decisions ?? []).length, recordArtifactId: proposedActionSnapshot.recordArtifactId } },
      costClass: "local_retrieval",
      estimatedCost: 0,
    };
  },
  async execute({ inputs }) {
    return { outcome: inputs.outcome };
  },
};

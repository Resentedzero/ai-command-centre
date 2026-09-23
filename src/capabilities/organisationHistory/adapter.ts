/**
 * The internal function behind `manager.inspect_history` (R2 Stage 10).
 *
 * It lives in its own capability directory, beside `keepStats/`, and NOT in `capabilities/manager/`: that
 * module may not import the API layer (a structural invariant), and the organisational history read model
 * lives there. The Manager's plan names only the capability contract, never this implementation — which is
 * exactly the separation the invariant exists to keep.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { organisationHistory } from "../../api/organisationHistory.js";
import { HISTORY_DAYS, HISTORY_LIMIT, MANAGER_HISTORY_READ, MANAGER_INSPECT_HISTORY_CAPABILITY } from "../manager/capability.js";

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * What the Keep recently did (R2 Stage 10). The snapshot is fixed by CODE — exactly `{ days: 7 }`, the
 * same shape the calendar read uses — so no model can widen the window, name another agent's history, or
 * ask a question of its own. The answer is facts and ids: statuses, reason codes, decision texts the
 * runtime stamped, and artifact ids with their hashes. No artifact content, ever.
 */
export const managerHistoryRead: InternalToolFunction = {
  capabilityName: MANAGER_INSPECT_HISTORY_CAPABILITY.id,
  evidenceClass: "system_state",
  async prepare(tx, { proposedActionSnapshot }) {
    const keys = Object.keys(proposedActionSnapshot);
    if (keys.length !== 1 || keys[0] !== "days" || proposedActionSnapshot.days !== HISTORY_DAYS) {
      throw new Error(`${MANAGER_HISTORY_READ}: the request must be exactly { days: ${HISTORY_DAYS} } (fail closed).`);
    }
    const history = await organisationHistory(tx, { hours: HISTORY_DAYS * 24, limit: HISTORY_LIMIT });
    // Trimmed to what planning can act on. A mission the Manager cannot do anything about is noise.
    return {
      inputs: {
        history: {
          window: history.window,
          missions: history.missions.map((m) => ({
            goalId: m.goalId,
            title: clip(m.title, 120),
            status: m.status,
            overdue: m.overdue,
            agents: m.agents,
            reasons: m.reasons.slice(0, 3).map((r) => ({ code: r.code, detail: clip(r.detail, 160) })),
            deliverables: m.deliverables.map((d) => ({ artifactId: d.artifactId, hash: d.hash })),
            ...(m.fromDecision ? { fromDecision: { meetingId: m.fromDecision.meetingId, text: clip(m.fromDecision.text, 160) } } : {}),
          })),
          decisions: history.meetings.flatMap((m) => m.decisions.map((d) => ({ meetingId: m.meetingId, meeting: clip(m.title, 80), text: clip(d.text, 160) }))).slice(0, HISTORY_LIMIT),
          outstandingFollowUps: history.followUps.filter((f) => f.outstanding).map((f) => ({ goalId: f.goalId, goalTitle: clip(f.goalTitle, 120), decision: clip(f.decision, 160) })),
        },
      },
      costClass: "local_retrieval",
      estimatedCost: 0,
    };
  },
  async execute({ inputs }) {
    return inputs.history as Record<string, unknown>;
  },
};

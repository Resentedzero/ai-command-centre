/**
 * The Keeper's supported explanation intents (R2 Stage 6). A small, explicit set — not an open
 * agent. Each intent says which subjects it can explain and which record is authoritative for
 * it; `classifyQuestion` maps an operator's question to one deterministically (no model).
 *
 * Plan: docs/superpowers/plans/2026-09-16-r2.0-plan.md §12. Architecture: docs/architecture/KEEPER.md.
 */

export type SubjectKind = "system" | "agent" | "run" | "workflow_run" | "goal" | "approval" | "artifact";

export type IntentId =
  | "delay"
  | "progression"
  | "xp_ledger"
  | "level"
  | "performance"
  | "quality_verdict"
  | "achievements"
  | "specialisation"
  | "endorsements"
  | "run_outcome"
  | "evidence"
  | "handoff"
  | "policy"
  | "budget"
  | "model_tier"
  | "stop_reason"
  | "ambient"
  | "workplace";

export type IntentSpec = {
  id: IntentId;
  label: string;
  /** Subjects it can explain. `agent` intents also accept an agent named in the question. */
  subjects: SubjectKind[];
  /** The authoritative record(s): what a fact in this answer may come from. */
  authority: string[];
  /** Question words, checked in INTENTS order (most specific first). */
  keywords: RegExp;
};

const RUNS: SubjectKind[] = ["run", "workflow_run", "goal"];

export const INTENTS: IntentSpec[] = [
  // R2 Stage 10. Placed FIRST so "why is this late / delayed / waiting" is read as a question about
  // progress rather than matching a more general intent's keywords.
  {
    id: "delay",
    label: "Why is this late, waiting or not finished?",
    subjects: [...RUNS, "agent"],
    authority: ["goals.due_at", "workflow_runs.variables", "approvals", "runs.status", "events.run_failed"],
    keywords: /\b(delay|delayed|late|overdue|behind schedule|held up|stuck|not started|no progress|taking so long|why.*(not working|isn.t working|not running|not finished))/i,
  },
  { id: "workplace", label: "Meetings, calendar and availability", subjects: ["system", "agent"], authority: ["workplace_meetings", "workplace_calendar_events", "events.meeting_*", "events.manager_plan_rejected"], keywords: /\b(meeting|calendar|schedul|room|availab|who is free|free this|agenda|boardroom|conference)/i },
  { id: "ambient", label: "Real activity or ambient animation?", subjects: ["agent", "system"], authority: ["runs.status", "execution_stops", "presentation rules"], keywords: /\b(ambient|idle|walking|resting|animat|sprite|real activity)/i },
  { id: "handoff", label: "What was handed from one agent to another?", subjects: [...RUNS, "artifact"], authority: ["events.agent_loop_iteration_recorded (verified handoff)", "events.context_compiled", "artifacts.hash"], keywords: /\b(hand ?off|handed|handover|passed (to|from)|from one agent)/i },
  { id: "endorsements", label: "Who endorsed this agent's work?", subjects: ["agent", "artifact"], authority: ["agent_endorsements"], keywords: /\bendors/i },
  { id: "quality_verdict", label: "What quality verdicts were given?", subjects: ["artifact", "agent"], authority: ["events.quality_verdict_recorded"], keywords: /\b(verdict|quality|judg|rated|rating)/i },
  { id: "achievements", label: "Why does it have these achievements?", subjects: ["agent"], authority: ["agent_achievements"], keywords: /\b(achievement|badge)/i },
  { id: "specialisation", label: "Why is it a specialist?", subjects: ["agent"], authority: ["agent_domain_work"], keywords: /\b(speciali[sz]|specialist|expert|domain)/i },
  { id: "level", label: "Why is it this level?", subjects: ["agent"], authority: ["agent_xp_awards", "levelFor (progression rules)"], keywords: /\blevel|\blv\b/i },
  { id: "xp_ledger", label: "How did it earn its XP?", subjects: ["agent"], authority: ["agent_xp_awards"], keywords: /\b(xp|experience|earn)/i },
  { id: "model_tier", label: "Why this model or tier?", subjects: RUNS, authority: ["events.invocation_started (Model Router)"], keywords: /\b(model|tier|haiku|sonnet|opus|cheap|strong)\b/i },
  { id: "budget", label: "How much did it consume?", subjects: [...RUNS, "agent"], authority: ["events.budget_consumed", "events.budget_denied"], keywords: /\b(budget|cost|token|resource|consum|spend|spent|quota)/i },
  { id: "policy", label: "Why was an action allowed, refused or held for approval?", subjects: [...RUNS, "approval"], authority: ["events.policy_evaluated", "events.approval_*"], keywords: /\b(allow|refus|denied|deny|policy|permission|approv|grant|waiting)/i },
  { id: "stop_reason", label: "Why did it stop?", subjects: RUNS, authority: ["events.agent_loop_iteration_recorded (terminal)", "events.run_halted", "events.invocation_failed"], keywords: /\b(stop|halt|ended|end\b|finish|limit)/i },
  { id: "evidence", label: "What evidence supports this result?", subjects: ["artifact", ...RUNS], authority: ["events.agent_loop_iteration_recorded (verified evidence)", "artifacts.hash"], keywords: /\b(evidence|verif|prove|proof|sources?\b|trust)/i },
  { id: "performance", label: "How well has it performed?", subjects: ["agent"], authority: ["agent_performance"], keywords: /\b(perform|success rate|reliab|track record)/i },
  { id: "run_outcome", label: "What happened in this run?", subjects: RUNS, authority: ["runs.status", "events.run_completed / run_failed", "events.agent_loop_iteration_recorded (terminal)"], keywords: /\b(succe|fail|outcome|happen|result|went|status)/i },
  { id: "progression", label: "How is this agent progressing?", subjects: ["agent"], authority: ["agent_xp_awards", "agent_achievements", "agent_domain_work", "agent_performance"], keywords: /\b(progress|contribut|growth|reputation|how is .* doing)/i },
];

export const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]));

export function isIntentId(value: unknown): value is IntentId {
  return typeof value === "string" && INTENT_BY_ID.has(value as IntentId);
}

/**
 * The first intent whose words appear in the question and that can explain this subject (or an
 * agent named in it); failing that, the first whose words appear at all, so the answer can say
 * which subject it needs. Null when no intent's words appear.
 */
export function classifyQuestion(question: string, subjectKind: SubjectKind, namesAgent: boolean): IntentId | null {
  const matching = INTENTS.filter((i) => i.keywords.test(question));
  const fits = matching.find((i) => i.subjects.includes(subjectKind) || (namesAgent && i.subjects.includes("agent")));
  return (fits ?? matching[0])?.id ?? null;
}

/** The intents this subject supports, for the "here is what I can explain" answer and the UI's choices. */
export function intentsFor(subjectKind: SubjectKind): IntentSpec[] {
  return INTENTS.filter((i) => i.subjects.includes(subjectKind));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether `name` appears in `text` as whole words: no letter or digit directly before or after it. No regex is built from the name. */
function containsWords(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : lower[at - 1]!;
    const after = lower[at + needle.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

/**
 * The agent a question names, by exact persistent name as whole words (case-insensitive, longest
 * name first, so "Field Researcher" wins over "Researcher"). Two names that both match and neither
 * contains the other are ambiguous. `addressee` (the Keeper's own name) is ignored when another
 * agent is named too: "Keeper, why is Researcher level 1?" is about Researcher.
 */
export function agentNamedIn(question: string, names: string[], addressee?: string | null): { name: string } | { ambiguous: string[] } | null {
  const found = [...new Set(names)].filter((n) => n.trim() !== "" && containsWords(question, n)).sort((a, b) => b.length - a.length);
  const distinct = found.filter((n, i) => !found.slice(0, i).some((longer) => longer.toLowerCase().includes(n.toLowerCase())));
  const candidates = addressee && distinct.length > 1 ? distinct.filter((n) => n !== addressee) : distinct;
  if (candidates.length === 0) return null;
  return candidates.length === 1 ? { name: candidates[0]! } : { ambiguous: candidates.sort() };
}

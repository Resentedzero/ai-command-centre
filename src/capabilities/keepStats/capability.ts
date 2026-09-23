/**
 * `system.keep_stats` (R2 operational observability): read aggregate statistics about what the Command
 * Keep recorded during a bounded recent window — goals, workflow runs, runs, invocations, subscription
 * tokens, the agents that did real work, approvals, stops, deliverables and Manager decisions.
 *
 * READ ONLY AND NARROW. The only input is a window from a fixed list. No SQL, table name, filter, path or
 * credential can be expressed, and the result is a short list of counts computed by code from the
 * immutable `events` table — never raw events, artifacts or traces. No model calculates anything.
 */
export const KEEP_STATS_CAPABILITY = {
  id: "system.keep_stats",
  description: "Read aggregate statistics about the Command Keep's recorded activity over a recent window (1h, 6h, 24h or 7d)",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

/** The windows a request may name, in hours. Nothing else is accepted. */
export const KEEP_STATS_WINDOWS = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 } as const;
export type KeepStatsWindow = keyof typeof KEEP_STATS_WINDOWS;

export const KEEP_STATS_READ = "system.keep_stats.read";

export function parseKeepStatsWindow(value: unknown): KeepStatsWindow | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KEEP_STATS_WINDOWS, value) ? (value as KeepStatsWindow) : null;
}

/**
 * Does a question or objective ask for the Keep's operational statistics? A deterministic heuristic, used
 * where a plan must decide before any model runs (Keeper Think's stats step, the Manager's "who can obtain
 * these facts" check).
 * ponytail: keyword match, may miss unusual phrasings; widen the pattern when a real question slips past.
 */
const STATS_QUESTION = /\b(stats?|statistics|metrics|(last|past) (hour|day|week|24 ?h|\d+ ?(hours?|days?)))\b/i;
export function asksForKeepStats(text: string): boolean {
  return STATS_QUESTION.test(text);
}

/** The window a question names, defaulting to the last hour. */
export function windowForQuestion(text: string): KeepStatsWindow {
  if (/\b(week|7 ?d(ays?)?)\b/i.test(text)) return "7d";
  if (/\b(day|today|24 ?h(ours?)?)\b/i.test(text)) return "24h";
  if (/\b6 ?h(ours?)?\b/i.test(text)) return "6h";
  return "1h";
}

/** The human-readable values of a stored stats result (for the Keeper's unsupported-number tripwire). */
export function keepStatsText(stored: string): string {
  try {
    const s = JSON.parse(stored) as { window?: { from?: string; to?: string }; results?: { metric?: string; value?: unknown }[]; agents?: { name?: string; runsCompleted?: unknown; subscriptionTokens?: unknown }[] };
    return [
      s.window?.from ?? "",
      s.window?.to ?? "",
      ...(s.results ?? []).map((r) => `${r.metric} ${r.value}`),
      ...(s.agents ?? []).map((a) => `${a.name} ${a.runsCompleted} ${a.subscriptionTokens}`),
    ].join("\n");
  } catch {
    return "";
  }
}

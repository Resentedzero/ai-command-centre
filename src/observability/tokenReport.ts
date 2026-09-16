/**
 * TOKEN REPORT — what a Run actually spent, and on what.
 *
 * R2 Stage 1 has to prove an economy rather than assert one, so this reads the facts the
 * runtime already records and derives nothing it cannot support:
 *   - `invocation_completed` carries the usage (`tokens_in`, `tokens_out`, `cost_amount`,
 *     `cost_unit`, `model_id`). `cost_amount` is what the provider charged the counter;
 *     `tokens_in + tokens_out` is only the primary model's share, so the difference is the
 *     secondary model's, which the event columns do not carry separately.
 *   - `context_compiled` carries what was sent (`estimatedInputTokens`) and what was left out.
 *   - `agent_loop_iteration_recorded` carries per-iteration outcomes and the terminal reason.
 *   - `artifact_created` carries what the Run produced.
 *
 * Read-only: no write path imports this, and it never runs on the execution path.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, invocations } from "../db/schema.js";

export type CallLine = {
  seqNo: number | null;
  kind: string | null;
  intent: string | null;
  estimatedInputTokens: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  counted: number | null;
  /** counted − (in + out): the secondary model's share, which has no column of its own. */
  unattributed: number | null;
  unit: string | null;
  modelId: string | null;
};

export type RunTokenReport = {
  runId: string;
  unit: string | null;
  calls: CallLine[];
  modelCalls: number;
  totals: { counted: number; input: number; output: number; unattributed: number; estimatedInput: number };
  share: { output: number; context: number; unattributed: number };
  iterations: { iteration: number; action: string; outcome: string }[];
  terminal: { status: string; reason: string; iterations: number; maxIterations: number } | null;
  artifacts: number;
  contextExclusions: number;
  /** Counted tokens per iteration the loop actually completed — the Stage 1 metric. */
  perCompletedIteration: number | null;
  /** Counted tokens for the whole Run when it produced a deliverable; null when it did not. */
  perDeliverable: number | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export async function runTokenReport(runId: string): Promise<RunTokenReport> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), inArray(events.eventType, ["invocation_completed", "context_compiled", "agent_loop_iteration_recorded", "artifact_created"])))
    .orderBy(asc(events.sequenceNo));

  const invocationRows = await db.select().from(invocations).where(eq(invocations.runId, runId));
  const byId = new Map(invocationRows.map((i) => [i.id, i]));

  const compiled = new Map<string, { intent: string | null; estimated: number | null; excluded: number }>();
  for (const row of rows.filter((r) => r.eventType === "context_compiled")) {
    const p = asRecord(row.payload);
    if (!row.invocationId) continue;
    compiled.set(row.invocationId, {
      intent: typeof p.intent === "string" ? p.intent : null,
      estimated: num(p.estimatedInputTokens),
      excluded: Array.isArray(p.excluded) ? p.excluded.length : 0,
    });
  }

  const calls: CallLine[] = [];
  for (const row of rows) {
    if (row.eventType !== "invocation_completed" || row.costAmount === null) continue;
    const inv = row.invocationId ? byId.get(row.invocationId) : undefined;
    const ctx = row.invocationId ? compiled.get(row.invocationId) : undefined;
    const counted = num(row.costAmount);
    const tokensIn = row.tokensIn;
    const tokensOut = row.tokensOut;
    calls.push({
      seqNo: inv?.seqNo ?? null,
      kind: inv?.kind ?? null,
      intent: ctx?.intent ?? null,
      estimatedInputTokens: ctx?.estimated ?? null,
      tokensIn,
      tokensOut,
      counted,
      unattributed: counted !== null && tokensIn !== null && tokensOut !== null ? counted - tokensIn - tokensOut : null,
      unit: row.costUnit,
      modelId: row.modelId,
    });
  }

  const iterationEvents = rows.filter((r) => r.eventType === "agent_loop_iteration_recorded").map((r) => asRecord(r.payload));
  const iterations = iterationEvents
    .filter((p) => p.iteration !== null && p.iteration !== undefined)
    .map((p) => ({
      iteration: Number(p.iteration),
      action: String(p.action ?? ""),
      outcome: String(asRecord(p.outcome).status ?? ""),
    }));
  const terminalPayload = iterationEvents.find((p) => p.terminal);
  const terminal = terminalPayload
    ? {
        status: String(asRecord(terminalPayload.terminal).status ?? ""),
        reason: String(asRecord(terminalPayload.terminal).reason ?? ""),
        iterations: Number(terminalPayload.iterations ?? 0),
        maxIterations: Number(terminalPayload.maxIterations ?? 0),
      }
    : null;

  const sum = (pick: (c: CallLine) => number | null) => calls.reduce((t, c) => t + (pick(c) ?? 0), 0);
  const totals = {
    counted: sum((c) => c.counted),
    input: sum((c) => c.tokensIn),
    output: sum((c) => c.tokensOut),
    unattributed: sum((c) => c.unattributed),
    estimatedInput: sum((c) => c.estimatedInputTokens),
  };
  const pct = (part: number) => (totals.counted > 0 ? Math.round((part / totals.counted) * 1000) / 10 : 0);
  const completed = iterations.filter((i) => i.outcome === "completed").length;
  const artifactCount = rows.filter((r) => r.eventType === "artifact_created").length;
  const producedDeliverable = rows.some((r) => r.eventType === "artifact_created" && String(asRecord(r.payload).type ?? "") === "deliverable");

  return {
    runId,
    unit: calls[0]?.unit ?? null,
    calls,
    modelCalls: calls.length,
    totals,
    share: { output: pct(totals.output), context: pct(totals.estimatedInput), unattributed: pct(totals.unattributed - totals.estimatedInput) },
    iterations,
    terminal,
    artifacts: artifactCount,
    contextExclusions: [...compiled.values()].reduce((t, c) => t + c.excluded, 0),
    perCompletedIteration: completed > 0 ? Math.round(totals.counted / completed) : null,
    perDeliverable: producedDeliverable ? totals.counted : null,
  };
}

export function formatTokenReport(report: RunTokenReport): string {
  const lines = [
    `Run ${report.runId} — ${report.totals.counted} ${report.unit ?? "tokens"} over ${report.modelCalls} model calls`,
    `  output ${report.totals.output} (${report.share.output}%) · context sent ${report.totals.estimatedInput} (${report.share.context}%) · other ${report.share.unattributed}%`,
    ...report.calls.map(
      (c) => `  #${c.seqNo ?? "?"} ${c.intent ?? c.kind ?? "?"}: sent ~${c.estimatedInputTokens ?? "?"}, out ${c.tokensOut ?? "?"}, counted ${c.counted ?? "?"} (${c.modelId ?? "?"})`
    ),
  ];
  if (report.terminal) lines.push(`  loop: ${report.terminal.iterations} of ${report.terminal.maxIterations} iterations, ${report.terminal.status} / ${report.terminal.reason}`);
  if (report.perCompletedIteration !== null) lines.push(`  per completed iteration: ${report.perCompletedIteration}`);
  if (report.perDeliverable !== null) lines.push(`  to a finished deliverable: ${report.perDeliverable}`);
  if (report.contextExclusions > 0) lines.push(`  context exclusions: ${report.contextExclusions} (something did not fit)`);
  return lines.join("\n");
}

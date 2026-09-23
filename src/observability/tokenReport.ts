/**
 * TOKEN REPORT — what a Run actually spent, and on what.
 *
 * R2 Stage 1 has to prove an economy rather than assert one, so this reads the facts the
 * runtime already records and derives nothing it cannot support:
 *   - `invocation_completed` carries the usage (`tokens_in`, `tokens_out`, `cost_amount`,
 *     `cost_unit`, `model_id`).
 *
 *     CORRECTED 2026-09-18 (R2 Task 42). An earlier revision of this header claimed the difference
 *     between `cost_amount` and the primary's in+out was "everything the provider did not attribute to
 *     the primary entry, including cached input", and "not splittable". BOTH CLAIMS WERE FALSE for a
 *     token-denominated call. `cost_amount` is defined as the sum of `inputTokens + outputTokens` over
 *     every reported model entry and NOTHING ELSE — cache and thinking tokens are never added to it —
 *     so the residual is EXACTLY the non-primary entries' in+out, by construction. Since Task 42 the
 *     per-model split is persisted too, in `invocation_completed`'s `usageAccounting.secondary`.
 *
 *     THE RESIDUAL IS ONLY MEANINGFUL FOR A TOKEN UNIT. For a `usd` call, `cost_amount` is money and
 *     `tokens_in`/`tokens_out` are tokens; subtracting one from the other mixes units, so it is not
 *     computed at all and reads as unknown.
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
  /**
   * For a TOKEN unit: counted − (primary in + out), which is exactly the non-primary model entries'
   * reported tokens. Null for a money unit, where the subtraction would mix dollars with tokens.
   */
  secondaryTokens: number | null;
  /** The per-model split, when the provider gave one (`usageAccounting.secondary`). */
  secondaryByModel: Array<{ modelId: string; input: number | null; output: number | null }> | null;
  unit: string | null;
  modelId: string | null;
};

export type RunTokenReport = {
  runId: string;
  unit: string | null;
  calls: CallLine[];
  modelCalls: number;
  totals: { counted: number; input: number; output: number; secondaryTokens: number; estimatedInput: number };
  share: { output: number; context: number; secondary: number };
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
/** Whether amounts in this unit are token counts, and so share a dimension with tokensIn/tokensOut. */
function isTokenUnit(unit: string | null): boolean {
  return unit === "subscription_tokens" || unit === "local_tokens";
}

/** The per-model secondary split the adapter recorded, when the event carries one (R2 Task 42). */
function secondaryOf(payload: unknown): Array<{ modelId: string; input: number | null; output: number | null }> | null {
  const a = asRecord(asRecord(payload).usageAccounting);
  return Array.isArray(a.secondary) ? (a.secondary as Array<{ modelId: string; input: number | null; output: number | null }>) : null;
}

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
      // Only for a token unit — see the header. A money `counted` shares no dimension with tokens.
      secondaryTokens:
        isTokenUnit(row.costUnit) && counted !== null && tokensIn !== null && tokensOut !== null ? counted - tokensIn - tokensOut : null,
      secondaryByModel: secondaryOf(row.payload),
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
    secondaryTokens: sum((c) => c.secondaryTokens),
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
    // `secondary` is the non-primary models' share of a TOKEN total — exact, not a residual of
    // unknowns (see the header). `context` is the COMPILER'S ESTIMATE expressed against a
    // provider-COUNTED total: an estimate over a measurement, indicative only, and the estimator is
    // known to under-count. The two views overlap (a secondary call re-reads the same context), so
    // they are never subtracted from one another. Both are 0 when the unit is money, because neither
    // ratio has a meaning there.
    share: { output: pct(totals.output), context: pct(totals.estimatedInput), secondary: pct(totals.secondaryTokens) },
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
    // An unrecorded unit is printed as unknown, never silently called tokens.
    `Run ${report.runId} — ${report.totals.counted} ${report.unit ?? "(unit not recorded)"} over ${report.modelCalls} model calls`,
    isTokenUnit(report.unit)
      ? `  output ${report.totals.output} (${report.share.output}%) · context sent ~${report.totals.estimatedInput} (${report.share.context}%, ESTIMATED) · secondary models ${report.totals.secondaryTokens} (${report.share.secondary}%)`
      : `  priced in ${report.unit} at local list rates — an estimate, not a bill; token shares are not comparable to it`,
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

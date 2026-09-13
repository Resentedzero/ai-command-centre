/** PHASE 2 analysis. BENCHMARK ARTIFACT — reads results, derives aggregates, prints tables. */
import { readFileSync } from "node:fs";

type Run = Record<string, any>;
const data = JSON.parse(readFileSync("benchmark/raw/phase2-results.json", "utf8")) as {
  haltedEarly: boolean;
  results: Run[];
};

// Verified list prices (asymmetric), $/token.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 0.000001, out: 0.000005 },
  "claude-opus-5": { in: 0.000005, out: 0.000025 },
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`);
const cv = (xs: number[]) => {
  const m = mean(xs);
  if (m === 0) return 0;
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  return (sd / m) * 100;
};

const ok = data.results.filter((r) => r.success);
console.log(`RUNS: ${data.results.length} total, ${ok.length} success, ${data.results.length - ok.length} failed`);
console.log(`HALTED EARLY: ${data.haltedEarly}`);
console.log(
  `STRUCTURED OUTPUT VALID: ${ok.filter((r) => r.structuredOutputValid).length}/${ok.length}` +
    ` (${((ok.filter((r) => r.structuredOutputValid).length / ok.length) * 100).toFixed(0)}%)`
);

const cheap = ok.filter((r) => r.tier === "CHEAP");
const byWorkload = new Map<string, Run[]>();
for (const r of cheap) {
  if (!byWorkload.has(r.workloadId)) byWorkload.set(r.workloadId, []);
  byWorkload.get(r.workloadId)!.push(r);
}

console.log("\n=== PER-WORKLOAD (CHEAP / haiku, n=3) ===");
console.log(
  [
    "workload".padEnd(22),
    "stdinKB".padStart(8),
    "A:in+out".padStart(9),
    "B:cacheCr".padStart(10),
    "D:total".padStart(9),
    "B/A".padStart(6),
    "B as %D".padStart(8),
    "medLat_ms".padStart(10),
    "latCV%".padStart(7),
    "cacheCV%".padStart(9),
  ].join(" ")
);

const rows: any[] = [];
for (const [id, runs] of byWorkload) {
  const A = runs.map((r) => r.reported.A_adapterAccounting_inPlusOut as number);
  const B = runs.map((r) => r.reported.B_cacheCreationInputTokens as number);
  const D = runs.map((r) => r.reported.D_totalReportedFootprint as number);
  const L = runs.map((r) => r.wallClockMs as number);
  const stdinKB = (runs[0]!.stdinBytes as number) / 1024;
  const row = {
    id,
    stdinKB,
    A: mean(A),
    B: mean(B),
    D: mean(D),
    ratio: mean(B) / mean(A),
    medLat: median(L),
    latCV: cv(L),
    cacheCV: cv(B),
    inTok: mean(runs.map((r) => r.reported.inputTokens as number)),
    outTok: mean(runs.map((r) => r.reported.outputTokens as number)),
  };
  rows.push(row);
  console.log(
    [
      id.padEnd(22),
      stdinKB.toFixed(1).padStart(8),
      Math.round(row.A).toString().padStart(9),
      Math.round(row.B).toString().padStart(10),
      Math.round(row.D).toString().padStart(9),
      row.ratio.toFixed(2).padStart(6),
      pct(row.B, row.D).padStart(8),
      Math.round(row.medLat).toString().padStart(10),
      row.latCV.toFixed(1).padStart(7),
      row.cacheCV.toFixed(1).padStart(9),
    ].join(" ")
  );
}

console.log("\n=== CACHE-CREATION FLOOR vs CONTEXT SCALING ===");
const sorted = [...rows].sort((a, b) => a.stdinKB - b.stdinKB);
for (const r of sorted) {
  console.log(
    `  ${r.id.padEnd(22)} stdin=${r.stdinKB.toFixed(1).padStart(6)}KB  cacheCreate=${Math.round(r.B).toString().padStart(6)}` +
      `  perKB=${(r.B / r.stdinKB).toFixed(0).padStart(6)}`
  );
}
const smallest = sorted[0]!;
const largest = sorted[sorted.length - 1]!;
console.log(
  `  -> floor (smallest workload): ~${Math.round(smallest.B)} cache-creation tokens for ${smallest.stdinKB.toFixed(1)}KB stdin`
);
console.log(
  `  -> largest: ${Math.round(largest.B)} for ${largest.stdinKB.toFixed(1)}KB (${(largest.B / smallest.B).toFixed(1)}x the floor at ${(largest.stdinKB / smallest.stdinKB).toFixed(0)}x the input)`
);

console.log("\n=== STRONG RUN (opus) — secondary modelUsage entry check ===");
const strong = ok.find((r) => r.tier === "STRONG");
if (strong) {
  console.log(`  modelUsage entry count: ${strong.modelUsageEntryCount}`);
  for (const e of strong.modelUsageDetail as any[]) {
    console.log(
      `   - ${e.key}: in=${e.inputTokens} out=${e.outputTokens} cacheCreate=${e.cacheCreationInputTokens}` +
        ` thinking=${e.thinkingTokens} provider=${e.provider} costBasis=${e.costBasis}`
    );
  }
  console.log(`  adapter A (in+out, all entries): ${strong.reported.A_adapterAccounting_inPlusOut}`);
  console.log(`  B cacheCreate: ${strong.reported.B_cacheCreationInputTokens}`);
  console.log(`  D total footprint: ${strong.reported.D_totalReportedFootprint}`);
  console.log(`  latency: ${strong.wallClockMs}ms  schemaValid=${strong.structuredOutputValid}`);
}

console.log("\n=== CHEAP modelUsage entry counts (all runs) ===");
const counts = new Map<number, number>();
for (const r of cheap) counts.set(r.modelUsageEntryCount, (counts.get(r.modelUsageEntryCount) ?? 0) + 1);
for (const [n, c] of counts) console.log(`  ${n} entry/entries: ${c} runs`);

console.log("\n=== TOP-LEVEL usage vs modelUsage (inference about hidden calls) ===");
for (const r of [cheap[0]!, strong].filter(Boolean) as Run[]) {
  const top = r.topLevelUsage ?? {};
  console.log(
    `  ${r.workloadId} [${r.tier}] top.input=${top.input_tokens} top.output=${top.output_tokens}` +
      ` | modelUsage.in=${r.reported.inputTokens} modelUsage.out=${r.reported.outputTokens}` +
      ` | delta_in=${(r.reported.inputTokens as number) - (top.input_tokens ?? 0)}`
  );
}

console.log("\n=== LATENCY (all successful runs) ===");
const lat = ok.map((r) => r.wallClockMs as number);
const ttfb = ok.map((r) => r.timeToFirstByteMs as number).filter((x) => typeof x === "number");
console.log(`  wall-clock: min=${Math.min(...lat)}ms median=${median(lat)}ms max=${Math.max(...lat)}ms`);
console.log(`  TTFB:       min=${Math.min(...ttfb)}ms median=${median(ttfb)}ms max=${Math.max(...ttfb)}ms`);
const cold = ok.find((r) => r.cold);
console.log(`  cold run:   ${cold?.workloadId} ${cold?.wallClockMs}ms (vs same-workload warm: ${byWorkload.get(cold!.workloadId)!.slice(1).map((r) => r.wallClockMs).join(", ")}ms)`);

console.log("\n=== ANALYTICAL API EQUIVALENT (NOT measured — no API key in this environment) ===");
console.log("  Priced on reported inputTokens/outputTokens at verified list rates.");
console.log("  Cache-creation tokens EXCLUDED: they are CLI-harness overhead an API call would not incur.");
let apiTotal = 0;
let subsTotalA = 0;
let subsTotalD = 0;
for (const r of ok) {
  const p = PRICING[r.requestedModel as string]!;
  const cost = (r.reported.inputTokens as number) * p.in + (r.reported.outputTokens as number) * p.out;
  apiTotal += cost;
  subsTotalA += r.reported.A_adapterAccounting_inPlusOut as number;
  subsTotalD += r.reported.D_totalReportedFootprint as number;
}
console.log(`  16 runs, analytical API cost: $${apiTotal.toFixed(4)}`);
console.log(`  subscription A (adapter accounting): ${subsTotalA.toLocaleString()} subscription_tokens`);
console.log(`  subscription D (total reported):     ${subsTotalD.toLocaleString()} subscription_tokens`);
console.log(`  D/A ratio: ${(subsTotalD / subsTotalA).toFixed(2)}x — the adapter records A, not D.`);

const diagCost = ok.reduce((a, r) => a + (r.totalCostUsdDiagnostic as number ?? 0), 0);
console.log(`\n  [diagnostic only, costBasis="list", NOT subscription billing] CLI total_cost_usd sum: $${diagCost.toFixed(4)}`);

console.log("\n=== ISOLATION (all runs) ===");
const iso = data.results.map((r) => r.isolation);
console.log(`  cwdOutsideRepo all true:      ${iso.every((i: any) => i.cwdOutsideRepo)}`);
console.log(`  cwdEmptyBefore all true:      ${iso.every((i: any) => i.cwdEmptyBefore)}`);
console.log(`  childHasApiKey any true:      ${iso.some((i: any) => i.childHasApiKey)}`);
console.log(`  forbiddenEnvPresent any:      ${iso.some((i: any) => i.forbiddenEnvPresent.length > 0)}`);
console.log(`  toolsDisabled all true:       ${iso.every((i: any) => i.toolsDisabled)}`);
console.log(`  strictMcp all true:           ${iso.every((i: any) => i.strictMcp)}`);
console.log(`  noBare all true:              ${iso.every((i: any) => i.noBare)}`);
console.log(`  noFallbackModel all true:     ${iso.every((i: any) => i.noFallbackModel)}`);
console.log(`  cwdEmptyAfter all true:       ${ok.every((r) => r.cwdEmptyAfter)}`);
console.log(`  permissionDenials all empty:  ${ok.every((r) => Array.isArray(r.permissionDenials) && r.permissionDenials.length === 0)}`);
console.log(`  webSearchRequests total:      ${ok.reduce((a, r) => a + (r.reported.webSearchRequests as number), 0)} (zero observed != proof of foreclosure)`);

console.log("\n=== STOP REASONS / TURNS ===");
const sr = new Map<string, number>();
for (const r of ok) sr.set(`${r.stopReason}/turns=${r.numTurns}`, (sr.get(`${r.stopReason}/turns=${r.numTurns}`) ?? 0) + 1);
for (const [k, v] of sr) console.log(`  ${k}: ${v} runs`);

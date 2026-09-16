/**
 * `npm run r2:tokens -- <runId> [<runId> ...]` — what those Runs spent, from recorded events only.
 * Read-only, off the execution path. With several Runs it also prints the comparison R2 Stage 1
 * needs: the same objective before and after a change, side by side.
 */
import { pool } from "../db/client.js";
import { formatTokenReport, runTokenReport } from "./tokenReport.js";

async function main(): Promise<void> {
  const runIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (runIds.length === 0) {
    console.error("usage: npm run r2:tokens -- <runId> [<runId> ...]");
    process.exitCode = 1;
    return;
  }

  const reports = [];
  for (const runId of runIds) {
    const report = await runTokenReport(runId);
    reports.push(report);
    console.log(formatTokenReport(report));
    console.log("");
  }

  if (reports.length > 1) {
    const [first] = reports;
    console.log("Against the first Run:");
    for (const report of reports.slice(1)) {
      const delta = report.totals.counted - first!.totals.counted;
      const pct = first!.totals.counted > 0 ? Math.round((delta / first!.totals.counted) * 1000) / 10 : 0;
      console.log(`  ${report.runId}: ${delta >= 0 ? "+" : ""}${delta} (${pct >= 0 ? "+" : ""}${pct}%)`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

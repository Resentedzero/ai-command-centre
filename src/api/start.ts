/**
 * `npm run dev:api` — the real-run entrypoint (Ruling 5, task-10-brief.md).
 * `server.ts`'s `buildServer` only BUILDS the Fastify app; this is the one
 * place that actually binds a port and calls `.listen()`, so
 * `tests/api/*.test.ts` never need to bind a real network port to exercise
 * the app (`app.inject()`, or a test-local `.listen({port: 0})` for the SSE
 * suite — see that suite's own header).
 *
 * Exercising `POST /goals`'s real LLM step against this locally-running
 * server requires a real `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the
 * operator's own `.env` (see `server.ts`'s Ruling 4 note) — this script does
 * not configure or supply one.
 */
import "dotenv/config";
import { buildServer } from "./server.js";
import { createWorkflowRelay } from "./liveEventRelay.js";
import { db, pool } from "../db/client.js";
import { transactionRunner, type WorkflowRunnerFactory } from "../db/transactionRunner.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { acquireExecutorInstanceLock } from "../execution/executorInstanceLock.js";
import { recoverInterruptedInvocations, redriveInProgressWorkflowRuns } from "../workflow/recoverInterruptedInvocations.js";
import { findSeededPublishWorkflow } from "../definitions/lookupSeed.js";
import { expireStaleApprovals } from "../workflow/expireStaleApprovals.js";
import { buildInvocationSpecsForTaskDefinition } from "../workflow/buildInvocationSpecsForTaskDefinition.js";

/** How often past-TTL Approvals are expired. A minute is ample against a TTL measured in hours. */
const APPROVAL_SWEEP_INTERVAL_MS = 60_000;

async function main() {
  // Phase 9: exactly one executing process per database, then settle anything a
  // previous process left mid-dispatch — both BEFORE accepting requests. The
  // lock's connection is held for the life of the process.
  const instanceLock = await acquireExecutorInstanceLock(pool);
  // Losing this connection releases the lock, after which a second process
  // could start and settle this one's live dispatches as interrupted. There is
  // no safe way to continue without it: exit, and let supervision restart us
  // (which re-acquires the lock and runs recovery).
  instanceLock.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("Executor instance lock connection lost; exiting to preserve the single-executor invariant.", err);
    process.exit(1);
  });

  const runInTx = transactionRunner(db);
  const recovery = await recoverInterruptedInvocations(runInTx);
  if (recovery.recovered.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `Recovered ${recovery.recovered.length} interrupted Invocation(s) left executing by a previous process ` +
        `(outcome unknown; failed, reservations charged at estimate, never re-dispatched): ${recovery.recovered.join(", ")}`
    );
  }
  if (recovery.failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error("Could NOT settle these interrupted Invocation(s); they need operator attention:", recovery.failed);
  }

  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`AI Command Centre API listening on http://${host}:${port}`);

  // Background work on a Workflow Run relays each commit's events live, just
  // like request-driven work — so an expiry or a re-drive shows up in the
  // Activity feed as it happens, not only on the next SSE reconnect.
  const relayingRunnerFor: WorkflowRunnerFactory = async (workflowRunId) => {
    const relay = createWorkflowRelay(db);
    await relay.track(workflowRunId);
    return relay.runInTx;
  };

  // The builder needs the seed; the TTL sweep's EXPIRY does not. Without a seed
  // the sweep still expires stale Approvals (a governance control must not
  // depend on seeding) and reports the re-drive it could not do.
  const seed = await runInTx((tx) => findSeededPublishWorkflow(tx));
  const makeBuilder = (tx: DrizzleTransaction) => {
    if (!seed) throw new Error('No seeded Workflow Definition found — run "npm run seed" to enable re-driving.');
    return buildInvocationSpecsForTaskDefinition(tx, seed);
  };

  // Approval TTL sweep (spec 9.5): expire and re-drive past-TTL Approvals —
  // once now, then periodically. One sweep at a time; the timer never keeps
  // the process alive on its own.
  let sweeping = false;
  const sweepApprovals = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const report = await expireStaleApprovals(runInTx, makeBuilder, new Date(), relayingRunnerFor);
      if (report.expired.length > 0 || report.failed.length > 0) {
        // eslint-disable-next-line no-console
        console.log("Approval TTL sweep:", report);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Approval TTL sweep failed:", err);
    } finally {
      sweeping = false;
    }
  };

  // Continue Workflow Runs a previous process left mid-advance, in the
  // background so the API is available meanwhile. See the function's header.
  redriveInProgressWorkflowRuns(runInTx, makeBuilder, relayingRunnerFor)
    .then((report) => {
      if (report.redriven.length > 0 || report.failed.length > 0) {
        // eslint-disable-next-line no-console
        console.log("Startup re-drive of in-progress Workflow Runs:", report);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Startup re-drive of in-progress Workflow Runs failed:", err);
    })
    .finally(() => {
      void sweepApprovals();
      setInterval(() => void sweepApprovals(), APPROVAL_SWEEP_INTERVAL_MS).unref();
    });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

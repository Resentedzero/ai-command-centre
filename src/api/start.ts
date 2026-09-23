/**
 * `npm run dev:api` — the real-run entrypoint (Ruling 5, task-10-brief.md).
 * `server.ts`'s `buildServer` only BUILDS the Fastify app; this is the one
 * place that actually binds a port and calls `.listen()`, so
 * `tests/api/*.test.ts` never need to bind a real network port to exercise
 * the app (`app.inject()`, or a test-local `.listen({port: 0})` for the SSE
 * suite — see that suite's own header).
 *
 * Order matters: take the single-executor lock, settle Invocations a previous
 * process left `executing`, backfill lost stop audit events, listen, then start
 * the Approval TTL sweep and re-drive `in_progress` Workflow Runs side by side. The routed default provider is the Claude
 * subscription CLI, so a real LLM step consumes subscription quota and needs
 * no API key.
 */
import "dotenv/config";
import { buildServer } from "./server.js";
import { createWorkflowRelay } from "./liveEventRelay.js";
import { db, pool } from "../db/client.js";
import { transactionRunner, type WorkflowRunnerFactory } from "../db/transactionRunner.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { acquireExecutorInstanceLock } from "../execution/executorInstanceLock.js";
import { recoverInterruptedInvocations, redriveInProgressWorkflowRuns } from "../workflow/recoverInterruptedInvocations.js";
import { expireStaleApprovals } from "../workflow/expireStaleApprovals.js";
import { backfillStopEvents } from "../governance/executionStop.js";
import { buildInvocationSpecsFromDefinitions } from "../workflow/buildInvocationSpecsFromDefinitions.js";
import { refreshAgentPerformance } from "../projections/agentPerformance.js";
import { sweepMissionRecoveries } from "./routes/manager.js";
import { sweepMeetingsToConvene } from "./routes/meetings.js";
import { sweepOperationalNotices } from "./operationalNotices.js";
import { refreshAgentProgression } from "../projections/agentProgression.js";

/** How often past-TTL Approvals are expired. A minute is ample against a TTL measured in hours. */
const APPROVAL_SWEEP_INTERVAL_MS = 60_000;
/**
 * How often async projections are rebuilt. Routing reads agent_performance through
 * its sample criterion (N = 10) and accepts this lag (spec §8.3).
 */
const PROJECTION_REFRESH_INTERVAL_MS = 60_000;

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

  // A stop's audit event is written in a transaction after its state flip
  // (routes/executionStops.ts), so a crash between them lost the event for
  // good. Enforcement never depended on it; the log does.
  const backfilledStopEvents = await runInTx((tx) => backfillStopEvents(tx));
  if (backfilledStopEvents > 0) {
    // eslint-disable-next-line no-console
    console.warn(`Wrote ${backfilledStopEvents} emergency-stop audit event(s) a previous process committed the stop for but never recorded.`);
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

  // Steps are planned from persisted Definitions, so neither the sweep nor the
  // re-drive depends on a seed.
  const makeBuilder = (tx: DrizzleTransaction) => buildInvocationSpecsFromDefinitions(tx);

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

  // The sweep starts at once, not after the re-drive: a re-drive that dispatches
  // several model calls can take minutes, and expired holds must not wait for
  // it. Running both at once is safe — the workflow_runs row lock and the shared
  // in-flight set make the second driver of a Workflow Run a no-op.
  void sweepApprovals();
  setInterval(() => void sweepApprovals(), APPROVAL_SWEEP_INTERVAL_MS).unref();

  // A mission whose delegated work failed on a path that knows nothing about missions (an approval
  // decision's re-drive, a restart) gets its one governed recovery round here instead. Bounded by the
  // mission's own limits, so a sweep over an old failure starts nothing.
  let recovering = false;
  const sweepRecoveries = async () => {
    if (recovering) return;
    recovering = true;
    try {
      const started = await sweepMissionRecoveries(db);
      // eslint-disable-next-line no-console
      if (started.length > 0) console.log(`Started ${started.length} Manager recovery run(s): ${started.join(", ")}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Mission recovery sweep failed:", err);
    } finally {
      recovering = false;
    }
  };
  void sweepRecoveries();
  setInterval(() => void sweepRecoveries(), APPROVAL_SWEEP_INTERVAL_MS).unref();

  // A meeting whose time has come is HELD: a Goal and a round-table Workflow Run, or a recorded reason why
  // it could not be. Nothing else in the runtime makes a diary entry happen.
  let convening = false;
  const sweepMeetings = async () => {
    if (convening) return;
    convening = true;
    try {
      const held = await sweepMeetingsToConvene(db);
      // eslint-disable-next-line no-console
      if (held.length > 0) console.log(`Held ${held.length} meeting(s): ${held.join(", ")}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Meeting convening sweep failed:", err);
    } finally {
      convening = false;
    }
  };
  void sweepMeetings();
  setInterval(() => void sweepMeetings(), APPROVAL_SWEEP_INTERVAL_MS).unref();

  // Runtime facts worth telling someone about become notices (R2 Stage 11). Derived from events the
  // runtime already wrote and from the clock; it starts nothing and changes no authority.
  let noticing = false;
  const sweepNotices = async () => {
    if (noticing) return;
    noticing = true;
    try {
      const written = await sweepOperationalNotices(db);
      // eslint-disable-next-line no-console
      if (written > 0) console.log(`Wrote ${written} operational notice(s).`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Operational notice sweep failed:", err);
    } finally {
      noticing = false;
    }
  };
  void sweepNotices();
  setInterval(() => void sweepNotices(), APPROVAL_SWEEP_INTERVAL_MS).unref();

  // Asynchronous projections (spec §8.3, §8.10): an in-process loop, never on the
  // execution path. agent_performance is rebuilt from Events each pass.
  let projecting = false;
  const refreshProjections = async () => {
    if (projecting) return;
    projecting = true;
    try {
      await runInTx((tx) => refreshAgentPerformance(tx));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("agent_performance refresh failed; the previous rows remain:", err);
    }
    try {
      // R2 progression: its own transaction, so a failure here never holds back performance.
      await runInTx((tx) => refreshAgentProgression(tx));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("agent progression refresh failed; the previous rows remain:", err);
    } finally {
      projecting = false;
    }
  };
  void refreshProjections();
  setInterval(() => void refreshProjections(), PROJECTION_REFRESH_INTERVAL_MS).unref();

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
    });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

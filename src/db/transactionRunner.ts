/**
 * `TransactionRunner` — the injected TRANSACTION BOUNDARY for work that must
 * commit in several steps (Phase 9, durable execution).
 *
 * Why this exists: an external provider call (a `claude -p` child can run for
 * minutes) must never happen inside a database transaction. Holding one open
 * across it pins the run's event-sequence advisory lock, its budget counter row
 * locks (and, once a daily ceiling is configured, the DAY counter every Run
 * shares), and the shared quota-state row for the whole call. So the workflow
 * driver commits BEFORE dispatching and opens a fresh transaction to record the
 * result — which means it needs to open transactions, not receive one.
 *
 * Production passes `transactionRunner(db)`: every call is a real, committing
 * transaction. Tests pass a runner over their rolled-back test transaction
 * (a savepoint per call), so the SAME driver code runs in both — only where the
 * boundary is drawn differs. Behaviour that depends on real commits (locks
 * being released during dispatch) is tested separately against real commits.
 */
import type { DrizzleTransaction } from "../events/emit.js";

export type TransactionRunner = <T>(fn: (tx: DrizzleTransaction) => Promise<T>) => Promise<T>;

/** Anything that can open a transaction: the app database, or an open transaction (savepoint). */
type TransactionSource = { transaction: <T>(fn: (tx: DrizzleTransaction) => Promise<T>) => Promise<T> };

export function transactionRunner(source: TransactionSource): TransactionRunner {
  return (fn) => source.transaction(fn);
}

/**
 * Supplies the runner to use for work on ONE Workflow Run. Background drivers
 * (the startup re-drive, the approval TTL sweep) take this so production can
 * hand them a runner that relays each commit's events to live subscribers
 * (`createWorkflowRelay`), exactly as request-driven work does.
 */
export type WorkflowRunnerFactory = (workflowRunId: string) => Promise<TransactionRunner>;

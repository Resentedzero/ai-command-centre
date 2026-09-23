/**
 * Reads the document a governed Workflow Run produced (Keeper Think's `keeper_answer`, a Talk's
 * `deliverable`) from the run's own records: its status, its steps' invocations' artifacts, and
 * the stored content. Nothing is inferred: an unfinished run is still working, a failed one says
 * why the runtime recorded, and a finished run without a readable document says exactly that.
 */
import { getArtifact, getWorkflowRun } from "./api";
import { parseDeliverable, type Deliverable } from "./deliverable";

export type RunAnswer =
  | { phase: "working"; status: string }
  | { phase: "failed"; reason: string | null }
  | { phase: "answered"; artifactId: string; doc: Deliverable; content: string | null }
  | { phase: "unreadable" };

export async function readRunAnswer(workflowRunId: string, artifactType: string): Promise<RunAnswer> {
  const run = await getWorkflowRun(workflowRunId);
  const status = run.workflowRun.status;
  if (status !== "completed" && status !== "failed") return { phase: "working", status };
  if (status === "failed") {
    const attempt = run.steps.flatMap((s) => s.attempts ?? []).filter((a) => a.status === "failed").at(-1);
    return { phase: "failed", reason: attempt ? (attempt.outcomeReason ?? attempt.errorCode ?? attempt.failureReason) : null };
  }
  const ids = run.steps.flatMap((s) => s.run?.invocations.flatMap((i) => i.artifactIds) ?? []);
  for (const id of ids.reverse()) {
    const a = await getArtifact(id, true);
    if (a.artifact.type !== artifactType) continue;
    const doc = parseDeliverable(artifactType, a.artifact.content);
    if (!doc) break;
    return { phase: "answered", artifactId: id, doc, content: a.artifact.content ?? null };
  }
  return { phase: "unreadable" };
}

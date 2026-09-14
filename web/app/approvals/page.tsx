"use client";

import { useCallback, useEffect, useState } from "react";
import { approveApproval, listPendingApprovals, rejectApproval, type ApprovalData } from "../../lib/api";

/**
 * Approvals Queue page. Fetch-on-mount, not SSE-wired (Ruling 6 —
 * `listPendingApprovals()` has no reason to subscribe to the live activity
 * stream for this MVP). Refetches after a successful approve/reject so the
 * list reflects the resolved approval's removal from the pending set.
 *
 * Renders the exact snapshot fields `GET /approvals` returns
 * (`ApprovalData`, `web/lib/api.ts`) with no client-side policy logic of any
 * kind: buttons only call `approveApproval`/`rejectApproval` and refetch —
 * they never decide anything about whether an approval SHOULD be
 * approved/rejected.
 */
export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalData[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  // A refused decision (e.g. 409: already resolved, or expired past its TTL)
  // must be visible, not swallowed — and the list refetched, since it is stale.
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const data = await listPendingApprovals();
      setApprovals(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  async function resolve(id: string, action: (id: string) => Promise<void>): Promise<void> {
    setPendingActionId(id);
    setActionError(null);
    try {
      await action(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      await refetch();
      setPendingActionId(null);
    }
  }

  const handleApprove = (id: string) => resolve(id, approveApproval);
  const handleReject = (id: string) => resolve(id, rejectApproval);

  return (
    <main>
      <h1>Approvals</h1>
      {loadError && <p style={{ color: "#b00020" }}>Failed to load approvals: {loadError}</p>}
      {actionError && (
        <p role="alert" style={{ color: "#b00020" }}>
          Could not resolve approval: {actionError}
        </p>
      )}
      {!loadError && approvals.length === 0 && <p>No pending approvals.</p>}

      {approvals.map((approval) => (
        <div
          key={approval.id}
          data-testid="approval-row"
          style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, marginBottom: 8 }}
        >
          <div>
            <strong>Approval:</strong> {approval.id}
          </div>
          <div>Invocation: {approval.invocationId}</div>
          <div>Risk tier: {approval.riskTier}</div>
          <div>Status: {approval.status}</div>
          <div>Created at: {approval.createdAt}</div>
          <div>Resolved at: {approval.resolvedAt ?? "-"}</div>
          <div>Resolved by: {approval.resolvedBy ?? "-"}</div>
          <div>TTL: {approval.ttl ?? "-"}</div>
          <div>
            <strong>Proposed action:</strong>
            <pre style={{ whiteSpace: "pre-wrap", background: "#f5f5f5", padding: 8 }}>
              {JSON.stringify(approval.proposedActionSnapshot, null, 2)}
            </pre>
          </div>
          <div>
            <button
              type="button"
              onClick={() => handleApprove(approval.id)}
              disabled={pendingActionId === approval.id}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => handleReject(approval.id)}
              disabled={pendingActionId === approval.id}
              style={{ marginLeft: 8 }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}

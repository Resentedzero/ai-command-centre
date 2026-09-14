/**
 * Unit 11 (task-11-brief.md) "Tests required" bullet 4: Approvals page
 * renders exact snapshot fields; calls approveApproval/rejectApproval with
 * no client-side policy logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApprovalsPage from "../app/approvals/page";
import type { ApprovalData } from "../lib/api";

const { listPendingApprovals, approveApproval, rejectApproval } = vi.hoisted(() => ({
  listPendingApprovals: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  listPendingApprovals,
  approveApproval,
  rejectApproval,
}));

const approvalA: ApprovalData = {
  id: "appr-1",
  invocationId: "inv-1",
  proposedActionSnapshot: { action: "publish", destinationRelativePath: "reports/x.json" },
  riskTier: "high",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  ttl: "2026-01-02T00:00:00.000Z",
};

describe("Approvals page", () => {
  beforeEach(() => {
    listPendingApprovals.mockReset();
    approveApproval.mockReset();
    rejectApproval.mockReset();
  });

  it("renders the exact snapshot fields GET /approvals returns", async () => {
    listPendingApprovals.mockResolvedValueOnce([approvalA]);

    render(<ApprovalsPage />);

    const row = await screen.findByTestId("approval-row");
    expect(row).toHaveTextContent("appr-1");
    expect(row).toHaveTextContent("inv-1");
    expect(row).toHaveTextContent("high");
    expect(row).toHaveTextContent("pending");
    expect(row).toHaveTextContent(approvalA.createdAt);
    expect(row).toHaveTextContent(approvalA.ttl!);
    // The frozen proposedActionSnapshot -- rendered verbatim, not interpreted.
    expect(row).toHaveTextContent("publish");
    expect(row).toHaveTextContent("reports/x.json");
  });

  it("shows a message when there are no pending approvals", async () => {
    listPendingApprovals.mockResolvedValueOnce([]);
    render(<ApprovalsPage />);
    expect(await screen.findByText("No pending approvals.")).toBeInTheDocument();
  });

  it("Approve button calls approveApproval(id) and refetches -- no client-side policy logic, just call + reload", async () => {
    listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValueOnce([]);
    approveApproval.mockResolvedValueOnce(undefined);

    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");

    fireEvent.click(screen.getByRole("button", { name: /^Approve .*appr-1$/ }));

    await waitFor(() => expect(approveApproval).toHaveBeenCalledWith("appr-1"));
    await waitFor(() => expect(listPendingApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("approval-row")).not.toBeInTheDocument());
    expect(rejectApproval).not.toHaveBeenCalled();
  });

  it("Reject button calls rejectApproval(id) and refetches", async () => {
    listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValueOnce([]);
    rejectApproval.mockResolvedValueOnce(undefined);

    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");

    fireEvent.click(screen.getByRole("button", { name: /^Reject .*appr-1$/ }));

    await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith("appr-1"));
    await waitFor(() => expect(listPendingApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("approval-row")).not.toBeInTheDocument());
    expect(approveApproval).not.toHaveBeenCalled();
  });

  it("says the decision was recorded when advancing the workflow past it failed", async () => {
    listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValueOnce([]);
    approveApproval.mockResolvedValueOnce({
      approvalStatus: "approved",
      workflowStatus: null,
      advanceError: "The decision was recorded, but advancing the workflow run failed. Retry with POST /workflow-runs/wr-1/advance.",
    });

    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");
    fireEvent.click(screen.getByRole("button", { name: /^Approve .*appr-1$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/decision was recorded/);
    expect(screen.queryByText(/Could not resolve approval/)).not.toBeInTheDocument();
  });

  it("shows what the approval gates: goal, action, agent, and the content preview rendered as text", async () => {
    const withContext: ApprovalData = {
      ...approvalA,
      context: {
        capabilityName: "publish.report",
        permission: "PUBLISH",
        agent: { name: "Publisher", version: 1 },
        goal: { id: "goal-1", title: "Compare EV batteries" },
        workflowRunId: "wr-1",
        runId: "run-1",
        artifact: {
          id: "art-1",
          type: "report",
          size: 42,
          hash: "a".repeat(64),
          preview: '<b>not markup</b> {"report":"the draft"}',
          truncated: true,
          hashMatchesSnapshot: true,
        },
      },
    };
    listPendingApprovals.mockResolvedValueOnce([withContext]);

    render(<ApprovalsPage />);

    const context = await screen.findByTestId("approval-context");
    expect(context).toHaveTextContent("Compare EV batteries");
    expect(context).toHaveTextContent("publish.report (PUBLISH)");
    expect(context).toHaveTextContent("Publisher v1");
    expect(context).toHaveTextContent("(preview truncated)");
    // Model output is shown literally, never interpreted as HTML.
    const preview = screen.getByTestId("approval-preview");
    expect(preview).toHaveTextContent('<b>not markup</b> {"report":"the draft"}');
    expect(preview.querySelector("b")).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when the content no longer matches what was proposed", async () => {
    listPendingApprovals.mockResolvedValueOnce([
      {
        ...approvalA,
        context: {
          capabilityName: "publish.report",
          permission: "PUBLISH",
          agent: null,
          goal: null,
          workflowRunId: null,
          runId: null,
          artifact: { id: "art-1", type: "report", size: 5, hash: "b".repeat(64), preview: "later", truncated: false, hashMatchesSnapshot: false },
        },
      },
    ]);

    render(<ApprovalsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer matches/);
  });
});

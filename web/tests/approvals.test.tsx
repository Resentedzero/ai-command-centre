/**
 * Approvals (spec 15.1 screen 4): renders the exact snapshot and context
 * GET /approvals returns; approve/reject call the API with no client-side
 * policy logic and re-read; the hash check and a recorded-but-not-advanced
 * decision are shown, not swallowed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ApprovalsPage from "../app/approvals/page";
import type { ApprovalData } from "../lib/api";
import { formatTime } from "../lib/keep";

const api = vi.hoisted(() => ({ listPendingApprovals: vi.fn(), approveApproval: vi.fn(), rejectApproval: vi.fn() }));
vi.mock("../lib/api", () => api);

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
    policyDecision: {
      checkpoint: "propose",
      decision: "REQUIRE_APPROVAL",
      basis: "autonomy_always_approve",
      autonomyState: "ALWAYS_APPROVE",
      riskTier: "high",
      grantId: "grant-1",
      capabilityId: "cap-1",
      permission: "PUBLISH",
      toolBindingId: "tb-1",
      trustLevel: "first_party",
      maxTrustLevelRequired: 1,
      bindingTrustLevel: 2,
      performanceEvidence: null,
    },
  },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("Approvals page", () => {
  it("renders the exact fields and frozen snapshot GET /approvals returns", async () => {
    api.listPendingApprovals.mockResolvedValue([approvalA]);
    render(<ApprovalsPage />);

    const row = await screen.findByTestId("approval-row");
    expect(row).toHaveTextContent("pending");
    expect(row).toHaveTextContent("risk high");
    const request = screen.getByTestId("approval-context");
    expect(request).toHaveTextContent("appr-1");
    expect(request).toHaveTextContent("inv-1");
    expect(request).toHaveTextContent(formatTime(approvalA.createdAt));
    expect(request).toHaveTextContent(formatTime(approvalA.ttl));
    expect(screen.getByText(/"destinationRelativePath": "reports\/x.json"/)).toBeInTheDocument();
  });

  it("says nothing is waiting when the queue is empty", async () => {
    api.listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    expect(await screen.findByText("Nothing is waiting for approval.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No approvals are pending" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Reject/ })).not.toBeInTheDocument();
  });

  it("shows a load failure with Retry", async () => {
    api.listPendingApprovals.mockRejectedValue(new Error("API request failed: GET /approvals -> 500 Internal Server Error"));
    render(<ApprovalsPage />);
    expect(await screen.findByText("Couldn't load approvals.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("Approve calls approveApproval(id) and re-reads -- no client-side policy logic", async () => {
    api.listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValue([]);
    api.approveApproval.mockResolvedValueOnce(undefined);
    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");

    fireEvent.click(screen.getByRole("button", { name: /^Approve .*appr-1$/ }));

    await waitFor(() => expect(api.approveApproval).toHaveBeenCalledWith("appr-1"));
    await waitFor(() => expect(api.listPendingApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("approval-row")).not.toBeInTheDocument());
    expect(api.rejectApproval).not.toHaveBeenCalled();
  });

  it("Reject calls rejectApproval(id) and re-reads", async () => {
    api.listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValue([]);
    api.rejectApproval.mockResolvedValueOnce(undefined);
    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");

    fireEvent.click(screen.getByRole("button", { name: /^Reject .*appr-1$/ }));

    await waitFor(() => expect(api.rejectApproval).toHaveBeenCalledWith("appr-1"));
    await waitFor(() => expect(screen.queryByTestId("approval-row")).not.toBeInTheDocument());
    expect(api.approveApproval).not.toHaveBeenCalled();
  });

  it("a refused decision is shown, not swallowed", async () => {
    api.listPendingApprovals.mockResolvedValue([approvalA]);
    api.approveApproval.mockRejectedValueOnce(new Error('API request failed: POST /approvals/appr-1/approve -> 409 Conflict: Approval "appr-1" is already resolved'));
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Approve .*appr-1$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/409 Conflict/);
  });

  it("says the decision was recorded when advancing the workflow past it failed", async () => {
    api.listPendingApprovals.mockResolvedValueOnce([approvalA]).mockResolvedValue([]);
    api.approveApproval.mockResolvedValueOnce({
      approvalStatus: "approved",
      workflowStatus: null,
      advanceError: "The decision was recorded, but advancing the workflow run failed. Retry with POST /workflow-runs/wr-1/advance.",
    });
    render(<ApprovalsPage />);
    await screen.findByTestId("approval-row");
    fireEvent.click(screen.getByRole("button", { name: /^Approve .*appr-1$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/decision was recorded/);
    expect(screen.queryByText(/Couldn't resolve the approval/)).not.toBeInTheDocument();
  });

  it("shows what the approval gates: goal, action, agent, the hash check, and the preview as text with a link to the full content", async () => {
    api.listPendingApprovals.mockResolvedValue([withContext]);
    render(<ApprovalsPage />);

    const request = await screen.findByTestId("approval-context");
    expect(within(request).getByRole("link", { name: "Compare EV batteries" })).toHaveAttribute("href", "/workflows/wr-1");
    expect(request).toHaveTextContent("publish.report · PUBLISH");
    // Why approval is required, as Policy recorded it.
    expect(request).toHaveTextContent("approval required · always approve");
    expect(request).toHaveTextContent("Publisher v1");
    expect(screen.getByText("content matches the proposal")).toBeInTheDocument();
    const preview = screen.getByTestId("approval-preview");
    expect(preview).toHaveTextContent('<b>not markup</b> {"report":"the draft"}');
    expect(preview.querySelector("b")).toBeNull();
    expect(screen.getByText(/preview truncated/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read the full content" })).toHaveAttribute("href", "/artifacts/art-1?full=1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when the content no longer matches what was proposed, and marks the preview untrusted", async () => {
    api.listPendingApprovals.mockResolvedValue([
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
    expect(screen.getByText(/Untrusted preview/)).toBeInTheDocument();
    // The warning is repeated at the decision point, and Approve is not drawn as armed.
    expect(screen.getByText(/Content changed since it was proposed: approving will fail/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve / }).className).not.toMatch(/approve/);
  });

  it("selects another request from the queue", async () => {
    api.listPendingApprovals.mockResolvedValue([approvalA, { ...withContext, id: "appr-2" }]);
    render(<ApprovalsPage />);
    const rows = await screen.findAllByTestId("approval-row");
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(rows[1]!);
    expect(rows[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Approve .*appr-2$/ })).toBeInTheDocument();
  });
});

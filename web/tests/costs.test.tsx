/** Cost ledger (spec 15.1 screen 7): GET /costs values per scope and unit, never combined; performance as a measurement. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CostsData } from "../lib/api";

const api = vi.hoisted(() => ({ getCosts: vi.fn(), BUDGET_SCOPES: ["run", "task_instance", "agent_definition", "goal", "day"] }));
vi.mock("../lib/api", () => api);

import CostsPage from "../app/costs/page";

const data: CostsData = {
  counters: [
    {
      scope: "run",
      scopeRefId: "run-1",
      resourceUnit: "subscription_tokens",
      limitAmount: "200000",
      reservedAmount: "0",
      consumedAmount: "18204",
      updatedAt: "t",
      run: { agent: { name: "Researcher", version: 1 }, taskDefinitionName: "Research-Report" },
    },
    { scope: "day", scopeRefId: "2026-09-15", resourceUnit: "usd", limitAmount: "5.00", reservedAmount: "0.05", consumedAmount: "0.0412", updatedAt: "t", run: null },
  ],
  countersTruncated: true,
  totals: [
    { scope: "day", resourceUnit: "usd", consumed: "0.0412", reserved: "0.05", counters: 1 },
    { scope: "run", resourceUnit: "subscription_tokens", consumed: "18204", reserved: "0", counters: 1 },
  ],
  costVsSuccess: [
    {
      agentDefinitionId: "a-1",
      agentName: "Researcher",
      agentVersion: 1,
      taskDefinitionId: "td-1",
      taskDefinitionName: "Research-Report",
      modelTier: "standard",
      sampleCount: 4,
      successRate: "0.75",
      avgRetries: "0.25",
      avgCost: { subscription_tokens: "9100" },
      updatedAt: "t",
    },
  ],
};

beforeEach(() => {
  api.getCosts.mockReset();
});

describe("Cost ledger", () => {
  it("shows totals per scope and unit, counters with their own unit, and performance as a measurement", async () => {
    api.getCosts.mockResolvedValue(data);
    render(<CostsPage />);

    const totals = await screen.findAllByTestId("total");
    expect(totals.map((t) => t.textContent)).toEqual([
      expect.stringContaining("day · usd0.0412 consumed · 0.05 reserved"),
      expect.stringContaining("run · subscription_tokens18204 consumed · 0 reserved"),
    ]);
    const counters = screen.getAllByTestId("counter");
    expect(counters[0]).toHaveTextContent("Researcher v1 · Research-Report");
    expect(counters[0]).toHaveTextContent("18204 consumed · 0 reserved · limit 200000");
    expect(counters[1]).toHaveTextContent("2026-09-15");
    expect(screen.getByText(/Showing the 2 most recently updated counters/)).toBeInTheDocument();
    expect(screen.getByTestId("cost-vs-success")).toHaveTextContent("9100 subscription_tokens");
    expect(screen.getByText("A measurement, not a recommendation.")).toBeInTheDocument();
    expect(api.getCosts).toHaveBeenCalledWith(undefined);
  });

  it("filters by scope through the API", async () => {
    api.getCosts.mockResolvedValue({ ...data, counters: [], totals: [], costVsSuccess: [], countersTruncated: false });
    render(<CostsPage />);
    await screen.findByText("No budget counters yet.");    fireEvent.click(screen.getByRole("button", { name: "day" }));
    await waitFor(() => expect(api.getCosts).toHaveBeenCalledWith("day"));
    expect(screen.getByRole("button", { name: "day" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("No counters in this scope.")).toBeInTheDocument();
    expect(screen.getByText("No performance measured yet.")).toBeInTheDocument();
  });

  it("shows a load failure with Retry", async () => {
    api.getCosts.mockRejectedValue(new Error("API request failed: GET /costs -> 500 Internal Server Error"));
    render(<CostsPage />);
    expect(await screen.findByText("Couldn't load the cost ledger.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

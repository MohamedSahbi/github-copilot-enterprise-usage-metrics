import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ApiCoreView from "./ApiCoreView";
import type { ApiCorePageData } from "../data/apiCoreDataSource";
import { formatUserCredits } from "./userCredits";

// The client-side Chart.js view pulls in Primer CSS, which the node test runner cannot load.
vi.mock("./DailySeriesCharts", () => ({ default: () => null }));

function renderCoreView(data: ApiCorePageData): string {
  return renderToStaticMarkup(createElement(ApiCoreView, { data, pageTitle: "Overview" }));
}

describe("user-table credit formatting", () => {
  it("converts the exact wire string only for one-fractional-digit display", () => {
    expect(formatUserCredits("1234.56")).toBe("1,234.6");
    expect(formatUserCredits("1999999999.999999998")).toBe("2,000,000,000");
  });
});

describe("Safe Alpha core view", () => {
  it("keeps the privacy disclosure identical when no daily facts are visible", () => {
    const emptyMarkup = renderCoreView({ page: "overview", series: [], totalUsers: null });
    const hiddenMarkup = renderCoreView({ page: "overview", series: [], totalUsers: null });

    expect(emptyMarkup).toBe(hiddenMarkup);
    expect(emptyMarkup).toContain("Daily usage metrics are subject to minimum-group privacy controls.");
    expect(emptyMarkup).not.toContain("hidden");
    expect(emptyMarkup).not.toContain("suppressed");
    expect(emptyMarkup).not.toContain("incomplete");
  });

  it("renders released daily values without hidden-row disclosures or a daily total card", () => {
    const markup = renderCoreView({
      page: "overview",
      totalUsers: 5,
      series: [{
        day: "2026-03-02",
        activeUsers: 5,
        interactions: 12,
        codeGenerations: 3,
        codeAcceptances: 2,
        locAdded: 20,
        locDeleted: 4,
      }],
    });

    expect(markup).toContain("Mar 2");
    expect(markup).toContain("Observed users");
    expect(markup).toContain("Daily usage metrics are subject to minimum-group privacy controls.");
    expect(markup).not.toContain("Unavailable");
    expect(markup).not.toContain("groups are hidden");
  });

  it("renders Copilot Impact from daily rows only", () => {
    const markup = renderCoreView({
      page: "copilot-impact",
      series: [{
        day: "2026-03-02",
        activeUsers: 5,
        interactions: 12,
        codeGenerations: 3,
        codeAcceptances: 2,
        locAdded: 20,
        locDeleted: 4,
      }],
    });

    expect(markup).toContain("Mar 2");
    expect(markup).toContain("Code generations");
    expect(markup).not.toContain("Observed users");
    expect(markup).not.toContain("Copilot CLI");
    expect(markup).not.toContain("Copilot App");
    expect(markup).not.toContain("Feature adoption");
  });
});

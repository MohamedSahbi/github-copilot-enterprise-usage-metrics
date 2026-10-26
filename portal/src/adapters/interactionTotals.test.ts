import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdoptionSummary, Suppressible, UsageSeriesPoint } from "../../../shared/src/api";
import OverviewSummary from "./OverviewSummary";

function visible(day: string, interactions: number): Suppressible<UsageSeriesPoint> {
  return {
    suppressed: false,
    userCount: 5,
    value: {
      day,
      activeUsers: 5,
      interactions,
      codeGenerations: 0,
      codeAcceptances: 0,
      locAdded: 0,
      locDeleted: 0,
    },
  };
}

const suppressed: Suppressible<UsageSeriesPoint> = {
  suppressed: true,
  userCount: null,
  value: null,
};

const visibleAdoption: Suppressible<AdoptionSummary> = {
  suppressed: false,
  userCount: 5,
  value: {
    totalUsers: 5,
    completionUsers: 0,
    completionOnlyUsers: 0,
    chatUsers: 0,
    agentModeUsers: 0,
    askModeUsers: 0,
    inlineModeUsers: 0,
    planModeUsers: 0,
    cliUsers: 0,
    appUsers: 0,
    vscodeAgentUsers: 0,
    codingAgentUsers: 0,
    codeReviewUsers: 0,
    advancedUsers: 0,
  },
};

describe("OverviewSummary", () => {
  it("returns unavailable when all daily rows are suppressed", () => {
    const markup = renderToStaticMarkup(createElement(OverviewSummary, {
      adoption: visibleAdoption,
      series: [suppressed, suppressed],
    }));
    expect(markup).toContain("Unavailable (daily totals are incomplete or suppressed)");
  });

  it("returns unavailable when any daily row is suppressed", () => {
    const markup = renderToStaticMarkup(createElement(OverviewSummary, {
      adoption: visibleAdoption,
      series: [visible("2026-03-02", 12), suppressed],
    }));
    expect(markup).toContain("Unavailable (daily totals are incomplete or suppressed)");
  });

  it("sums complete unsuppressed rows, preserving a genuine zero total", () => {
    const markup = renderToStaticMarkup(createElement(OverviewSummary, {
      adoption: visibleAdoption,
      series: [
        visible("2026-03-02", 12),
        visible("2026-03-03", 0),
      ],
    }));
    const zeroMarkup = renderToStaticMarkup(createElement(OverviewSummary, {
      adoption: visibleAdoption,
      series: [visible("2026-03-04", 0)],
    }));
    expect(markup).toContain(">12</dd>");
    expect(zeroMarkup).toContain(">0</dd>");
  });

  it("keeps interactions unavailable while hiding suppressed observed users", () => {
    const suppressedAdoption: Suppressible<AdoptionSummary> = {
      suppressed: true,
      userCount: null,
      value: null,
    };
    const markup = renderToStaticMarkup(createElement(OverviewSummary, {
      adoption: suppressedAdoption,
      series: [suppressed],
    }));
    expect(markup).toContain("Interactions");
    expect(markup).toContain("Unavailable (daily totals are incomplete or suppressed)");
    expect(markup).not.toContain("Observed users");
  });
});

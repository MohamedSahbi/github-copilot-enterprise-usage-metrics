import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import OverviewSummary from "./OverviewSummary";

describe("OverviewSummary", () => {
  it("shows only the independently safe parent user total", () => {
    const markup = renderToStaticMarkup(createElement(OverviewSummary, { totalUsers: 5 }));

    expect(markup).toContain("Observed users");
    expect(markup).toContain(">5</dd>");
    expect(markup).not.toContain("<dt>Interactions</dt>");
  });

  it("omits the parent total when its adoption wrapper is hidden", () => {
    const markup = renderToStaticMarkup(createElement(OverviewSummary, { totalUsers: null }));

    expect(markup).not.toContain("Observed users");
    expect(markup).not.toContain("Interactions");
    expect(markup).not.toContain("suppressed");
    expect(markup).not.toContain("hidden");
  });
});

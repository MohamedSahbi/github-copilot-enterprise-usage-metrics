import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Suppressible, UsageSeriesPoint } from "../../../shared/src/api";
import InteractionTotal from "./InteractionTotal";

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

describe("InteractionTotal", () => {
  it("returns unavailable when all daily rows are suppressed", () => {
    const markup = renderToStaticMarkup(createElement(InteractionTotal, { series: [suppressed, suppressed] }));
    expect(markup).toContain("Unavailable (daily totals are incomplete or suppressed)");
  });

  it("returns unavailable when any daily row is suppressed", () => {
    const markup = renderToStaticMarkup(createElement(InteractionTotal, {
      series: [visible("2026-03-02", 12), suppressed],
    }));
    expect(markup).toContain("Unavailable (daily totals are incomplete or suppressed)");
  });

  it("sums complete unsuppressed rows, preserving a genuine zero total", () => {
    const markup = renderToStaticMarkup(createElement(InteractionTotal, {
      series: [
        visible("2026-03-02", 12),
        visible("2026-03-03", 0),
      ],
    }));
    const zeroMarkup = renderToStaticMarkup(createElement(InteractionTotal, {
      series: [visible("2026-03-04", 0)],
    }));
    expect(markup).toBe("12");
    expect(zeroMarkup).toBe("0");
  });
});

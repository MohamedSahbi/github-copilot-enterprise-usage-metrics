import { describe, expect, it } from "vitest";
import { isEligibleAuthor, MAX_ISSUES_PER_PR, normalizeTitle, parseBugReports } from "./parse";

const withSection = (section: string) => `## Summary\n\nStuff\n\n## Out-of-scope bugs found\n\n${section}\n\n## Observations\n\n- Not a bug | high | x | y\n`;

describe("parseBugReports", () => {
  it("parses items and stops at the next heading", () => {
    const body = withSection("- Chart flickers | severity:medium | portal/src/a.tsx | open page, wait 2s");
    expect(parseBugReports(body)).toEqual([
      { title: "Chart flickers", severity: "medium", where: "portal/src/a.tsx", steps: "open page, wait 2s" },
    ]);
  });

  it("ignores the template comment, empty section, and missing section", () => {
    expect(parseBugReports(withSection("<!-- Title | high | here | steps -->"))).toEqual([]);
    expect(parseBugReports(withSection("None"))).toEqual([]);
    expect(parseBugReports("## Summary\nOnly this")).toEqual([]);
  });

  it("skips items with an unknown severity or missing fields", () => {
    const body = withSection("- A | urgent | f | s\n- B | high | f\n- C | low | f | s");
    expect(parseBugReports(body).map((r) => r.title)).toEqual(["C"]);
  });

  it("caps the number of items per PR", () => {
    const items = Array.from({ length: 9 }, (_, i) => `- Bug ${i} | low | f | s`).join("\n");
    expect(parseBugReports(withSection(items))).toHaveLength(MAX_ISSUES_PER_PR);
  });

  it("keeps pipes inside the steps field", () => {
    const [report] = parseBugReports(withSection("- T | high | f | a | b"));
    expect(report?.steps).toBe("a | b");
  });
});

describe("helpers", () => {
  it("normalizes titles for duplicate detection", () => {
    expect(normalizeTitle("  Chart   Flickers ")).toBe(normalizeTitle("chart flickers"));
  });

  it("accepts only the owner and Copilot as authors", () => {
    expect(isEligibleAuthor("MohamedSahbi", "mohamedsahbi")).toBe(true);
    expect(isEligibleAuthor("Copilot", "mohamedsahbi")).toBe(true);
    expect(isEligibleAuthor("someone-else", "mohamedsahbi")).toBe(false);
    expect(isEligibleAuthor("copilot-impostor", "mohamedsahbi")).toBe(false);
  });
});

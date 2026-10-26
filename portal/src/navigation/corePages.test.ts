import { describe, expect, it } from "vitest";
import { CORE_PAGES, getCorePage, visibleCorePages } from "./corePages";
import type { PortalViewer } from "../access/portalAccess";

function viewer(role: PortalViewer["role"], perUserDetailEnabled = false): PortalViewer {
  return {
    accessState: "authorized",
    displayName: "Portal user",
    role,
    authenticated: true,
    perUserDetailEnabled,
    scopeOptions: [],
    allowedUserIds: [],
  };
}

describe("Safe Alpha core pages", () => {
  it("allows only Overview and Copilot Impact for every authorized role", () => {
    expect(CORE_PAGES.map(({ slug }) => slug)).toEqual(["overview", "copilot-impact"]);
    for (const role of ["admin", "executive", "manager", "member"] as const) {
      expect(visibleCorePages(viewer(role)).map(({ slug }) => slug)).toEqual([
        "overview",
        "copilot-impact",
      ]);
    }
  });

  it.each([
    "executive-summary",
    "copilot-adoption",
    "languages",
    "model-usage",
    "cli-adoption",
    "clients",
    "client-versions",
    "ai-adoption-phases",
    "users",
  ])("does not resolve excluded URL alias %s", (slug) => {
    expect(getCorePage(slug)).toBeUndefined();
  });
});

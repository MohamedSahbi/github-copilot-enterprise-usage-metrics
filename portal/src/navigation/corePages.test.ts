import { describe, expect, it } from "vitest";
import { getCorePage, upstreamViewsEnabled, visibleCorePages } from "./corePages";
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
    for (const role of ["admin", "executive", "manager", "member"] as const) {
      expect(visibleCorePages(viewer(role), {}).map(({ slug }) => slug)).toEqual([
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
    expect(getCorePage(slug, {})).toBeUndefined();
    expect(getCorePage(slug, { MODULE_UPSTREAM_VIEWS: "false" })).toBeUndefined();
  });
});

describe("upstream views module", () => {
  const on = { MODULE_UPSTREAM_VIEWS: "true" };

  it("adds every upstream view in upstream order", () => {
    expect(visibleCorePages(viewer("member", true), on).map(({ slug }) => slug)).toEqual([
      "overview",
      "executive-summary",
      "users",
      "languages",
      "clients",
      "client-versions",
      "copilot-impact",
      "copilot-adoption",
      "model-usage",
      "cli-adoption",
      "ai-adoption-phases",
    ]);
  });

  it("keeps Users behind per-user detail", () => {
    expect(visibleCorePages(viewer("admin"), on).map(({ slug }) => slug)).not.toContain("users");
  });

  it("resolves upstream slugs only when on", () => {
    expect(getCorePage("languages", on)?.title).toBe("Languages");
    expect(getCorePage("executivesummary", on)).toBeUndefined();
  });

  it("rejects values other than true or false", () => {
    expect(() => upstreamViewsEnabled({ MODULE_UPSTREAM_VIEWS: "yes" })).toThrow("MODULE_UPSTREAM_VIEWS");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessResult } from "../authz/access";
import type { UsageOverviewResponse } from "../../../shared/src/api";
import {
  API_CORE_PAGE_SLUGS,
  getApiCoreData,
  projectCorePageData,
} from "./apiCoreDataSource";

const { getPortalSqlPool, getUsageOverview, resolveUsageRange } = vi.hoisted(() => ({
  getPortalSqlPool: vi.fn(),
  getUsageOverview: vi.fn(),
  resolveUsageRange: vi.fn(),
}));

vi.mock("../db/pool", () => ({ getPortalSqlPool }));
vi.mock("../usage/sql-usage", () => ({ getUsageOverview, resolveUsageRange }));

const access: Extract<AccessResult, { state: "authorized" }> = {
  state: "authorized",
  breakGlass: false,
  principal: {
    principal_id: "00000000-0000-4000-8000-000000000001",
    entra_tenant_id: "00000000-0000-4000-8000-000000000002",
    entra_object_id: "00000000-0000-4000-8000-000000000003",
    github_user_id: null,
    status: "active",
  },
  grants: [
    { role: "admin", scope: "company", scope_value: "" },
    { role: "executive", scope: "department", scope_value: "department-a" },
  ],
  namesVisible: false,
};

const overview: UsageOverviewResponse["data"] = {
  series: [
    {
      suppressed: false,
      userCount: 6,
      value: {
        day: "2026-03-02",
        activeUsers: 6,
        interactions: 12,
        codeGenerations: 3,
        codeAcceptances: 2,
        locAdded: 20,
        locDeleted: 4,
      },
    },
    { suppressed: true, userCount: null, value: null },
  ],
  adoption: {
    suppressed: false,
    userCount: 6,
    value: {
      totalUsers: 6,
      completionUsers: 6,
      completionOnlyUsers: 2,
      chatUsers: 4,
      agentModeUsers: 3,
      askModeUsers: 2,
      inlineModeUsers: 1,
      planModeUsers: 1,
      cliUsers: 2,
      appUsers: 3,
      vscodeAgentUsers: 2,
      codingAgentUsers: 1,
      codeReviewUsers: 1,
      advancedUsers: 4,
    },
  },
};

const request = { period: "last_7_days" } as const;
const selection = { kind: "all", value: "all", label: "All available data", userIds: [1000003] } as const;

describe("Safe Alpha API core data source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPortalSqlPool.mockResolvedValue({});
    resolveUsageRange.mockResolvedValue({ ok: true, range: { from: "2026-02-28", to: "2026-03-06" } });
    getUsageOverview.mockResolvedValue(overview);
  });

  it("uses the same two-page allowlist as core navigation", () => {
    expect(API_CORE_PAGE_SLUGS).toEqual(["overview", "copilot-impact"]);
  });

  it("rejects every excluded page before opening the SQL pool", async () => {
    for (const page of [
      "executive-summary",
      "copilot-adoption",
      "languages",
      "model-usage",
      "cli-adoption",
      "clients",
      "client-versions",
      "ai-adoption-phases",
      "users",
    ]) {
      await expect(getApiCoreData({ page, access, selection, request })).resolves.toBeNull();
    }
    expect(getPortalSqlPool).not.toHaveBeenCalled();
    expect(resolveUsageRange).not.toHaveBeenCalled();
    expect(getUsageOverview).not.toHaveBeenCalled();
  });

  it("projects overview data to permitted daily values and the unsuppressed parent total only", async () => {
    const result = await getApiCoreData({ page: "overview", access, selection, request });

    expect(result).toEqual({
      page: "overview",
      series: [overview.series[0]?.value],
      totalUsers: 6,
    });
    expect(getUsageOverview.mock.calls[0]?.[1]).toMatchObject({
      grants: [{ role: "admin", scope: "company", scope_value: "" }],
    });
  });

  it("does not project adoption child counts for a five-user parent", () => {
    const adoptionValue = overview.adoption.value;
    if (!adoptionValue) throw new Error("Expected the fixture adoption parent to be visible");
    const parentWithSmallChildren: UsageOverviewResponse["data"] = {
      ...overview,
      adoption: {
        ...overview.adoption,
        value: {
          ...adoptionValue,
          totalUsers: 5,
          cliUsers: 1,
          appUsers: 2,
          vscodeAgentUsers: 3,
          codingAgentUsers: 4,
        },
      },
    };

    expect(projectCorePageData("overview", parentWithSmallChildren)).toEqual({
      page: "overview",
      series: [overview.series[0]?.value],
      totalUsers: 5,
    });
  });

  it("omits the parent count from Copilot Impact", () => {
    const result = projectCorePageData("copilot-impact", overview);
    expect(result).toEqual({ page: "copilot-impact", series: [overview.series[0]?.value] });
    expect(result).not.toHaveProperty("totalUsers");
  });

  it("makes all-hidden and no-facts overview projections identical", () => {
    const hidden = projectCorePageData("overview", {
      series: [{ suppressed: true, userCount: null, value: null }],
      adoption: { suppressed: true, userCount: null, value: null },
    });
    const noFacts = projectCorePageData("overview", {
      series: [],
      adoption: { suppressed: false, userCount: 0, value: null },
    });

    expect(hidden).toEqual(noFacts);
    expect(hidden).toEqual({ page: "overview", series: [], totalUsers: null });
  });

  it("rejects a forged scope without broadening to another held grant", async () => {
    const result = await getApiCoreData({
      page: "overview",
      access: { ...access, grants: [access.grants[0]!] },
      selection: { kind: "department", value: "department-a", label: "department a", userIds: [1000003] },
      request,
    });

    expect(result).toBeNull();
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });
});

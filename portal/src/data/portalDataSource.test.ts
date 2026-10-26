import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessResult } from "../authz/access";
import {
  getApiCoreData,
  getPortalDataSource,
  syntheticPortalDataSource,
} from "./portalDataSource";

const request = { period: "last_7_days" } as const;

const { getPortalSqlPool, getUsageOverview, getUsageBreakdown, getUserUsage, resolveUsageRange } = vi.hoisted(() => ({
  getPortalSqlPool: vi.fn(),
  getUsageOverview: vi.fn(),
  getUsageBreakdown: vi.fn(),
  getUserUsage: vi.fn(),
  resolveUsageRange: vi.fn(),
}));

vi.mock("../db/pool", () => ({ getPortalSqlPool }));
vi.mock("../usage/sql-usage", () => ({
  getUsageOverview,
  getUsageBreakdown,
  getUserUsage,
  resolveUsageRange,
}));

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

const overview = {
  series: [],
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

describe("synthetic portal data source", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_TEST_AUTH", "1");
    vi.clearAllMocks();
    getPortalSqlPool.mockResolvedValue({});
    resolveUsageRange.mockResolvedValue({ ok: true, range: { from: "2026-02-28", to: "2026-03-06" } });
    getUsageOverview.mockResolvedValue(overview);
    getUsageBreakdown.mockResolvedValue({ rows: [], totalItems: 0 });
    getUserUsage.mockResolvedValue({ rows: [], totalItems: 0 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not configure synthetic fixtures when test sign-in is disabled", () => {
    vi.stubEnv("E2E_TEST_AUTH", "0");
    expect(getPortalDataSource()).toBeNull();
  });

  it("filters fixture rows to server-resolved scope user IDs", async () => {
    const result = await syntheticPortalDataSource.getCoreData({
      request,
      scope: "team",
      allowedUserIds: [1000003, 1000007],
      perUserDetailEnabled: false,
    });

    expect(result.visibleUserCount).toBe(2);
    expect(result.aggregatedMetrics.overview.stats.uniqueUsers).toBe(0);
    expect(result.suppressed).toBe(true);
    expect(result.aggregatedMetrics.users.userSummaries).toEqual([]);
  });

  it("limits member data to self and suppresses the below-threshold aggregate", async () => {
    const result = await syntheticPortalDataSource.getCoreData({
      request,
      scope: "self",
      allowedUserIds: [1000006],
      perUserDetailEnabled: false,
    });

    expect(result.visibleUserCount).toBe(1);
    expect(result.suppressed).toBe(true);
    expect(result.aggregatedMetrics.overview.stats.uniqueUsers).toBe(0);
    expect(result.overview.data.adoption.suppressed).toBe(true);
    expect(result.users).toBeNull();
  });
  it("returns user details only when enabled for an allowed fixture user", async () => {
    const query = {
      request,
      scope: "team" as const,
      allowedUserIds: [1000003, 1000007],
      perUserDetailEnabled: true,
    };

    await expect(
      syntheticPortalDataSource.getUserDetails(query, { id: 1000003, login: "example-user-003" }),
    ).resolves.not.toBeNull();
    await expect(
      syntheticPortalDataSource.getUserDetails(query, { id: 1000012, login: "example-user-012" }),
    ).resolves.toBeNull();
    await expect(
      syntheticPortalDataSource.getUserDetails({ ...query, perUserDetailEnabled: false }, {
        id: 1000003,
        login: "example-user-003",
      }),
    ).resolves.toBeNull();
  });

  it("uses only the matching authorized grant for API-backed scope data", async () => {
    const result = await getApiCoreData({
      page: "languages",
      access,
      selection: {
        kind: "department",
        value: "department-a",
        label: "department a",
        userIds: [1000003],
      },
      request,
    });

    expect(result).toMatchObject({ page: "languages", breakdownKind: "language" });
    expect(getUsageOverview.mock.calls[0]?.[1]).toMatchObject({
      grants: [{ role: "executive", scope: "department", scope_value: "department-a" }],
    });
    expect(getUsageBreakdown.mock.calls[0]?.[2]).toMatchObject({
      kind: "language",
      page: 1,
      pageSize: 100,
    });
  });

  it("does not query the API for a UI scope that is not an exact grant", async () => {
    const result = await getApiCoreData({
      page: "languages",
      access: { ...access, grants: [access.grants[0]!] },
      selection: {
        kind: "department",
        value: "department-a",
        label: "department a",
        userIds: [1000003],
      },
      request,
    });

    expect(result).toBeNull();
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("does not request per-user rows when names are disabled", async () => {
    const result = await getApiCoreData({
      page: "users",
      access,
      selection: { kind: "all", value: "all", label: "All available data", userIds: [1000003] },
      request,
    });

    expect(result).toBeNull();
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });
});

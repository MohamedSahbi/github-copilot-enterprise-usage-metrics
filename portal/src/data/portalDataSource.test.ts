import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPortalDataSource, syntheticPortalDataSource } from "./portalDataSource";

const request = { period: "last_7_days" } as const;

describe("synthetic portal data source", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_TEST_AUTH", "1");
    vi.clearAllMocks();
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

});

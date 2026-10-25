import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getFixturePersonaAccess } from "../access/portalAccess";
import { syntheticPortalDataSource } from "./portalDataSource";

const request = { from: "2026-03-02", to: "2026-03-06" };

describe("synthetic portal data source", () => {
  beforeAll(() => vi.stubEnv("E2E_TEST_AUTH", "1"));
  afterAll(() => vi.unstubAllEnvs());

  it("limits manager data to direct and indirect reports", async () => {
    const manager = getFixturePersonaAccess("manager");
    const result = await syntheticPortalDataSource.getCoreData({
      request,
      scope: "team",
      allowedUserIds: manager.allowedUserIds,
      perUserDetailEnabled: false,
    });

    expect(result.visibleUserCount).toBe(6);
    expect(result.aggregatedMetrics.overview.stats.uniqueUsers).toBe(6);
    expect(result.aggregatedMetrics.users.userSummaries).toEqual([]);
  });

  it("limits member data to self and suppresses the below-threshold aggregate", async () => {
    const member = getFixturePersonaAccess("member");
    const result = await syntheticPortalDataSource.getCoreData({
      request,
      scope: "self",
      allowedUserIds: member.allowedUserIds,
      perUserDetailEnabled: false,
    });

    expect(result.visibleUserCount).toBe(1);
    expect(result.suppressed).toBe(true);
    expect(result.aggregatedMetrics.overview.stats.uniqueUsers).toBe(0);
    expect(result.overview.data.adoption.suppressed).toBe(true);
    expect(result.users).toBeNull();
  });

  it("returns user details only when enabled for an allowed fixture user", async () => {
    const manager = getFixturePersonaAccess("manager");
    const query = {
      request,
      scope: "team" as const,
      allowedUserIds: manager.allowedUserIds,
      perUserDetailEnabled: true,
    };

    await expect(
      syntheticPortalDataSource.getUserDetails(query, { id: 1000001, login: "example-user-001" }),
    ).resolves.not.toBeNull();
    await expect(
      syntheticPortalDataSource.getUserDetails(query, { id: 1000012, login: "example-user-012" }),
    ).resolves.toBeNull();
    await expect(
      syntheticPortalDataSource.getUserDetails({ ...query, perUserDetailEnabled: false }, {
        id: 1000001,
        login: "example-user-001",
      }),
    ).resolves.toBeNull();
  });
});

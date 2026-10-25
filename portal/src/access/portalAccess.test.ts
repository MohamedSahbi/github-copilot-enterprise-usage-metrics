import { describe, expect, it } from "vitest";
import { getFixturePersonaAccess, getSyntheticFixtureUserIds } from "./portalAccess";

describe("synthetic persona scopes", () => {
  it("limits the manager to direct and indirect reports", () => {
    const manager = getFixturePersonaAccess("manager");
    expect(manager.allowedUserIds).toEqual([1000001, 1000003, 1000004, 1000006, 1000007, 1000008]);
    expect(manager.allowedUserIds).not.toEqual(getSyntheticFixtureUserIds());
  });

  it("limits the member to self", () => {
    expect(getFixturePersonaAccess("member").allowedUserIds).toEqual([1000001]);
  });

  it("grants the admin all synthetic users and no-access none", () => {
    expect(getFixturePersonaAccess("admin").allowedUserIds).toEqual(getSyntheticFixtureUserIds());
    expect(getFixturePersonaAccess("no-access").allowedUserIds).toEqual([]);
  });
});

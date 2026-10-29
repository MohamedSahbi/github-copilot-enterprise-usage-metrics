import { describe, expect, it } from "vitest";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";
import type { PortalScopeSelection } from "../access/portalAccess";
import { prepareUpstreamRecords } from "./upstreamCoreDataSource";

function records(userCount: number): CopilotMetrics[] {
  return Array.from({ length: userCount }, (_, index) => ({
    day: "2026-03-02",
    user_id: 100 + index,
    user_login: `real-login-${index}`,
  }) as CopilotMetrics);
}

const team: PortalScopeSelection = { kind: "team", value: "team", label: "My team", userIds: [] };
const self: PortalScopeSelection = { kind: "self", value: "self", label: "Me", userIds: [] };

describe("prepareUpstreamRecords", () => {
  it("suppresses a scope below the minimum group size", () => {
    // The single four-user day is itself a small group, so nothing is left to count.
    expect(prepareUpstreamRecords(records(4), { selection: team, perUserDetailEnabled: false })).toEqual({
      state: "suppressed",
      userCount: 0,
    });
  });

  it("shows a viewer their own data", () => {
    expect(prepareUpstreamRecords(records(1), { selection: self, perUserDetailEnabled: false }).state).toBe("ready");
  });

  it("hides logins without per-user detail", () => {
    const prepared = prepareUpstreamRecords(records(5), { selection: team, perUserDetailEnabled: false });
    expect(prepared.state).toBe("ready");
    if (prepared.state !== "ready") return;
    expect(JSON.stringify(prepared.records)).not.toContain("real-login");
  });

  it("keeps logins and small scopes with per-user detail", () => {
    const prepared = prepareUpstreamRecords(records(2), { selection: team, perUserDetailEnabled: true });
    expect(prepared.state).toBe("ready");
    if (prepared.state !== "ready") return;
    expect(prepared.records.map(({ user_login }) => user_login)).toEqual(["real-login-0", "real-login-1"]);
  });

  it("hides small groups inside a releasable scope instead of the whole scope", () => {
    const withFeatures = records(6).map((record, index) => ({
      ...record,
      totals_by_feature: [
        { feature: "code_completion" },
        ...(index === 0 ? [{ feature: "copilot_cli" }] : []),
      ],
    }) as CopilotMetrics);
    const prepared = prepareUpstreamRecords(withFeatures, { selection: team, perUserDetailEnabled: false });
    expect(prepared.state).toBe("ready");
    if (prepared.state !== "ready") return;
    expect(prepared.userCount).toBe(6);
    expect(JSON.stringify(prepared.records)).not.toContain("copilot_cli");
    expect(prepared.records.every(({ totals_by_feature }) => totals_by_feature[0]?.feature === "code_completion")).toBe(true);
  });
});

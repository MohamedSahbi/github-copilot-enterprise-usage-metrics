import { describe, expect, it } from "vitest";
import { toFeatureAdoptionData, type FeatureAdoptionAggregate } from "./featureAdoption";

const aggregate: FeatureAdoptionAggregate = {
  totalUsers: 10,
  completionUsers: 9,
  completionOnlyUsers: 2,
  chatUsers: 6,
  agentModeUsers: 3,
  askModeUsers: 4,
  inlineModeUsers: 1,
  planModeUsers: 1,
  cliUsers: 2,
  appUsers: 1,
  vscodeAgentUsers: 2,
  codingAgentUsers: 1,
  codeReviewUsers: 1,
  advancedUsers: 5,
};

describe("toFeatureAdoptionData", () => {
  it("passes every aggregate count through, including the advanced-user union", () => {
    expect(toFeatureAdoptionData(aggregate)).toEqual(aggregate);
  });

  it("returns a copy so callers cannot mutate the source aggregate", () => {
    const data = toFeatureAdoptionData(aggregate);
    data.totalUsers = 0;
    expect(aggregate.totalUsers).toBe(10);
  });
});

import type { FeatureAdoptionData } from "@upstream/domain/calculators";

/** Distinct-user counts per feature as an aggregate query would return them. */
export interface FeatureAdoptionAggregate {
  totalUsers: number;
  completionUsers: number;
  completionOnlyUsers: number;
  chatUsers: number;
  agentModeUsers: number;
  askModeUsers: number;
  inlineModeUsers: number;
  planModeUsers: number;
  cliUsers: number;
  appUsers: number;
  vscodeAgentUsers: number;
  codingAgentUsers: number;
  codeReviewUsers: number;
  /** Union of agent mode, VS Code agents, CLI, and cloud agent users; not derivable from the other counts. */
  advancedUsers: number;
}

export function toFeatureAdoptionData(aggregate: FeatureAdoptionAggregate): FeatureAdoptionData {
  return { ...aggregate };
}

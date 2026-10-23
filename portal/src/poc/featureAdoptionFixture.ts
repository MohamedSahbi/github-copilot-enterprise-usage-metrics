import type { FeatureAdoptionAggregate } from "@/adapters/featureAdoption";

/** Anonymized, hard-coded numbers for the Phase 0 proof of concept. Replaced by SQL aggregates in Phase 3. */
export const featureAdoptionFixture: FeatureAdoptionAggregate = {
  totalUsers: 120,
  completionUsers: 110,
  completionOnlyUsers: 30,
  chatUsers: 72,
  agentModeUsers: 28,
  askModeUsers: 55,
  inlineModeUsers: 18,
  planModeUsers: 9,
  cliUsers: 14,
  appUsers: 6,
  vscodeAgentUsers: 11,
  codingAgentUsers: 8,
  codeReviewUsers: 20,
  advancedUsers: 40,
};

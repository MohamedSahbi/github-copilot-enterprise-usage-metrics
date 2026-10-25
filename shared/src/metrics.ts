// Metric definitions, version 1 (docs/architecture/data-contracts.md §4). The upstream aggregation is the oracle.

import { FEATURE_TAXONOMY, isAgentFeature, isChatFeature, isCodeCompletionFeature } from "./features";

const chatModeBucketOf = (f: string) => FEATURE_TAXONOMY[f]?.chatModeBucket;

export const METRIC_DEFINITION_VERSION = "1";

export interface AdoptionRow {
  user_id: number;
  usage_day: string;
  used_cli: boolean;
  used_copilot_app: boolean;
  used_vscode_agent: boolean;
  used_cloud_agent: boolean;
  used_code_review_active: boolean;
  used_code_review_passive: boolean;
  ai_credits_used: number;
  features: { feature: string; interactions: number; generations: number }[];
}

export interface Adoption {
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
  advancedUsers: number;
}

// A feature counts for a user only if interactions > 0 or generations > 0 on at least one day in the range.
export function computeAdoption(rows: readonly AdoptionRow[]): Adoption {
  interface U { features: Set<string>; cli: boolean; app: boolean; vsAgent: boolean; cloud: boolean; review: boolean }
  const users = new Map<number, U>();
  for (const r of rows) {
    const u = users.get(r.user_id) ?? { features: new Set<string>(), cli: false, app: false, vsAgent: false, cloud: false, review: false };
    for (const f of r.features) if (f.interactions > 0 || f.generations > 0) u.features.add(f.feature);
    u.cli ||= r.used_cli;
    u.app ||= r.used_copilot_app;
    u.vsAgent ||= r.used_vscode_agent;
    u.cloud ||= r.used_cloud_agent;
    u.review ||= r.used_code_review_active || r.used_code_review_passive;
    users.set(r.user_id, u);
  }
  const out: Adoption = {
    totalUsers: 0, completionUsers: 0, completionOnlyUsers: 0, chatUsers: 0, agentModeUsers: 0, askModeUsers: 0, inlineModeUsers: 0, planModeUsers: 0, cliUsers: 0,
    appUsers: 0, vscodeAgentUsers: 0, codingAgentUsers: 0, codeReviewUsers: 0, advancedUsers: 0,
  };
  for (const u of users.values()) {
    const feats = [...u.features];
    const completion = feats.some(isCodeCompletionFeature);
    const chat = feats.some(isChatFeature);
    const agent = feats.some(isAgentFeature);
    // Users with no counted feature and no flag are not in the population (upstream builds the union of signals).
    if (!feats.length && !u.cli && !u.app && !u.vsAgent && !u.cloud && !u.review) continue;
    out.totalUsers++;
    if (completion) out.completionUsers++;
    if (chat) out.chatUsers++;
    if (agent) out.agentModeUsers++;
    if (feats.some((f) => chatModeBucketOf(f) === "ask")) out.askModeUsers++;
    if (feats.some((f) => chatModeBucketOf(f) === "inline")) out.inlineModeUsers++;
    if (feats.some((f) => chatModeBucketOf(f) === "plan")) out.planModeUsers++;
    if (u.cli) out.cliUsers++;
    if (u.app) out.appUsers++;
    if (u.vsAgent) out.vscodeAgentUsers++;
    if (u.cloud) out.codingAgentUsers++;
    if (u.review) out.codeReviewUsers++;
    if (agent || u.cli || u.vsAgent || u.cloud) out.advancedUsers++;
    if (completion && !chat && !agent && !u.cli && !u.app && !u.vsAgent && !u.cloud && !u.review) out.completionOnlyUsers++;
  }
  return out;
}

export interface DailyAiCredits { date: string; aiCreditsUsed: number; users: number }

// Sum per day; users = distinct users with ai_credits_used > 0.
export function computeDailyAiCredits(rows: readonly AdoptionRow[]): DailyAiCredits[] {
  const days = new Map<string, { sum: number; users: Set<number> }>();
  for (const r of rows) {
    const d = days.get(r.usage_day) ?? { sum: 0, users: new Set<number>() };
    d.sum += r.ai_credits_used;
    if (r.ai_credits_used > 0) d.users.add(r.user_id);
    days.set(r.usage_day, d);
  }
  return [...days.entries()]
    .map(([date, d]) => ({ date, aiCreditsUsed: d.sum, users: d.users.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

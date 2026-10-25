import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMetricsLine } from "../../../portal/upstream/src/domain/metricsParser";
import { aggregateMetrics } from "../../../portal/upstream/src/domain/metricsAggregator";
import { getFeatureTaxonomy } from "../../../portal/upstream/src/domain/featureCategories";
import { FEATURE_TAXONOMY } from "../../../shared/src/features";
import { computeAdoption, computeDailyAiCredits, type AdoptionRow } from "../../../shared/src/metrics";
import { createStagingContext, mapUsersDayLine } from "../reference/staging";
import { WINDOW } from "../synthetic";

const text = readFileSync(join(__dirname, "..", "..", "..", "fixtures", "synthetic", "users-1-day.ndjson"), "utf8");
const lines = text.split("\n").filter(Boolean);

const upstream = aggregateMetrics(lines.map((l) => parseMetricsLine(l)!)).aggregated;

const ctx = createStagingContext("00000000-0000-4000-8000-000000000001", WINDOW);
const ART = 1;
const staged = lines.map((l, i) => mapUsersDayLine(l, i + 1, ctx, ART));
const rows: AdoptionRow[] = staged.map((s) => ({
  user_id: s.daily!.user_id,
  usage_day: s.daily!.usage_day,
  used_cli: s.daily!.used_cli,
  used_copilot_app: s.daily!.used_copilot_app,
  used_vscode_agent: s.daily!.used_vscode_agent,
  used_cloud_agent: s.daily!.used_cloud_agent,
  used_code_review_active: s.daily!.used_code_review_active,
  used_code_review_passive: s.daily!.used_code_review_passive,
  ai_credits_used: Number(s.daily!.ai_credits_used),
  features: s.breakdown.filter((b) => b.breakdown_kind === "feature").map((b) => ({
    feature: b.key_1, interactions: b.interaction_count, generations: b.code_generation_count,
  })),
}));

describe("upstream oracle vs documented formulas (metric version 1)", () => {
  it("fixture is non-trivial", () => {
    expect(rows.length).toBe(lines.length);
    expect(computeAdoption(rows).totalUsers).toBeGreaterThan(5);
    expect(computeAdoption(rows).askModeUsers).toBeGreaterThan(0);
  });

  it("feature adoption counts agree", () => {
    const u = (upstream as unknown as { adoption: { featureAdoptionData: Record<string, number> } }).adoption.featureAdoptionData;
    expect(computeAdoption(rows)).toEqual({
      totalUsers: u.totalUsers,
      completionUsers: u.completionUsers,
      completionOnlyUsers: u.completionOnlyUsers,
      chatUsers: u.chatUsers,
      agentModeUsers: u.agentModeUsers,
      askModeUsers: u.askModeUsers,
      inlineModeUsers: u.inlineModeUsers,
      planModeUsers: u.planModeUsers,
      cliUsers: u.cliUsers,
      appUsers: u.appUsers,
      vscodeAgentUsers: u.vscodeAgentUsers,
      codingAgentUsers: u.codingAgentUsers,
      codeReviewUsers: u.codeReviewUsers,
      advancedUsers: u.advancedUsers,
    });
  });

  it("daily AI credits agree", () => {
    const u = (upstream as unknown as { ai: { dailyAiCreditsData: { date: string; aiCreditsUsed: number; users: number }[] } }).ai.dailyAiCreditsData;
    const ours = computeDailyAiCredits(rows);
    expect(ours.map((d) => d.date)).toEqual(u.map((d) => d.date));
    ours.forEach((d, i) => {
      expect(d.users).toBe(u[i]!.users);
      expect(d.aiCreditsUsed).toBeCloseTo(u[i]!.aiCreditsUsed, 6);
    });
  });

  it("our feature taxonomy equals upstream's for every entry", () => {
    const up = getFeatureTaxonomy();
    expect(Object.keys(FEATURE_TAXONOMY).sort()).toEqual(up.map((e) => e.feature).sort());
    for (const e of up) {
      const o = FEATURE_TAXONOMY[e.feature]!;
      expect([o.isChat, o.isAgent, o.chatModeBucket ?? null]).toEqual([!!e.isChat, !!e.isAgent, e.chatModeBucket ?? null]);
    }
  });
});

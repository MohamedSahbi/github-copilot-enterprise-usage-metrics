import { describe, expect, it } from "vitest";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";
import { suppressSmallGroups } from "./groupSuppression";

const loc = {
  code_generation_activity_count: 1,
  code_acceptance_activity_count: 1,
  loc_added_sum: 1,
  loc_deleted_sum: 0,
  loc_suggested_to_add_sum: 1,
  loc_suggested_to_delete_sum: 0,
};

function record(userId: number, day: string, small: boolean): CopilotMetrics {
  return {
    day,
    user_id: userId,
    user_login: `user-${userId}`,
    user_initiated_interaction_count: 3,
    totals_by_ide: [{
      ide: small ? "rare_ide" : "vscode",
      user_initiated_interaction_count: 3,
      ...loc,
      last_known_ide_version: { sampled_at: day, ide_version: small ? "0.9" : "1.0" },
    }],
    totals_by_feature: [
      { feature: "code_completion", user_initiated_interaction_count: 1, ...loc },
      ...(small ? [{ feature: "copilot_cli", user_initiated_interaction_count: 2, ...loc }] : []),
    ],
    totals_by_language_feature: [{ language: small ? "cobol" : "typescript", feature: "code_completion", ...loc }],
    totals_by_language_model: [],
    totals_by_model_feature: [{ model: small ? "rare-model" : "gpt-5", feature: "chat_panel_agent_mode", user_initiated_interaction_count: 1, ...loc }],
    used_agent: true,
    used_chat: true,
    used_cli: small,
    used_copilot_coding_agent: false,
    totals_by_cli: small ? { session_count: 1, request_count: 1, prompt_count: 1, token_usage: { output_tokens_sum: 1, prompt_tokens_sum: 1, avg_tokens_per_request: 2 } } : undefined,
    ai_adoption_phase: { phase_number: small ? 4 : 2, phase: small ? "Advanced" : "Exploring", version: "1" },
  } as CopilotMetrics;
}

// Seven users on Mar 2: users 1-2 form the small groups, users 3-7 the groups of exactly five.
// Two users on Mar 3.
const records = [
  ...[1, 2, 3, 4, 5, 6, 7].map((id) => record(id, "2026-03-02", id <= 2)),
  record(1, "2026-03-03", false),
  record(2, "2026-03-03", false),
];

describe("suppressSmallGroups", () => {
  const released = suppressSmallGroups(records, 5);
  const text = JSON.stringify(released);

  it("drops days with fewer users than the minimum", () => {
    expect(new Set(released.map(({ day }) => day))).toEqual(new Set(["2026-03-02"]));
    expect(released).toHaveLength(7);
  });

  it("keeps groups at the minimum and removes every smaller group", () => {
    expect(released.every(({ totals_by_feature }) => totals_by_feature.some(({ feature }) => feature === "code_completion"))).toBe(true);
    for (const hidden of ["rare_ide", "\"0.9\"", "copilot_cli", "cobol", "rare-model", "\"Advanced\"", "totals_by_cli"]) {
      expect(text).not.toContain(hidden);
    }
    expect(released.every(({ used_cli }) => used_cli === false)).toBe(true);
    expect(released.filter(({ ai_adoption_phase }) => ai_adoption_phase !== undefined)).toHaveLength(5);
  });

  it("keeps groups at or above the minimum intact", () => {
    expect(released.every(({ used_agent, used_chat }) => used_agent && used_chat)).toBe(true);
    const ides = released.flatMap(({ totals_by_ide }) => totals_by_ide);
    expect(ides).toHaveLength(5);
    expect(ides.every(({ ide, last_known_ide_version }) => ide === "vscode" && last_known_ide_version?.ide_version === "1.0")).toBe(true);
    expect(released.flatMap(({ totals_by_model_feature }) => totals_by_model_feature)).toHaveLength(5);
  });

  it("does not change the input records", () => {
    expect(records[0]!.totals_by_feature).toHaveLength(2);
    expect(records[0]!.used_cli).toBe(true);
  });
});

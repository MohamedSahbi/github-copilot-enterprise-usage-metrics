import { describe, expect, it } from "vitest";
import { TABLE_COLUMNS } from "../../../shared/src/rows.js";
import { breakdownTable, dailyTable } from "./day-loader.js";
import { parseMetricsDay } from "./day-parser.js";

describe("metrics staging bulk column order", () => {
  it("maps daily and breakdown values by column name, not object insertion order", () => {
    const parsed = parseMetricsDay(JSON.stringify({
      day: "2026-03-02", organization_id: 1, user_id: 2,
      user_initiated_interaction_count: 3, code_generation_activity_count: 4, code_acceptance_activity_count: 5,
      loc_added_sum: 6, loc_deleted_sum: 7, loc_suggested_to_add_sum: 8, loc_suggested_to_delete_sum: 9,
      totals_by_cli: { session_count: 10, request_count: 11, token_usage: { prompt_tokens_sum: 12, output_tokens_sum: 13 } },
    }), { runId: "00000000-0000-4000-8000-000000000001", artifactId: 14, reportDay: "2026-03-02", organizationId: 1 });
    expect(parsed.issues).toEqual([]);
    const { daily, breakdown } = parsed.rows[0]!;
    const { run_id, ai_credits_used, ...dailyRest } = daily;
    const reorderedDaily = { ai_credits_used, ...dailyRest, run_id };
    const { key_1, session_count, ...breakdownRest } = breakdown[0]!;
    const reorderedBreakdown = { session_count, ...breakdownRest, key_1 };
    expect(Object.keys(reorderedDaily)).not.toEqual(Object.keys(daily));
    expect(Object.keys(reorderedBreakdown)).not.toEqual(Object.keys(breakdown[0]!));

    const dailyBulk = dailyTable([reorderedDaily]);
    const breakdownBulk = breakdownTable([reorderedBreakdown]);
    expect(dailyBulk.columns.map((column) => column.name)).toEqual(TABLE_COLUMNS["portal.stg_user_daily"]);
    expect(breakdownBulk.columns.map((column) => column.name)).toEqual(TABLE_COLUMNS["portal.stg_user_breakdown"]);
    expect(dailyBulk.rows[0]).toEqual(TABLE_COLUMNS["portal.stg_user_daily"].map((column) => daily[column]));
    expect(breakdownBulk.rows[0]).toEqual(TABLE_COLUMNS["portal.stg_user_breakdown"].map((column) => breakdown[0]![column]));
    expect(dailyBulk.columns.find((column) => column.name === "ai_credits_used"))
      .toMatchObject({ length: 40 });
    expect(dailyBulk.columns.find((column) => column.name === "ai_adoption_phase_version"))
      .toMatchObject({ length: 64, nullable: true });
    for (const name of ["prompt_count", "total_user_messages"]) {
      expect(breakdownBulk.columns.find((column) => column.name === name)).toMatchObject({ nullable: true });
    }
  });
});

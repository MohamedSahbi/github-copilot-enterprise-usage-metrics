import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStagingContext, mapUsersDayLine, parseAiCreditCsv } from "./reference/staging";
import { INVALID_EXPECTED, WINDOW } from "./synthetic";

const dir = join(__dirname, "..", "..", "fixtures", "synthetic");
const RUN = "00000000-0000-4000-8000-000000000001";
const ART = 7;
const lines = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);

describe("users-1-day → staging shape", () => {
  it("loads every valid fixture line with typed columns and no rejects", () => {
    const ctx = createStagingContext(RUN, WINDOW);
    const results = lines("users-1-day.ndjson").map((l, i) => mapUsersDayLine(l, i + 1, ctx, ART));
    expect(results.every((r) => r.loaded)).toBe(true);
    const first = results[0]!.daily!;
    expect(typeof first.user_id).toBe("number");
    expect(typeof first.organization_id).toBe("number");
    expect(first.usage_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.run_id).toBe(RUN);
    expect(first.line_number).toBe(1);
    expect(first.artifact_id).toBe(ART);
    expect(results[0]!.breakdown.length).toBeGreaterThan(0);
  });

  it("quarantines invalid rows with the documented code and severity", () => {
    const ctx = createStagingContext(RUN, WINDOW);
    lines("users-1-day.invalid.ndjson").forEach((l, i) => {
      const r = mapUsersDayLine(l, i + 1, ctx, ART);
      const want = INVALID_EXPECTED[i]!;
      expect(r.loaded, `line ${i + 1}`).toBe(want.loaded);
      if (want.code) {
        expect(r.issues.map((x) => `${x.severity}:${x.error_code}`), `line ${i + 1}`).toContain(`${want.severity}:${want.code}`);
      } else {
        expect(r.issues).toEqual([]);
      }
    });
  });

  it("loads unknown fields into extra_json", () => {
    const ctx = createStagingContext(RUN, WINDOW);
    const r = mapUsersDayLine(lines("users-1-day.invalid.ndjson")[9]!, 10, ctx, ART);
    expect(JSON.parse(r.daily!.extra_json!)).toEqual({ brand_new_field: 1 });
  });

  it("treats absent optional booleans as false and absent credits as 0", () => {
    const ctx = createStagingContext(RUN, WINDOW);
    const row = JSON.parse(lines("users-1-day.ndjson")[0]!);
    delete row.used_vscode_agent;
    delete row.ai_credits_used;
    const r = mapUsersDayLine(JSON.stringify(row), 1, ctx, ART);
    expect(r.daily!.used_vscode_agent).toBe(false);
    expect(r.daily!.ai_credits_used).toBe(0);
  });
});

describe("ai_credit CSV → staging shape", () => {
  it("parses every fixture row, keeps decimals as strings and '' for empty keys", () => {
    const { rows, issues } = parseAiCreditCsv(readFileSync(join(dir, "ai-credit.csv"), "utf8"), RUN, ART);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(18);
    expect(typeof rows[0]!.aic_quantity).toBe("string");
    expect(rows[0]!.repository).toBe("");
  });

  it("flags unknown columns and duplicate natural keys", () => {
    const csv = readFileSync(join(dir, "ai-credit.csv"), "utf8").split("\n").filter(Boolean);
    const dup = [csv[0] + ",surprise", ...csv.slice(1).map((l) => l + ",x"), csv[1] + ",x"].join("\n");
    const { rows, issues } = parseAiCreditCsv(dup, RUN, ART);
    expect(issues.map((i) => i.error_code)).toEqual(expect.arrayContaining(["unknown_field", "duplicate_key"]));
    expect(rows).toHaveLength(18);
  });

  it("fails the file when a required column is missing", () => {
    const { rows, issues } = parseAiCreditCsv("date,username\n2026-03-02,a\n", RUN, ART);
    expect(rows).toEqual([]);
    expect(issues[0]!.severity).toBe("fatal");
    expect(issues[0]!.error_code).toBe("unsupported_schema");
  });
});

describe("multipart reports under one run", () => {
  const csv = readFileSync(join(dir, "ai-credit.csv"), "utf8");

  it("keeps rows of different parts distinct by (run, artifact, line) even though line numbers restart", () => {
    const seen = new Map<string, string>();
    const a = parseAiCreditCsv(csv, RUN, 1, seen);
    const other = csv.replace(/2026-03-0(\d)/g, "2026-04-0$1");
    const b = parseAiCreditCsv(other, RUN, 2, seen);
    expect(b.issues).toEqual([]);
    const keys = [...a.rows, ...b.rows].map((r) => `${r.run_id}|${r.artifact_id}|${r.line_number}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(a.rows[0]!.line_number).toBe(b.rows[0]!.line_number);
  });

  it("still detects a duplicate natural key across parts", () => {
    const seen = new Map<string, string>();
    parseAiCreditCsv(csv, RUN, 1, seen);
    const again = parseAiCreditCsv(csv, RUN, 2, seen);
    expect(again.rows).toEqual([]);
    expect(again.issues.every((i) => i.error_code === "duplicate_key" && i.artifact_id === 2)).toBe(true);
  });

  it("stages users-1-day lines of two parts with the same line number", () => {
    const ctx = createStagingContext(RUN, WINDOW);
    const base = JSON.parse(lines("users-1-day.ndjson")[0]!);
    const a = mapUsersDayLine(JSON.stringify(base), 1, ctx, 1);
    const b = mapUsersDayLine(JSON.stringify({ ...base, user_id: base.user_id + 500 }), 1, ctx, 2);
    expect([a.daily!.artifact_id, b.daily!.artifact_id]).toEqual([1, 2]);
  });
});

describe("count validation and nested mappings", () => {
  const base = () => JSON.parse(lines("users-1-day.ndjson")[0]!) as Record<string, unknown>;
  const map = (o: Record<string, unknown>) => mapUsersDayLine(JSON.stringify(o), 1, createStagingContext(RUN, WINDOW), ART);

  it.each([
    ["fractional interaction count", { user_initiated_interaction_count: 1.5 }],
    ["INT overflow", { code_generation_activity_count: 2147483648 }],
    ["fractional LOC", { loc_added_sum: 0.5 }],
    ["unsafe LOC", { loc_deleted_sum: 2 ** 53 }],
    ["string count", { code_acceptance_activity_count: "3" }],
  ])("quarantines %s", (_n, patch) => {
    const r = map({ ...base(), ...patch });
    expect(r.loaded).toBe(false);
    expect(r.issues.map((i) => i.error_code)).toContain("negative_count");
  });

  it("accepts the INT maximum", () => {
    expect(map({ ...base(), user_initiated_interaction_count: 2147483647 }).loaded).toBe(true);
  });

  it("keeps IDE and plugin version information in version_info", () => {
    const o = base();
    o.totals_by_ide = [
      {
        ide: "vscode", user_initiated_interaction_count: 1, code_generation_activity_count: 1, code_acceptance_activity_count: 1,
        loc_added_sum: 1, loc_deleted_sum: 0, loc_suggested_to_add_sum: 1, loc_suggested_to_delete_sum: 0,
        last_known_ide_version: { sampled_at: "2026-03-02T10:00:00Z", ide_version: "1.2.3" },
        last_known_plugin_version: { sampled_at: "2026-03-02T10:00:00Z", plugin: "copilot-chat", plugin_version: "4.5.6" },
      },
      { ide: "jetbrains", user_initiated_interaction_count: 1, code_generation_activity_count: 0, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0 },
    ];
    const ide = map(o).breakdown.filter((b) => b.breakdown_kind === "ide");
    expect(JSON.parse(ide[0]!.version_info!)).toEqual({
      last_known_ide_version: { ide_version: "1.2.3", sampled_at: "2026-03-02T10:00:00Z" },
      last_known_plugin_version: { plugin: "copilot-chat", plugin_version: "4.5.6", sampled_at: "2026-03-02T10:00:00Z" },
    });
    expect(ide[1]!.version_info).toBeNull();
  });

  it("keeps CLI totals and version, and quarantines an invalid supplied client counter", () => {
    const o = base();
    o.totals_by_cli = {
      session_count: 2, request_count: 5, prompt_count: 3,
      token_usage: { output_tokens_sum: 10, prompt_tokens_sum: 20, avg_tokens_per_request: 6 },
      last_known_cli_version: { sampled_at: "2026-03-02T10:00:00Z", cli_version: "0.0.1" },
    };
    const ok = map(o).breakdown.find((b) => b.breakdown_kind === "client" && b.key_1 === "copilot_cli")!;
    expect([ok.session_count, ok.request_count, ok.prompt_tokens, ok.output_tokens]).toEqual([2, 5, 20, 10]);
    expect(JSON.parse(ok.version_info!)).toEqual({ last_known_cli_version: { cli_version: "0.0.1", sampled_at: "2026-03-02T10:00:00Z" } });

    for (const bad of [{ session_count: -1 }, { request_count: 1.5 }, { token_usage: { prompt_tokens_sum: -5 } }]) {
      const r = map({ ...o, totals_by_cli: { ...(o.totals_by_cli as object), ...bad } });
      expect(r.loaded).toBe(false);
      expect(r.issues.map((i) => i.error_code)).toContain("negative_count");
    }
  });

  it("does not invent a totals_by_client mapping: it is not in the upstream types, so it is an unknown field kept in extra_json", () => {
    const r = map({ ...base(), totals_by_client: [{ client: "x" }] });
    expect(r.loaded).toBe(true);
    expect(r.issues.map((i) => i.error_code)).toContain("unknown_field");
    expect(JSON.parse(r.daily!.extra_json!)).toHaveProperty("totals_by_client");
  });
});

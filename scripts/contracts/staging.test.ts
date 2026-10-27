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
  it("extracts phase version and independent client-specific source counts", () => {
    const result = mapUsersDayLine(JSON.stringify({
      day: WINDOW.start, organization_id: 1, user_id: 1,
      user_initiated_interaction_count: 2, code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      loc_added_sum: 1, loc_deleted_sum: 0, loc_suggested_to_add_sum: 3, loc_suggested_to_delete_sum: 0,
      ai_adoption_phase: { phase_number: 2, phase: "Agent first", version: "v1" },
      totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 1 }],
      totals_by_cli: { session_count: 3, request_count: 4, prompt_count: 5 },
      totals_by_copilot_app: { session_count: 6, prompt_count: 7 },
      totals_by_vscode_agent: { total_user_messages: 8, token_usage: { prompt_tokens_sum: 9 } },
    }), 1, createStagingContext(RUN, WINDOW), ART);
    expect(result.issues).toEqual([]);
    expect(result.loaded).toBe(true);
    expect(result.daily).toMatchObject({
      ai_adoption_phase_version: "v1", ai_adoption_phase_number: 2, ai_adoption_phase: "Agent first",
      interaction_count: 2, code_generation_count: 1, loc_added: 1,
    });
    expect(result.breakdown).toHaveLength(4);
    expect(result.breakdown.find((row) => row.key_1 === "copilot_cli"))
      .toMatchObject({ session_count: 3, request_count: 4 });
    expect(result.breakdown.find((row) => row.key_1 === "copilot_cli"))
      .toMatchObject({ prompt_count: 5, total_user_messages: null });
    expect(result.breakdown.find((row) => row.key_1 === "copilot_app"))
      .toMatchObject({ prompt_count: 7, total_user_messages: null });
    expect(result.breakdown.find((row) => row.key_1 === "vscode_agent"))
      .toMatchObject({ prompt_tokens: 9, prompt_count: null, total_user_messages: 8 });
  });

  it.each([
    ["CLI prompt_count", "totals_by_cli", "prompt_count", "copilot_cli"],
    ["Copilot App prompt_count", "totals_by_copilot_app", "prompt_count", "copilot_app"],
    ["VS Code total_user_messages", "totals_by_vscode_agent", "total_user_messages", "vscode_agent"],
  ])("preserves zero and missing/null for %s", (_label, sourceField, sourceCount, client) => {
    const base = JSON.parse(lines("users-1-day.ndjson")[0]!) as Record<string, unknown>;
    for (const sourceValue of [0, undefined, null]) {
      const clientSource = sourceValue === undefined ? {} : { [sourceCount]: sourceValue };
      const result = mapUsersDayLine(JSON.stringify({ ...base, [sourceField]: clientSource }), 1, createStagingContext(RUN, WINDOW), ART);
      expect(result.issues).toEqual([]);
      const row = result.breakdown.find((candidate) => candidate.breakdown_kind === "client" && candidate.key_1 === client)!;
      expect(row[sourceCount === "prompt_count" ? "prompt_count" : "total_user_messages"]).toBe(sourceValue ?? null);
    }
  });

  it.each([
    ["CLI prompt_count", "totals_by_cli", "prompt_count"],
    ["Copilot App prompt_count", "totals_by_copilot_app", "prompt_count"],
    ["VS Code total_user_messages", "totals_by_vscode_agent", "total_user_messages"],
  ])("rejects invalid supplied %s values", (_label, sourceField, sourceCount) => {
    const base = JSON.parse(lines("users-1-day.ndjson")[0]!) as Record<string, unknown>;
    for (const value of ["5", -1, 1.5, 2_147_483_648]) {
      const result = mapUsersDayLine(
        JSON.stringify({ ...base, [sourceField]: { [sourceCount]: value } }), 1, createStagingContext(RUN, WINDOW), ART,
      );
      expect(result.loaded).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ error_code: "negative_count", field_path: `${sourceField}.${sourceCount}` }),
      ]));
    }
  });

  it.each([true, false])("keeps duplicate ordering when a client counter is invalid (invalid first: %s)", (invalidFirst) => {
    const base = JSON.parse(lines("users-1-day.ndjson")[0]!) as Record<string, unknown>;
    const invalid = { ...base, totals_by_cli: { prompt_count: "5" } };
    const ctx = createStagingContext(RUN, WINDOW);
    const orderedResults = (invalidFirst ? [invalid, base] : [base, invalid]).map((row, index) =>
      mapUsersDayLine(JSON.stringify(row), index + 1, ctx, ART),
    );
    expect(orderedResults.map((result) => result.loaded)).toEqual(invalidFirst ? [false, false] : [true, false]);
    const errorCodes = orderedResults.flatMap((result) => result.issues.map((issue) => issue.error_code));
    expect(errorCodes).toEqual(expect.arrayContaining(["negative_count", "duplicate_key"]));
  });

  it("preserves version strings through the VARCHAR(64) boundary and rejects invalid versions", () => {
    const base = JSON.parse(lines("users-1-day.ndjson")[0]!) as Record<string, unknown>;
    const mapVersion = (version: unknown) => mapUsersDayLine(
      JSON.stringify({ ...base, ai_adoption_phase: { phase_number: 2, phase: "Agent first", version } }),
      1, createStagingContext(RUN, WINDOW), ART,
    );
    expect(mapVersion("v".repeat(64)).daily?.ai_adoption_phase_version).toBe("v".repeat(64));
    expect(mapVersion("é".repeat(64)).daily?.ai_adoption_phase_version).toBe("é".repeat(64));
    expect(mapVersion("v1").daily?.ai_adoption_phase_version).toBe("v1");
    expect(mapVersion(null).daily?.ai_adoption_phase_version).toBeNull();
    expect(mapVersion(undefined).daily?.ai_adoption_phase_version).toBeNull();
    for (const version of [1, {}, "v".repeat(65)]) {
      const result = mapVersion(version);
      expect(result.loaded).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ error_code: "unsupported_schema", field_path: "ai_adoption_phase.version" }),
      ]));
    }
  });

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
    expect(r.daily!.ai_credits_used).toBe("0");
  });

  it.each([
    ["999999999.999999999", "999999999.999999999"],
    ["0.000000001", "0.000000001"],
    ["123456789123456789e-9", "123456789.123456789"],
    ["1e-9", "0.000000001"],
    ["1.2300000000", "1.23"],
    ["-0", "0"],
  ])("preserves exact credit token %s", (token, expected) => {
    const row = JSON.parse(lines("users-1-day.ndjson")[0]!);
    row.ai_credits_used = null;
    const line = JSON.stringify(row).replace('"ai_credits_used":null', `"ai_credits_used":${token}`);
    const result = mapUsersDayLine(line, 1, createStagingContext(RUN, WINDOW), ART);
    expect(result.issues).toEqual([]);
    expect(result.daily!.ai_credits_used).toBe(expected);
  });

  it.each(["1000000000", "0.0000000001", "-1", "1e999", '"1.25"', "0.0000000010000000001"])("rejects credit token %s without rounding", (token) => {
    const row = JSON.parse(lines("users-1-day.ndjson")[0]!);
    row.ai_credits_used = null;
    const line = JSON.stringify(row).replace('"ai_credits_used":null', `"ai_credits_used":${token}`);
    const result = mapUsersDayLine(line, 1, createStagingContext(RUN, WINDOW), ART);
    expect(result.loaded).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: "negative_count", field_path: "ai_credits_used" })]));
  });
});

describe("ai_credit CSV → staging shape", () => {
  const header = "date,username,model,organization,aic_quantity";

  it.each([
    '2026-03-02,"unterminated,m,,1',
    '2026-03-02,a"b,m,,1',
    '2026-03-02,"a"x,m,,1',
  ])("fails malformed CSV quoting: %s", (row) => {
    const result = parseAiCreditCsv(`${header}\n${row}`, RUN, ART);
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ severity: "fatal", error_code: "unsupported_schema", line_number: 2 })]);
  });

  it("rejects duplicate headers", () => {
    const result = parseAiCreditCsv(`${header},model\n2026-03-02,a,m,,1,m`, RUN, ART);
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({ severity: "fatal", error_code: "unsupported_schema", line_number: 1 });
  });

  it.each(["2026-03-02,a,m,,1,extra", "2026-03-02,a,m,"])("rejects inconsistent row width: %s", (row) => {
    const result = parseAiCreditCsv(`${header}\n${row}`, RUN, ART);
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({ error_code: "malformed_json", line_number: 2 });
  });

  it("supports escaped quotes, commas, multiline cells, CRLF and physical line numbers", () => {
    const result = parseAiCreditCsv(`${header}\r\n\r\n2026-03-02,a,"model,\r\n""quoted""",,1\r\n2026-03-03,b,m,,2\r\n`, RUN, ART);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((r) => [r.model, r.line_number])).toEqual([['model,\r\n"quoted"', 3], ["m", 5]]);
  });

  it("does not mutate multipart dedup state when CSV syntax is invalid", () => {
    const seen = new Map<string, string>();
    parseAiCreditCsv(`${header}\n2026-03-02,a,m,,1\n2026-03-03,b,"bad`, RUN, ART, seen);
    expect(seen.size).toBe(0);
  });

  it("keeps delimiter-containing natural keys distinct and still rejects real duplicates", () => {
    const result = parseAiCreditCsv(`${header}\n2026-03-02,a|b,c,,1\n2026-03-02,a,b|c,,1\n2026-03-02,a|b,c,,1`, RUN, ART);
    expect(result.rows).toHaveLength(2);
    expect(result.issues.map((i) => i.error_code)).toEqual(["duplicate_key"]);
  });

  it.each(["quantity", "applied_cost_per_quantity", "gross_amount", "discount_amount", "net_amount", "total_monthly_quota", "aic_gross_amount"])("rejects an unrepresentable %s decimal", (column) => {
    const result = parseAiCreditCsv(`${header},${column}\n2026-03-02,a,m,,1,0.0000000001`, RUN, ART);
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({ error_code: "negative_count", field_path: column });
  });

  it.each(["0x10", "NaN", "-1", "1000000000", "0.0000000001"])("rejects invalid aic_quantity %s", (value) => {
    const result = parseAiCreditCsv(`${header}\n2026-03-02,a,m,,${value}`, RUN, ART);
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({ error_code: "negative_count", field_path: "aic_quantity" });
  });

  it("canonicalizes exact exponent decimals for SQL and preserves signed adjustment amounts", () => {
    const result = parseAiCreditCsv(`${header},net_amount,discount_amount\n2026-03-02,a,m,,1e-9,-1.23,-0.000000001`, RUN, ART);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({ aic_quantity: "0.000000001", net_amount: "-1.23", discount_amount: "-0.000000001" });
  });

  it.each(["input", "output", "cache_read", "cache_write"])("rejects malformed or unsafe %s instead of silently returning null", (column) => {
    for (const value of ["oops", "-1", "1.5", "9007199254740992"]) {
      const result = parseAiCreditCsv(`${header},${column}\n2026-03-02,a,m,,1,${value}`, RUN, ART);
      expect(result.rows).toEqual([]);
      expect(result.issues[0]).toMatchObject({ error_code: "negative_count", field_path: column });
    }
  });

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

  it.each(["skill", "custom_agent", "mcp", "slash_cmd", "plugin"])("maps a %s family row keyed by its own name field", (family) => {
    const r = map({ ...base(), totals_by_skill: [], [`totals_by_${family}`]: [{ [family]: "example-item", interaction_count: 1 }] });
    expect(r.loaded).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.families).toMatchObject([{ family, item_name: "example-item", interaction_count: 1 }]);
  });

  it("reports a family row without its name field", () => {
    const r = map({ ...base(), totals_by_skill: [{ name: "example-skill", interaction_count: 1 }] });
    expect(r.issues.map((i) => i.error_code)).toContain("extra_nested_item");
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

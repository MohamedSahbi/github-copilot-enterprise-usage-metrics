import { describe, expect, it, vi } from "vitest";
import { parseMetricsDay } from "./day-parser.js";

const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    day: "2026-03-02",
    organization_id: "9000001",
    user_id: 1001,
    user_login: "example-user",
    user_initiated_interaction_count: 2,
    code_generation_activity_count: 1,
    code_acceptance_activity_count: 0,
    loc_suggested_to_add_sum: 3,
    loc_suggested_to_delete_sum: 0,
    loc_added_sum: 1,
    loc_deleted_sum: 0,
    totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 1 }],
    ...overrides,
  });

describe("parseMetricsDay", () => {
  it("extracts phase version and independent client-specific source counts", () => {
    const result = parseMetricsDay(line({
      ai_adoption_phase: { phase_number: 2, phase: "Agent first", version: "v1" },
      totals_by_cli: { session_count: 3, request_count: 4, prompt_count: 5 },
      totals_by_copilot_app: { session_count: 6, prompt_count: 7 },
      totals_by_vscode_agent: { total_user_messages: 8, token_usage: { prompt_tokens_sum: 9 } },
    }), {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.daily).toMatchObject({
      ai_adoption_phase_version: "v1", ai_adoption_phase_number: 2, ai_adoption_phase: "Agent first",
      interaction_count: 2, code_generation_count: 1, loc_added: 1,
    });
    expect(result.rows[0]!.breakdown).toHaveLength(4);
    expect(result.rows[0]!.breakdown.find((row) => row.key_1 === "copilot_cli"))
      .toMatchObject({ session_count: 3, request_count: 4, prompt_count: 5, total_user_messages: null });
    expect(result.rows[0]!.breakdown.find((row) => row.key_1 === "copilot_app"))
      .toMatchObject({ prompt_count: 7, total_user_messages: null });
    expect(result.rows[0]!.breakdown.find((row) => row.key_1 === "vscode_agent"))
      .toMatchObject({ prompt_tokens: 9, prompt_count: null, total_user_messages: 8 });
  });

  it.each([
    ["CLI prompt_count", "totals_by_cli", "prompt_count", "copilot_cli"],
    ["Copilot App prompt_count", "totals_by_copilot_app", "prompt_count", "copilot_app"],
    ["VS Code total_user_messages", "totals_by_vscode_agent", "total_user_messages", "vscode_agent"],
  ])("preserves zero and missing/null for %s", (_label, sourceField, sourceCount, client) => {
    for (const sourceValue of [0, undefined, null]) {
      const clientSource = sourceValue === undefined ? {} : { [sourceCount]: sourceValue };
      const result = parseMetricsDay(line({ [sourceField]: clientSource }), {
        runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
      });
      expect(result.issues).toEqual([]);
      const row = result.rows[0]!.breakdown.find((candidate) => candidate.key_1 === client)!;
      expect(row[sourceCount === "prompt_count" ? "prompt_count" : "total_user_messages"]).toBe(sourceValue ?? null);
    }
  });

  it.each([
    ["CLI prompt_count", "totals_by_cli", "prompt_count"],
    ["Copilot App prompt_count", "totals_by_copilot_app", "prompt_count"],
    ["VS Code total_user_messages", "totals_by_vscode_agent", "total_user_messages"],
  ])("rejects invalid supplied %s values", (_label, sourceField, sourceCount) => {
    for (const value of ["5", -1, 1.5, 2_147_483_648]) {
      const result = parseMetricsDay(line({ [sourceField]: { [sourceCount]: value } }), {
        runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
      });
      expect(result.rows).toHaveLength(0);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ error_code: "negative_count", field_path: `${sourceField}.${sourceCount}` }),
      ]));
    }
  });

  it("preserves version strings through the VARCHAR(64) boundary and rejects invalid versions", () => {
    const parse = (version: unknown) => parseMetricsDay(line({ ai_adoption_phase: { phase_number: 2, phase: "Agent first", version } }), {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });
    expect(parse("v".repeat(64)).rows[0]?.daily.ai_adoption_phase_version).toBe("v".repeat(64));
    expect(parse("é".repeat(64)).rows[0]?.daily.ai_adoption_phase_version).toBe("é".repeat(64));
    expect(parse("v1").rows[0]?.daily.ai_adoption_phase_version).toBe("v1");
    expect(parse(null).rows[0]?.daily.ai_adoption_phase_version).toBeNull();
    expect(parse(undefined).rows[0]?.daily.ai_adoption_phase_version).toBeNull();
    for (const version of [1, {}, "v".repeat(65)]) {
      const result = parse(version);
      expect(result.rows).toHaveLength(0);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ error_code: "unsupported_schema", field_path: "ai_adoption_phase.version" }),
      ]));
    }
  });

  it("maps a valid day row and preserves the exact credit token", () => {
    const result = parseMetricsDay(
      `${line().replace('"loc_deleted_sum":0', '"loc_deleted_sum":0').slice(0, -1)},"ai_credits_used":999999999.999999999}\n`,
      { runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001 },
    );

    expect(result.fatal).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.daily.ai_credits_used).toBe("999999999.999999999");
    expect(result.rows[0]?.breakdown[0]?.breakdown_kind).toBe("feature");
    expect(result.rows[0]?.breakdown[0]?.code_acceptance_count).toBe(0);
    expect(result.rows[0]?.breakdown[0]?.loc_added).toBe(0);
  });

  it("preserves exact credit tokens when JSON.parse does not provide source text", () => {
    const nativeParse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      nativeParse(text, reviver
        ? function (this: unknown, key: string, value: unknown) {
          return reviver.call(this, key, value);
        }
        : undefined),
    );
    try {
      const result = parseMetricsDay(
        `${line().slice(0, -1)},"ai_credits_used":999999999.999999999}\n`,
        { runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001 },
      );
      expect(result.rows[0]?.daily.ai_credits_used).toBe("999999999.999999999");
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("maps each usage-family array from its contract-specific name field", () => {
    const families = [
      { family: "skill", field: "totals_by_skill", nameField: "skill", name: "example-skill" },
      { family: "custom_agent", field: "totals_by_custom_agent", nameField: "custom_agent", name: "example-agent" },
      { family: "mcp", field: "totals_by_mcp", nameField: "mcp", name: "example-mcp" },
      { family: "slash_cmd", field: "totals_by_slash_cmd", nameField: "slash_cmd", name: "example-command" },
      { family: "plugin", field: "totals_by_plugin", nameField: "plugin", name: "example-plugin" },
    ] as const;
    const overrides = Object.fromEntries(families.map(({ field, nameField, name }) => [
      field,
      [{ [nameField]: name, interaction_count: 1 }],
    ]));
    const result = parseMetricsDay(`${line(overrides)}\n`, {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.rows[0]?.families.map(({ family, item_name }) => [family, item_name])).toEqual(
      families.map(({ family, name }) => [family, name]),
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects missing or null required daily counts", () => {
    const requiredCounts = [
      "user_initiated_interaction_count",
      "code_generation_activity_count",
      "code_acceptance_activity_count",
      "loc_suggested_to_add_sum",
      "loc_suggested_to_delete_sum",
      "loc_added_sum",
      "loc_deleted_sum",
    ];
    const inputs = requiredCounts.flatMap((field) => [
      { content: line({ [field]: undefined }), errorCode: field.startsWith("loc_") ? "unsupported_schema" : "negative_count" },
      { content: line({ [field]: null }), errorCode: "negative_count" },
    ]);

    for (const { content, errorCode } of inputs) {
      const result = parseMetricsDay(`${content}\n`, {
        runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
      });
      expect(result.rows).toHaveLength(0);
      expect(result.issues.map((issue) => issue.error_code)).toContain(errorCode);
    }
  });

  it("quarantines a report with no records", () => {
    const result = parseMetricsDay(" \n", {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.fatal).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.issues.map((issue) => issue.error_code)).toContain("unsupported_schema");
  });

  it("treats duplicate user keys as a fatal whole-file issue", () => {
    const result = parseMetricsDay(`${line()}\n${line()}\n`, {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.fatal).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.issues.map((issue) => issue.error_code)).toContain("duplicate_file");
    expect(result.issues[0]?.raw_row_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([true, false])("detects duplicate identity when the invalid-count row comes first: %s", (invalidFirst) => {
    const valid = line();
    const invalid = line({ user_initiated_interaction_count: -1 });
    const result = parseMetricsDay(`${(invalidFirst ? [invalid, valid] : [valid, invalid]).join("\n")}\n`, {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.fatal).toBe(true);
    expect(result.issues.map((issue) => issue.error_code)).toContain("negative_count");
    expect(result.issues.map((issue) => issue.error_code)).toContain("duplicate_file");
  });

  it.each([true, false])("detects duplicate identity around an invalid client counter (invalid first: %s)", (invalidFirst) => {
    const valid = line({ totals_by_cli: { prompt_count: 5 } });
    const invalid = line({ totals_by_cli: { prompt_count: "5" } });
    const result = parseMetricsDay(`${(invalidFirst ? [invalid, valid] : [valid, invalid]).join("\n")}\n`, {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.fatal).toBe(true);
    expect(result.issues.map((issue) => issue.error_code)).toContain("negative_count");
    expect(result.issues.map((issue) => issue.error_code)).toContain("duplicate_file");
    expect(result.rows).toHaveLength(invalidFirst ? 0 : 1);
  });

  it("records rejected lines and warns on unknown fields without exposing row data", () => {
    const result = parseMetricsDay(`${line({ user_id: -1, private_marker: "private@example.com" })}\n${line({ ["private@example.com"]: "secret" })}\n`, {
      runId: "00000000-0000-4000-8000-000000000001", artifactId: 1, reportDay: "2026-03-02", organizationId: 9000001,
    });

    expect(result.fatal).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.issues.map((issue) => issue.error_code)).toEqual(["missing_user_id", "unknown_field"]);
    expect(result.issues[1]?.message).toBe("unknown top-level field");
    expect(result.issues[1]?.field_path).toBeNull();
    expect(JSON.stringify(result.issues)).not.toMatch(/private@example\.com|secret/);
    expect(result.rows[0]?.daily.extra_json).toContain('"private@example.com":"secret"');
  });
});

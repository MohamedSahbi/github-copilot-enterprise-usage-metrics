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

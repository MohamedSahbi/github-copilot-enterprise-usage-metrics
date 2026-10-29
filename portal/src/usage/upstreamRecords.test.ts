import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMetricsDay } from "../../../functions/src/metrics/day-parser";
import { aggregateMetrics } from "../../upstream/src/domain/metricsAggregator";
import { parseMetricsLines } from "../../upstream/src/domain/metricsParser";
import {
  pseudonymizeLogins,
  toUpstreamRecords,
  type CuratedBreakdownRow,
  type CuratedDailyRow,
  type CuratedFamilyRow,
} from "./upstreamRecords";

const FIXTURE = resolve(__dirname, "../../../fixtures/synthetic/users-1-day.ndjson");
const RANGE = { from: "2026-03-02", to: "2026-03-06" };

// Runs the real ingestion parser, then keys its staging rows like the curated fact tables.
function curatedRowsFromFixture(lines: string[]) {
  const daily: CuratedDailyRow[] = [];
  const breakdown: CuratedBreakdownRow[] = [];
  const families: CuratedFamilyRow[] = [];
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const { day, organization_id: org } = JSON.parse(line) as { day: string; organization_id: string };
    groups.set(`${day}|${org}`, [...(groups.get(`${day}|${org}`) ?? []), line]);
  }
  for (const [group, groupLines] of groups) {
    const [reportDay, org] = group.split("|");
    const parsed = parseMetricsDay(groupLines.join("\n"), {
      runId: "00000000-0000-4000-8000-000000000001",
      artifactId: 1,
      reportDay,
      organizationId: Number(org),
    });
    expect(parsed.fatal).toBe(false);
    for (const row of parsed.rows) {
      const key = { organization_id: row.daily.organization_id, user_id: row.daily.user_id, usage_day: row.daily.usage_day };
      daily.push(row.daily);
      breakdown.push(...row.breakdown.map((item) => ({ ...item, ...key })));
      families.push(...row.families.map((item) => ({ ...item, ...key })));
    }
  }
  return { daily, breakdown, families };
}

describe("toUpstreamRecords", () => {
  const lines = readFileSync(FIXTURE, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const upstream = parseMetricsLines(lines.map((line) => ({ line })));
  const curated = curatedRowsFromFixture(lines);
  const rebuilt = toUpstreamRecords(curated.daily, curated.breakdown, curated.families, RANGE);

  it("rebuilds one record per user and day", () => {
    expect(rebuilt).toHaveLength(upstream.length);
  });

  it("gives the upstream aggregator the same view data as the raw report", () => {
    const expected = aggregateMetrics(upstream).aggregated;
    const actual = aggregateMetrics(rebuilt).aggregated;
    // The curated facts do not keep the enterprise ID; upstream only uses it as a label.
    expect(actual.overview.stats.enterpriseId).toBeNull();
    const overview = {
      ...actual.overview,
      stats: { ...actual.overview.stats, enterpriseId: expected.overview.stats.enterpriseId },
    };
    expect({ ...actual, overview }).toEqual(expected);
  });

  it("ignores breakdown and family rows without a daily row", () => {
    const orphanBreakdown = { ...curated.breakdown[0], user_id: 1 };
    const orphanFamily = { ...curated.daily[0], family: "mcp" as const, item_name: "x", interaction_count: 1, user_id: 1 };
    const alone = toUpstreamRecords(curated.daily.slice(0, 1), [], [], RANGE);
    expect(toUpstreamRecords(curated.daily.slice(0, 1), [orphanBreakdown], [orphanFamily], RANGE)).toEqual(alone);
  });

  it("does not let extra_json override curated fields", () => {
    const [first] = curated.daily;
    const [record] = toUpstreamRecords(
      [{ ...first, extra_json: JSON.stringify({ user_id: 7, user_login: "spoof", distinct_mcp_use_count: 3 }) }],
      [],
      [],
      RANGE,
    );
    expect(record.user_id).toBe(first.user_id);
    expect(record.user_login).toBe(first.user_login);
    expect(record.distinct_mcp_use_count).toBe(3);
  });

  it("replaces logins with stable placeholders", () => {
    const aliased = pseudonymizeLogins(rebuilt);
    expect(aliased.every(({ user_login }) => /^user \d+$/.test(user_login))).toBe(true);
    const byId = new Map(aliased.map(({ user_id, user_login }) => [user_id, user_login]));
    expect(aliased.every(({ user_id, user_login }) => byId.get(user_id) === user_login)).toBe(true);
    expect(JSON.stringify(aliased)).not.toContain("example-user");
  });
});

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateMetrics } from "../../../portal/upstream/src/domain/metricsAggregator";
import { computeUserDetailedMetrics } from "../../../portal/upstream/src/domain/calculators/userDetailCalculator";
import { parseMetricsLine } from "../../../portal/upstream/src/domain/metricsParser";
import type { UserDetailedMetrics } from "../../../portal/upstream/src/types/aggregatedMetrics";
import type { UsageBreakdownRow, UsageSeriesPoint } from "../../../shared/src/api";
import type { AuthorizedUsageAccess } from "../../../portal/src/usage/api";
import { getUsageBreakdown, getUsageOverview, getUserUsage } from "../../../portal/src/usage/sql-usage";
import { loadLocalCuratedData } from "../../stack/local-curated-data";
import { TEST_CURATED_RUN_IDS } from "../../stack/test-only-curated-seed";
import { connectionString, openPool } from "../../integration/db";
import { createStagingContext, mapUsersDayLine } from "../reference/staging";
import { ORGS, WINDOW } from "../synthetic";
import { sha256Hex } from "../../stack/config";

const fixturePath = join(__dirname, "..", "..", "..", "fixtures", "synthetic", "users-1-day.ndjson");
const fixtureLines = readFileSync(fixturePath, "utf8").split("\n").filter(Boolean);
const RANGE = {
  from: WINDOW.start,
  to: WINDOW.end,
  organizationIds: ORGS.map(({ id }) => Number(id)),
};
const CORRELATION_ID = "00000000-0000-4000-8000-0000000000c4";
const PAGE_SIZE = 100;
const API_ACCESS: AuthorizedUsageAccess = {
  state: "authorized",
  breakGlass: false,
  principal: {
    principal_id: "00000000-0000-4000-8000-0000000000c4",
    entra_tenant_id: "00000000-0000-4000-8000-0000000000c4",
    entra_object_id: "00000000-0000-4000-8000-0000000000c4",
    github_user_id: null,
    status: "active",
  },
  grants: [{ role: "admin", scope: "company", scope_value: "" }],
  namesVisible: true,
};

type ApiOverview = Awaited<ReturnType<typeof getUsageOverview>>;
type ApiBreakdown = Awaited<ReturnType<typeof getUsageBreakdown>>;
type ApiUsers = Awaited<ReturnType<typeof getUserUsage>>;
type GroupedInteractions = { key: string; interactions: number; userCount: number };
type DailyTotals = Omit<UsageSeriesPoint, "day" | "activeUsers">;

let apiOverview: ApiOverview;
let apiBreakdowns: Map<UsageBreakdownRow["kind"], ApiBreakdown>;
let apiUsers: ApiUsers;
let pool: Awaited<ReturnType<typeof openPool>> | undefined;

function parseFixture(lines: readonly string[]) {
  return lines.map((line, index) => {
    const metric = parseMetricsLine(line);
    if (!metric) throw new Error(`Synthetic oracle fixture line ${index + 1} could not be parsed`);
    return metric;
  });
}

function upstreamMetrics(lines: readonly string[]) {
  return aggregateMetrics(parseFixture(lines));
}

function groupedInteractions(
  details: Map<number, UserDetailedMetrics>,
  entriesFor: (detail: UserDetailedMetrics) => readonly { key: string; interactions: number }[],
): GroupedInteractions[] {
  const groups = new Map<string, { interactions: number; users: Set<number> }>();
  for (const [userId, detail] of details) {
    for (const entry of entriesFor(detail)) {
      const group = groups.get(entry.key) ?? { interactions: 0, users: new Set<number>() };
      group.interactions += entry.interactions;
      group.users.add(userId);
      groups.set(entry.key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, interactions: group.interactions, userCount: group.users.size }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function expectedSeries(oracle: ReturnType<typeof upstreamMetrics>): UsageSeriesPoint[] {
  const totalsByDay = new Map<string, DailyTotals>();
  const details = computeUserDetailedMetrics(oracle.userDetailAccumulator);
  for (const detail of details.values()) {
    for (const day of detail.days) {
      const totals = totalsByDay.get(day.day) ?? {
        interactions: 0,
        codeGenerations: 0,
        codeAcceptances: 0,
        locAdded: 0,
        locDeleted: 0,
      };
      totals.interactions += day.user_initiated_interaction_count;
      totals.codeGenerations += day.code_generation_activity_count;
      totals.codeAcceptances += day.code_acceptance_activity_count;
      totals.locAdded += day.loc_added_sum;
      totals.locDeleted += day.loc_deleted_sum;
      totalsByDay.set(day.day, totals);
    }
  }
  const activeUsersByDay = new Map(
    oracle.aggregated.overview.engagementData.map(({ date, activeUsers }) => [date, activeUsers]),
  );
  return [...totalsByDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, totals]) => ({
      day,
      activeUsers: activeUsersByDay.get(day) ?? 0,
      ...totals,
    }));
}

function expectedBreakdown(
  kind: "feature" | "model" | "ide",
  details: Map<number, UserDetailedMetrics>,
): GroupedInteractions[] {
  if (kind === "feature") {
    return groupedInteractions(details, (detail) => detail.featureAggregates.map((entry) => ({
      key: entry.feature,
      interactions: entry.user_initiated_interaction_count,
    })));
  }
  if (kind === "model") {
    return groupedInteractions(details, (detail) => detail.modelFeatureAggregates.map((entry) => ({
      key: entry.model,
      interactions: entry.user_initiated_interaction_count,
    })));
  }
  return groupedInteractions(details, (detail) => detail.ideAggregates.map((entry) => ({
    key: entry.ide,
    interactions: entry.user_initiated_interaction_count,
  })));
}

function readBreakdown(kind: UsageBreakdownRow["kind"]): GroupedInteractions[] {
  const result = apiBreakdowns.get(kind);
  if (!result) throw new Error(`The SQL API result for ${kind} was not collected`);
  if (result.totalItems !== result.rows.length) {
    throw new Error(`The SQL API result for ${kind} was truncated by paging`);
  }
  return result.rows.map(({ suppressed, userCount, value }) => {
    if (suppressed || value === null || userCount === null) {
      throw new Error(`The oracle's aggregate-only fixture unexpectedly suppressed ${kind} data`);
    }
    expect(userCount).toBe(value.userCount);
    return { key: value.key, interactions: value.interactions, userCount: value.userCount };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function visibleGroups(rows: ApiBreakdown["rows"]): GroupedInteractions[] {
  return rows.flatMap((row) => {
    if (row.suppressed) {
      if (row.value !== null || row.userCount !== null) {
        throw new Error("A suppressed IDE row must hide both its value and user count");
      }
      return [];
    }
    if (row.value === null || row.userCount === null) {
      throw new Error("A visible IDE row must include its value and user count");
    }
    expect(row.userCount).toBe(row.value.userCount);
    return [{ key: row.value.key, interactions: row.value.interactions, userCount: row.value.userCount }];
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function expectedLanguageUsers(oracle: ReturnType<typeof upstreamMetrics>): GroupedInteractions[] {
  return oracle.aggregated.languages.languageStats
    .map(({ language, uniqueUsers }) => ({ key: language, interactions: 0, userCount: uniqueUsers }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function expectedClientUsers(details: Map<number, UserDetailedMetrics>): GroupedInteractions[] {
  return groupedInteractions(details, (detail) => {
    const clients = new Set<string>();
    for (const day of detail.days) {
      if (day.totals_by_cli != null) clients.add("copilot_cli");
      if (day.totals_by_copilot_app != null) clients.add("copilot_app");
      if (day.totals_by_vscode_agent != null) clients.add("vscode_agent");
    }
    return [...clients].map((key) => ({ key, interactions: 0 }));
  });
}

function featureBackedAppLines(userCount: number): string[] {
  const lines: string[] = [];
  const users = new Set<number>();
  const interactionsByUser = [10, 0, 3, 2, 4] as const;
  if (userCount > interactionsByUser.length) {
    throw new Error(`The feature-backed oracle scenario supports at most ${interactionsByUser.length} users`);
  }
  for (const sourceLine of fixtureLines) {
    const source = parseMetricsLine(sourceLine);
    if (!source || source.day !== WINDOW.start || users.has(source.user_id)) continue;
    users.add(source.user_id);
    const metric = structuredClone(source);
    delete metric.totals_by_copilot_app;
    metric.totals_by_ide = [];
    metric.totals_by_feature = metric.totals_by_feature.filter(({ feature }) => feature !== "copilot_app");
    const interactions = interactionsByUser[lines.length];
    if (interactions === undefined) throw new Error("No interaction value was defined for the feature-backed user");
    metric.totals_by_feature.push({
      feature: "copilot_app",
      user_initiated_interaction_count: interactions,
      code_generation_activity_count: 0,
      code_acceptance_activity_count: 0,
      loc_added_sum: 0,
      loc_deleted_sum: 0,
      loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0,
    });
    metric.used_copilot_app = true;
    lines.push(JSON.stringify(metric));
    if (lines.length === userCount) break;
  }
  if (lines.length !== userCount) {
    throw new Error(`Expected ${userCount} distinct fixture users on ${WINDOW.start}, found ${lines.length}`);
  }
  return lines;
}

function promptCountAppLines(userCount: number): { lines: string[]; persistedUserId: number } {
  const promptCounts = [2, 0, 3, 2, 3] as const;
  if (userCount !== promptCounts.length) {
    throw new Error(`The prompt-count oracle scenario requires exactly ${promptCounts.length} users`);
  }

  const metrics = fixtureLines.flatMap((line) => {
    const metric = parseMetricsLine(line);
    return metric && metric.day === WINDOW.start ? [metric] : [];
  });
  const hasAppIde = (metric: (typeof metrics)[number]): boolean =>
    metric.totals_by_ide.some(({ ide }) => ide === "copilot_app");
  const hasAppFeature = (metric: (typeof metrics)[number]): boolean =>
    metric.totals_by_feature.some(({ feature }) => feature === "copilot_app");
  const persisted = metrics.find((metric) =>
    metric.totals_by_copilot_app != null && !hasAppFeature(metric),
  );
  if (!persisted || persisted.totals_by_copilot_app?.prompt_count !== promptCounts[0]) {
    throw new Error("Expected one baseline prompt-only App row with prompt_count 2");
  }

  const candidates = metrics.filter((metric) =>
    metric.user_id !== persisted.user_id &&
    !metric.used_copilot_app &&
    metric.totals_by_copilot_app == null &&
    !hasAppIde(metric) &&
    !hasAppFeature(metric),
  );
  if (candidates.length < userCount - 1) {
    throw new Error(`Expected ${userCount - 1} fixture users without App source rows, found ${candidates.length}`);
  }

  const selected = [persisted, ...candidates.slice(0, userCount - 1)];
  const lines = selected.map((source, index) => {
    const metric = structuredClone(source);
    metric.totals_by_ide = metric.totals_by_ide.filter(({ ide }) => ide !== "copilot_app");
    metric.totals_by_feature = metric.totals_by_feature.filter(({ feature }) => feature !== "copilot_app");
    metric.totals_by_copilot_app = {
      session_count: 0,
      request_count: 0,
      prompt_count: promptCounts[index]!,
      token_usage: { output_tokens_sum: 0, prompt_tokens_sum: 0, avg_tokens_per_request: 0 },
    };
    metric.used_copilot_app = true;
    return JSON.stringify(metric);
  });
  return { lines, persistedUserId: persisted.user_id };
}

async function insertAppBreakdowns(
  lines: readonly string[],
  breakdownKind: "feature" | "client",
): Promise<{ artifactId: number; userIds: number[] }> {
  if (!pool) throw new Error("The oracle SQL pool was not opened");
  const source = `${lines.join("\n")}\n`;
  const artifactResult = await pool.request()
    .input("runId", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
    .input("blobPath", sql.NVarChar(600), `oracle/copilot-app-${breakdownKind}-${lines.length}.ndjson`)
    .input("sha256", sql.Char(64), sha256Hex(source))
    .input("sizeBytes", sql.BigInt, Buffer.byteLength(source))
    .input("rowCount", sql.Int, lines.length)
    .query<{ artifact_id: number }>(`
      INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes, row_count)
      OUTPUT inserted.artifact_id
      VALUES (@runId, N'raw', @blobPath, @sha256, @sizeBytes, @rowCount)`);
  const artifactId = Number(artifactResult.recordset[0]?.artifact_id);
  if (!Number.isSafeInteger(artifactId)) throw new Error("The generated oracle artifact was not recorded");

  const context = createStagingContext(TEST_CURATED_RUN_IDS.usage, WINDOW);
  const rows = lines.flatMap((line, index) => {
    const mapped = mapUsersDayLine(line, index + 1, context, artifactId);
    const daily = mapped.daily;
    if (!mapped.loaded || !daily) {
      throw new Error(`Copilot App oracle line ${index + 1} could not be staged`);
    }
    return mapped.breakdown
      .filter((row) => row.breakdown_kind === breakdownKind && row.key_1 === "copilot_app")
      .map((row) => ({
        organization_id: daily.organization_id,
        user_id: daily.user_id,
        usage_day: daily.usage_day,
        breakdown_kind: row.breakdown_kind,
        key_1: row.key_1,
        key_2: row.key_2,
        interaction_count: row.interaction_count,
        code_generation_count: row.code_generation_count,
        code_acceptance_count: row.code_acceptance_count,
        loc_suggested_to_add: row.loc_suggested_to_add,
        loc_suggested_to_delete: row.loc_suggested_to_delete,
        loc_added: row.loc_added,
        loc_deleted: row.loc_deleted,
        prompt_count: row.prompt_count,
        run_id: TEST_CURATED_RUN_IDS.usage,
        source_artifact_id: artifactId,
        transform_version: "1",
      }));
  });
  if (rows.length !== lines.length) {
    throw new Error(`Expected one staged Copilot App ${breakdownKind} row per oracle line, found ${rows.length}`);
  }
  await pool.request()
    .input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(`
      INSERT INTO portal.fact_usage_breakdown (
        organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
        code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, prompt_count, run_id, source_artifact_id, transform_version)
      SELECT organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
        code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, prompt_count, run_id, source_artifact_id, transform_version
      FROM OPENJSON(@rows) WITH (
        organization_id BIGINT, user_id BIGINT, usage_day DATE, breakdown_kind VARCHAR(24),
        key_1 NVARCHAR(128), key_2 NVARCHAR(128), interaction_count INT, code_generation_count INT,
        code_acceptance_count INT, loc_suggested_to_add BIGINT, loc_suggested_to_delete BIGINT,
        loc_added BIGINT, loc_deleted BIGINT, prompt_count INT, run_id UNIQUEIDENTIFIER, source_artifact_id BIGINT,
        transform_version VARCHAR(32))`);
  return { artifactId, userIds: rows.map(({ user_id }) => user_id) };
}

async function removeAppBreakdowns(
  artifactId: number,
  userIds: readonly number[],
  breakdownKind: "feature" | "client",
): Promise<void> {
  if (!pool || userIds.length === 0) return;
  const request = pool.request()
    .input("runId", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
    .input("artifactId", sql.BigInt, artifactId)
    .input("breakdownKind", sql.VarChar(24), breakdownKind);
  const userParameters = userIds.map((userId, index) => {
    const parameter = `user${index}`;
    request.input(parameter, sql.BigInt, userId);
    return `@${parameter}`;
  });
  await request.query(`
    DELETE FROM portal.fact_usage_breakdown
    WHERE run_id = @runId AND source_artifact_id = @artifactId
      AND breakdown_kind = @breakdownKind AND key_1 = N'copilot_app'
      AND user_id IN (${userParameters.join(", ")});
    DELETE FROM portal.SourceArtifact WHERE run_id = @runId AND artifact_id = @artifactId`);
}

async function insertFeatureBreakdowns(lines: readonly string[]): Promise<{ artifactId: number; userIds: number[] }> {
  return insertAppBreakdowns(lines, "feature");
}

async function removeFeatureBreakdowns(artifactId: number, userIds: readonly number[]): Promise<void> {
  return removeAppBreakdowns(artifactId, userIds, "feature");
}

function apiBreakdownRange(day: string) {
  return {
    ...RANGE,
    from: day,
    to: day,
    kind: "ide" as const,
    page: 1,
    pageSize: PAGE_SIZE,
  };
}

describe("upstream metrics oracle against curated SQL API aggregates", () => {
  const baseline = upstreamMetrics(fixtureLines);
  let detailByUser: Map<number, UserDetailedMetrics>;

  beforeAll(async () => {
    await loadLocalCuratedData(connectionString);
    pool = await openPool();
    detailByUser = computeUserDetailedMetrics(baseline.userDetailAccumulator);
    apiOverview = await getUsageOverview(pool, API_ACCESS, RANGE, CORRELATION_ID);
    apiBreakdowns = new Map();
    for (const kind of ["feature", "model", "language", "ide", "client"] as const) {
      apiBreakdowns.set(kind, await getUsageBreakdown(pool, API_ACCESS, {
        ...RANGE,
        kind,
        page: 1,
        pageSize: PAGE_SIZE,
      }, CORRELATION_ID, 1));
    }
    apiUsers = await getUserUsage(pool, API_ACCESS, {
      ...RANGE,
      page: 1,
      pageSize: PAGE_SIZE,
    }, CORRELATION_ID);
  });

  afterAll(async () => {
    if (pool) await pool.close();
  });

  it("uses the non-trivial synthetic fixture", () => {
    expect(fixtureLines.length).toBeGreaterThan(0);
    expect(baseline.aggregated.adoption.featureAdoptionData.totalUsers).toBeGreaterThan(5);
  });

  it("matches the overview series", () => {
    expect(apiOverview.series).toHaveLength(baseline.aggregated.overview.engagementData.length);
    expect(apiOverview.series.every((row) => !row.suppressed && row.value !== null)).toBe(true);
    const series = apiOverview.series.map((row) => {
      if (row.value === null) throw new Error("The oracle's aggregate-only fixture unexpectedly suppressed overview data");
      return row.value;
    });
    expect(series).toStrictEqual(expectedSeries(baseline));
  });

  it("matches all overview adoption fields", () => {
    const adoption = apiOverview.adoption;
    if (adoption.suppressed || adoption.value === null) {
      throw new Error("The oracle's aggregate-only fixture unexpectedly suppressed adoption data");
    }
    expect(adoption.value).toStrictEqual(baseline.aggregated.adoption.featureAdoptionData);
  });

  it("matches feature and model breakdowns", () => {
    expect(readBreakdown("feature")).toStrictEqual(expectedBreakdown("feature", detailByUser));
    expect(readBreakdown("model")).toStrictEqual(expectedBreakdown("model", detailByUser));
  });

  it("matches visible IDE groups and explicitly accounts for suppressed groups", () => {
    const expected = expectedBreakdown("ide", detailByUser);
    const expectedVisible = expected.filter(({ userCount }) => userCount >= 5);
    const expectedSuppressed = expected.filter(({ userCount }) => userCount < 5);
    expect(expectedSuppressed).toContainEqual({
      key: "copilot_app", interactions: 10, userCount: 1,
    });

    const result = apiBreakdowns.get("ide");
    if (!result) throw new Error("The SQL API IDE result was not collected");
    expect(result.totalItems).toBe(expected.length);
    expect(result.rows).toHaveLength(expected.length);

    const visible = result.rows.map(({ suppressed, userCount, value }) => {
      if (suppressed || value === null || userCount === null) return null;
      expect(userCount).toBe(value.userCount);
      return { key: value.key, interactions: value.interactions, userCount: value.userCount };
    }).filter((row): row is GroupedInteractions => row !== null)
      .sort((left, right) => left.key.localeCompare(right.key));
    expect(visible).toStrictEqual(expectedVisible);

    const suppressed = result.rows.filter((row) => row.suppressed);
    expect(suppressed).toHaveLength(expectedSuppressed.length);
    expect(suppressed.every(({ value, userCount }) => value === null && userCount === null)).toBe(true);
  });

  it("matches client keys and distinct users, including suppressed cohorts", () => {
    const result = apiBreakdowns.get("client");
    if (!result) throw new Error("The SQL API client result was not collected");
    const expected = expectedClientUsers(detailByUser);
    const visible = result.rows.flatMap(({ suppressed, value, userCount }) => {
      if (suppressed || value === null || userCount === null) return [];
      expect(userCount).toBe(value.userCount);
      return [{ key: value.key, interactions: value.interactions, userCount: value.userCount }];
    }).sort((a, b) => a.key.localeCompare(b.key));
    const expectedVisible = expected.filter(({ userCount }) => userCount >= 5);
    const expectedSuppressedCount = expected.length - expectedVisible.length;
    const suppressedRows = result.rows.filter(({ suppressed }) => suppressed);
    expect(result.totalItems).toBe(expected.length);
    expect(result.rows).toHaveLength(expected.length);
    expect(suppressedRows).toHaveLength(expectedSuppressedCount);
    expect(suppressedRows.every(({ value, userCount }) => value === null && userCount === null)).toBe(true);
    expect(visible).toStrictEqual(expectedVisible);
    expect(visible.every(({ interactions }) => interactions === 0)).toBe(true);
  });

  it("does not expect the one-user prompt-only App fallback to be visible", () => {
    const expectedApp = expectedBreakdown("ide", detailByUser).filter(({ key }) => key === "copilot_app");
    expect(expectedApp).toStrictEqual([{ key: "copilot_app", interactions: 10, userCount: 1 }]);
    const result = apiBreakdowns.get("ide");
    if (!result) throw new Error("The SQL API IDE result was not collected");
    expect(result.rows.some((row) => !row.suppressed && row.value?.key === "copilot_app")).toBe(false);
  });

  it("matches upstream feature-derived App IDE totals for five distinct users", async () => {
    if (!pool) throw new Error("The oracle SQL pool was not opened");
    const lines = featureBackedAppLines(5);
    const upstream = upstreamMetrics(lines);
    const expectedApp = expectedBreakdown(
      "ide",
      computeUserDetailedMetrics(upstream.userDetailAccumulator),
    ).filter(({ key }) => key === "copilot_app");
    expect(expectedApp).toStrictEqual([{ key: "copilot_app", interactions: 19, userCount: 5 }]);

    const { artifactId, userIds } = await insertFeatureBreakdowns(lines);
    try {
      const result = await getUsageBreakdown(
        pool,
        API_ACCESS,
        apiBreakdownRange(WINDOW.start),
        CORRELATION_ID,
      );
      const appRows = result.rows.filter((row) => row.value?.key === "copilot_app");
      expect(appRows).toStrictEqual([{
        suppressed: false,
        userCount: 5,
        value: { kind: "ide", key: "copilot_app", interactions: 19, userCount: 5 },
      }]);
    } finally {
      await removeFeatureBreakdowns(artifactId, userIds);
    }
  });

  it("matches upstream prompt-count-only App IDE totals for five distinct users", async () => {
    if (!pool) throw new Error("The oracle SQL pool was not opened");
    const { lines, persistedUserId } = promptCountAppLines(5);
    const upstream = upstreamMetrics(lines);
    const expectedApp = expectedBreakdown(
      "ide",
      computeUserDetailedMetrics(upstream.userDetailAccumulator),
    ).filter(({ key }) => key === "copilot_app");
    expect(expectedApp).toStrictEqual([{ key: "copilot_app", interactions: 10, userCount: 5 }]);
    const cohortUserIds = lines.map((line) => {
      const metric = parseMetricsLine(line);
      if (!metric) throw new Error("A generated prompt-count oracle line could not be parsed upstream");
      return metric.user_id;
    });
    expect(new Set(cohortUserIds).size).toBe(5);
    const additionalLines = lines.filter((_, index) => cohortUserIds[index] !== persistedUserId);
    expect(additionalLines).toHaveLength(4);
    // The fixture's first prompt row is already seeded; insert only the other four users.
    const { artifactId, userIds: insertedUserIds } = await insertAppBreakdowns(additionalLines, "client");
    try {
      const result = await getUsageBreakdown(
        pool,
        API_ACCESS,
        apiBreakdownRange(WINDOW.start),
        CORRELATION_ID,
      );
      const appRows = result.rows.filter((row) => row.value?.key === "copilot_app");
      expect(appRows).toStrictEqual([{
        suppressed: false,
        userCount: 5,
        value: { kind: "ide", key: "copilot_app", interactions: 10, userCount: 5 },
      }]);
    } finally {
      await removeAppBreakdowns(artifactId, insertedUserIds, "client");
    }
  });

  it("keeps an existing prompt-fallback App group suppressed when one-user feature data is added", async () => {
    if (!pool) throw new Error("The oracle SQL pool was not opened");
    const before = await getUsageBreakdown(pool, API_ACCESS, apiBreakdownRange(WINDOW.start), CORRELATION_ID);
    const lines = featureBackedAppLines(1);
    const featureExpected = expectedBreakdown(
      "ide",
      computeUserDetailedMetrics(upstreamMetrics(lines).userDetailAccumulator),
    ).filter(({ key }) => key === "copilot_app");
    expect(featureExpected).toStrictEqual([{ key: "copilot_app", interactions: 10, userCount: 1 }]);

    const expectedBaseline = expectedBreakdown("ide", detailByUser);
    const expectedBaselineApp = expectedBaseline.filter(({ key }) => key === "copilot_app");
    expect(expectedBaselineApp).toStrictEqual([{ key: "copilot_app", interactions: 10, userCount: 1 }]);
    const expectedSuppressedCount = expectedBaseline.filter(({ userCount }) => userCount < 5).length;
    const beforeVisible = visibleGroups(before.rows);
    expect(before.totalItems).toBe(expectedBaseline.length);
    expect(before.rows).toHaveLength(expectedBaseline.length);
    expect(before.rows.filter(({ suppressed }) => suppressed)).toHaveLength(expectedSuppressedCount);
    expect(before.rows.filter(({ suppressed }) => suppressed)
      .every(({ value, userCount }) => value === null && userCount === null)).toBe(true);
    expect(before.rows.some((row) => !row.suppressed && row.value?.key === "copilot_app")).toBe(false);

    const { artifactId, userIds } = await insertFeatureBreakdowns(lines);
    try {
      const after = await getUsageBreakdown(pool, API_ACCESS, apiBreakdownRange(WINDOW.start), CORRELATION_ID);
      expect(after.totalItems).toBe(before.totalItems);
      expect(after.rows).toHaveLength(after.totalItems);
      expect(after.rows.filter((row) => row.suppressed)).toHaveLength(expectedSuppressedCount);
      expect(after.rows.filter(({ suppressed }) => suppressed)
        .every(({ value, userCount }) => value === null && userCount === null)).toBe(true);
      const afterVisible = visibleGroups(after.rows);
      expect(afterVisible).toStrictEqual(beforeVisible);
      expect(after.rows.some((row) => !row.suppressed && row.value?.key === "copilot_app")).toBe(false);
    } finally {
      await removeFeatureBreakdowns(artifactId, userIds);
    }
  });

  it("matches language dimension keys and distinct user counts", () => {
    const languageRows = readBreakdown("language");
    expect(languageRows.map(({ key, userCount }) => ({ key, userCount })))
      .toStrictEqual(expectedLanguageUsers(baseline).map(({ key, userCount }) => ({ key, userCount })));
    expect(languageRows.every(({ interactions }) => interactions === 0)).toBe(true);
  });

  it("matches per-user active days, interactions, and AI credits", () => {
    const expectedUsers = baseline.aggregated.users.userSummaries
      .map((user) => ({
        userId: user.user_id,
        daysActive: user.days_active,
        interactions: user.total_user_initiated_interactions,
        aiCreditsUsed: user.total_ai_credits_used,
      }))
      .sort((a, b) => a.userId - b.userId);
    const actualUsers = [...apiUsers.rows]
      .map(({ userId, daysActive, interactions, aiCreditsUsed }) => ({
        userId,
        daysActive,
        interactions,
        aiCreditsUsed,
      }))
      .sort((a, b) => a.userId - b.userId);
    const usersWithoutCredits = (
      users: readonly Pick<(typeof actualUsers)[number], "userId" | "daysActive" | "interactions">[],
    ) =>
      users.map(({ userId, daysActive, interactions }) => ({ userId, daysActive, interactions }));
    expect(apiUsers.totalItems).toBe(expectedUsers.length);
    expect(usersWithoutCredits(actualUsers)).toStrictEqual(usersWithoutCredits(expectedUsers));
    actualUsers.forEach((user, index) => {
      expect(user.aiCreditsUsed).toBeCloseTo(expectedUsers[index]!.aiCreditsUsed, 9);
    });
  });

  it("rejects a deliberately changed fixture metric", () => {
    const changedFixture = parseFixture(fixtureLines);
    const firstMetric = changedFixture[0];
    if (!firstMetric) throw new Error("The synthetic oracle fixture is empty");
    firstMetric.user_initiated_interaction_count += 1;

    const changedOracle = aggregateMetrics(changedFixture);
    const changedUsers = changedOracle.aggregated.users.userSummaries
      .map((user) => ({
        userId: user.user_id,
        interactions: user.total_user_initiated_interactions,
      }))
      .sort((a, b) => a.userId - b.userId);
    const actualUsers = apiUsers.rows
      .map(({ userId, interactions }) => ({ userId, interactions }))
      .sort((a, b) => a.userId - b.userId);

    expect(changedUsers).not.toStrictEqual(actualUsers);
    expect(() => assert.deepStrictEqual(actualUsers, changedUsers, "SQL user interactions must match upstream"))
      .toThrow(/SQL user interactions must match upstream/);
  });
});

import {
  DEFAULT_MIN_GROUP_SIZE,
  suppressForScope,
  type Meta,
  type Suppressible,
  type DateRange,
  type UsageBreakdownResponse,
  type UsageBreakdownRow,
  type UsageOverviewResponse,
  type UsageSeriesPoint,
  type UserUsageResponse,
} from "../../../shared/src/api";
import type { Scope } from "../../../shared/src/rows";
import type { AggregatedMetrics } from "../../upstream/src/types/aggregatedMetrics";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";

export interface FixtureCoreData {
  aggregatedMetrics: AggregatedMetrics;
  overview: UsageOverviewResponse;
  breakdowns: Record<UsageBreakdownRow["kind"], UsageBreakdownResponse>;
  users: UserUsageResponse | null;
  visibleUserCount: number;
  suppressed: boolean;
}

export interface FixtureApiInput {
  request: DateRange;
  scope: Scope;
  metrics: CopilotMetrics[];
  aggregatedMetrics: AggregatedMetrics;
  perUserDetailEnabled: boolean;
}

function createMeta(): Meta {
  return {
    correlationId: "synthetic-fixture",
    generatedAt: new Date().toISOString(),
    minGroupSize: DEFAULT_MIN_GROUP_SIZE,
    metricVersion: 1,
  };
}

function usageSeries(metrics: CopilotMetrics[]): UsageSeriesPoint[] {
  const byDay = new Map<string, CopilotMetrics[]>();
  for (const metric of metrics) {
    byDay.set(metric.day, [...(byDay.get(metric.day) ?? []), metric]);
  }
  return [...byDay].sort(([left], [right]) => left.localeCompare(right)).map(([day, rows]) => ({
    day,
    activeUsers: new Set(rows.map(({ user_id }) => user_id)).size,
    interactions: rows.reduce((total, row) => total + row.user_initiated_interaction_count, 0),
    codeGenerations: rows.reduce((total, row) => total + row.code_generation_activity_count, 0),
    codeAcceptances: rows.reduce((total, row) => total + row.code_acceptance_activity_count, 0),
    locAdded: rows.reduce((total, row) => total + row.loc_added_sum, 0),
    locDeleted: rows.reduce((total, row) => total + row.loc_deleted_sum, 0),
  }));
}

function breakdownRows(
  metrics: CopilotMetrics[],
  kind: UsageBreakdownRow["kind"],
): UsageBreakdownRow[] {
  const counts = new Map<string, { interactions: number; users: Set<number> }>();
  for (const metric of metrics) {
    const entries = kind === "feature"
      ? metric.totals_by_feature.map(({ feature: key, user_initiated_interaction_count: interactions }) => ({ key, interactions }))
      : kind === "model"
        ? metric.totals_by_model_feature.map(({ model: key, user_initiated_interaction_count: interactions }) => ({ key, interactions }))
        : kind === "client" || kind === "ide"
          ? metric.totals_by_ide.map(({ ide: key, user_initiated_interaction_count: interactions }) => ({ key, interactions }))
          : metric.totals_by_language_feature.map(({ language: key, code_generation_activity_count: interactions }) => ({ key, interactions }));

    for (const { key, interactions } of entries) {
      const current = counts.get(key) ?? { interactions: 0, users: new Set<number>() };
      current.interactions += interactions;
      current.users.add(metric.user_id);
      counts.set(key, current);
    }
  }
  return [...counts].map(([key, value]) => ({
    kind,
    key,
    interactions: value.interactions,
    userCount: value.users.size,
  }));
}

function suppressibleRows(
  rows: UsageBreakdownRow[],
  scope: Scope,
  namesVisible: boolean,
): Suppressible<UsageBreakdownRow>[] {
  return rows.map((row) => suppressForScope(scope, row.userCount, DEFAULT_MIN_GROUP_SIZE, row, namesVisible));
}

export function toFixtureCoreData(input: FixtureApiInput): FixtureCoreData {
  const { metrics, aggregatedMetrics, request, scope, perUserDetailEnabled } = input;
  const users = new Set(metrics.map(({ user_id }) => user_id));
  const visibleUserCount = users.size;
  const suppressed = visibleUserCount < DEFAULT_MIN_GROUP_SIZE && !perUserDetailEnabled;
  const meta = createMeta();
  const visibleMetrics = aggregatedMetrics;
  visibleMetrics.overview.stats.enterpriseId = null;
  if (!perUserDetailEnabled) visibleMetrics.users.userSummaries = [];

  const series = usageSeries(metrics)
    .filter(({ day }) => day >= request.from && day <= request.to)
    .map((point) => suppressForScope(scope, point.activeUsers, DEFAULT_MIN_GROUP_SIZE, point, perUserDetailEnabled));
  const adoption = suppressForScope(
    scope,
    visibleMetrics.adoption.featureAdoptionData.totalUsers,
    DEFAULT_MIN_GROUP_SIZE,
    visibleMetrics.adoption.featureAdoptionData,
    perUserDetailEnabled,
  );
  const overview: UsageOverviewResponse = {
    meta,
    data: {
      series,
      adoption,
    },
  };

  const breakdowns = {
    feature: "feature",
    model: "model",
    client: "client",
    language: "language",
    ide: "ide",
  } as const;
  const breakdownResponses = Object.fromEntries(
    Object.entries(breakdowns).map(([kind, value]) => {
      const rows = suppressibleRows(breakdownRows(metrics, value), scope, perUserDetailEnabled);
      return [kind, {
        meta,
        data: rows,
        page: { page: 1, pageSize: rows.length || 1, totalItems: rows.length },
      }];
    }),
  ) as FixtureCoreData["breakdowns"];

  const userSummaries = perUserDetailEnabled
    ? aggregatedMetrics.users.userSummaries.map((user) => ({
        userId: user.user_id,
        login: user.user_login,
        daysActive: user.days_active,
        interactions: user.total_user_initiated_interactions,
        aiCreditsUsed: String(user.total_ai_credits_used),
      }))
    : [];
  const userResponse: UserUsageResponse | null = perUserDetailEnabled ? {
    meta,
    data: userSummaries,
    page: { page: 1, pageSize: userSummaries.length || 1, totalItems: userSummaries.length },
  } : null;

  return {
    aggregatedMetrics: visibleMetrics,
    overview,
    breakdowns: breakdownResponses,
    users: userResponse,
    visibleUserCount,
    suppressed,
  };
}

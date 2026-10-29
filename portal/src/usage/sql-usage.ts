import sql from "mssql";
import {
  DEFAULT_MIN_GROUP_SIZE,
  suppressForScope,
  type AdoptionSummary,
  type DateRange,
  type Suppressible,
  validateUsagePeriod,
  type UsagePeriodRequest,
  type UsageBreakdownRequest,
  type UsageBreakdownRow,
  type UsageOverviewResponse,
  type UsageSeriesPoint,
  type UserUsageRow,
} from "../../../shared/src/api";
import { FEATURE_TAXONOMY } from "../../../shared/src/features";
import type { Scope } from "../../../shared/src/rows";
import type { AuthorizedUsageAccess } from "./api";
import { bindTeamFreshness, eligibleManagerEdge } from "../authz/sql-team-freshness";
import type { CuratedBreakdownRow, CuratedDailyRow, CuratedFamilyRow } from "./curatedRows";

interface ScopedRequest {
  request: sql.Request;
  cte: string;
}

export async function resolveUsageRange(
  pool: sql.ConnectionPool,
  period: UsagePeriodRequest,
): Promise<{ ok: true; range: DateRange & { organizationIds?: number[] } } | { ok: false }> {
  const result = await pool.request().query<{ latestUsageDay: Date | null }>(`
    SELECT MAX(usage_day) AS latestUsageDay
    FROM portal.fact_user_daily_usage
  `);
  const latestUsageDay = result.recordset[0]?.latestUsageDay;
  if (!latestUsageDay) throw new Error("No curated usage data is available");

  const latestCompleteDay = latestUsageDay.toISOString().slice(0, 10);
  const validation = validateUsagePeriod(period, latestCompleteDay);
  if (!validation.ok) return { ok: false };
  return {
    ok: true,
    range: {
      ...validation.range,
      ...(period.organizationIds ? { organizationIds: period.organizationIds } : {}),
    },
  };
}

function scopedRequest(
  pool: sql.ConnectionPool,
  access: AuthorizedUsageAccess,
  correlationId: string,
  organizationIds: readonly number[] = [],
): ScopedRequest {
  const request = pool.request()
    .input("principalEntraObjectId", sql.UniqueIdentifier, access.principal.entra_object_id)
    .input("correlationId", sql.UniqueIdentifier, correlationId)
    .input("organizationIds", sql.NVarChar(sql.MAX), JSON.stringify(organizationIds));
  bindTeamFreshness(request);
  const grantValues = access.grants.map((grant, index) => {
    request.input(`scope${index}`, sql.VarChar(24), grant.scope);
    request.input(`scopeValue${index}`, sql.NVarChar(128), grant.scope_value);
    return `SELECT @scope${index} AS scope, @scopeValue${index} AS scope_value`;
  });
  const cte = `
    WITH ScopeGrants AS (
      ${grantValues.join("\n      UNION ALL\n      ")}
    ),
    TeamMembers (user_id, manager_object_id, visited) AS (
      SELECT CAST(NULL AS BIGINT), @principalEntraObjectId,
        CAST('|' + LOWER(CONVERT(VARCHAR(36), @principalEntraObjectId)) + '|' AS VARCHAR(MAX))
      UNION ALL
      SELECT u.user_id, u.entra_object_id,
        CAST(tm.visited + CASE WHEN u.entra_object_id IS NULL THEN ''
          ELSE LOWER(CONVERT(VARCHAR(36), u.entra_object_id)) + '|' END AS VARCHAR(MAX))
      FROM portal.dim_user AS u
      INNER JOIN TeamMembers AS tm ON u.manager_entra_object_id = tm.manager_object_id
      WHERE u.state = 'active'
        AND ${eligibleManagerEdge("u")}
        AND (u.entra_object_id IS NULL OR CHARINDEX(
          '|' + LOWER(CONVERT(VARCHAR(36), u.entra_object_id)) + '|', tm.visited
        ) = 0)
    ),
    AuthorizedUsers AS (
      SELECT u.user_id
      FROM portal.dim_user AS u
      WHERE u.state = 'active'
        AND EXISTS (
          SELECT 1 FROM ScopeGrants AS g
          WHERE g.scope = 'company'
            OR (g.scope = 'self' AND u.entra_object_id = @principalEntraObjectId)
            OR (g.scope = 'team' AND EXISTS (
              SELECT 1 FROM TeamMembers AS tm WHERE tm.user_id = u.user_id
            ))
            OR (g.scope = 'department' AND u.department = g.scope_value)
            OR (g.scope = 'business_area' AND u.business_area = g.scope_value)
        )
    )`;
  return { request, cte };
}

function bindRange(request: sql.Request, range: DateRange): void {
  request.input("fromDay", sql.Date, new Date(`${range.from}T00:00:00.000Z`));
  request.input("toDay", sql.Date, new Date(`${range.to}T00:00:00.000Z`));
}

function organizationFilter(alias: string): string {
  return `(
    NOT EXISTS (SELECT 1 FROM OPENJSON(@organizationIds))
    OR EXISTS (
      SELECT 1 FROM OPENJSON(@organizationIds) AS requested
      WHERE TRY_CONVERT(BIGINT, requested.[value]) = ${alias}.organization_id
    )
  )`;
}

function number(value: number | string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function seriesSuppression(
  scopes: readonly Scope[],
  userCount: number,
  value: UsageSeriesPoint,
  minGroupSize: number,
): Suppressible<UsageSeriesPoint> {
  let result: Suppressible<UsageSeriesPoint> = { suppressed: false, userCount, value };
  for (const scope of scopes) {
    result = suppressForScope(scope, userCount, minGroupSize, value, false);
    if (result.suppressed) break;
  }
  return result;
}

function adoptionSuppression(
  scopes: readonly Scope[],
  userCount: number,
  value: AdoptionSummary,
  minGroupSize: number,
): Suppressible<AdoptionSummary> {
  let result: Suppressible<AdoptionSummary> = { suppressed: false, userCount, value };
  for (const scope of scopes) {
    result = suppressForScope(scope, userCount, minGroupSize, value, false);
    if (result.suppressed) break;
  }
  return result;
}

export async function getUsageOverview(
  pool: sql.ConnectionPool,
  access: AuthorizedUsageAccess,
  range: DateRange & { organizationIds?: number[] },
  correlationId: string,
  minGroupSize = DEFAULT_MIN_GROUP_SIZE,
): Promise<UsageOverviewResponse["data"]> {
  const scoped = scopedRequest(pool, access, correlationId, range.organizationIds);
  bindRange(scoped.request, range);
  const seriesResult = await scoped.request.query<{
    day: Date;
    activeUsers: number;
    interactions: number;
    codeGenerations: number;
    codeAcceptances: number;
    locAdded: number;
    locDeleted: number;
  }>(`${scoped.cte}
    SELECT f.usage_day AS day, COUNT(DISTINCT f.user_id) AS activeUsers,
      SUM(f.interaction_count) AS interactions, SUM(f.code_generation_count) AS codeGenerations,
      SUM(f.code_acceptance_count) AS codeAcceptances, SUM(f.loc_added) AS locAdded,
      SUM(f.loc_deleted) AS locDeleted
    FROM portal.fact_user_daily_usage AS f
    INNER JOIN AuthorizedUsers AS au ON au.user_id = f.user_id
    WHERE f.usage_day BETWEEN @fromDay AND @toDay
      AND ${organizationFilter("f")}
    GROUP BY f.usage_day
    ORDER BY f.usage_day
    OPTION (MAXRECURSION 100)`);

  const adoptionRequest = scopedRequest(pool, access, correlationId, range.organizationIds);
  bindRange(adoptionRequest.request, range);
  const features = Object.entries(FEATURE_TAXONOMY);
  const featureValues = features.map(([feature, taxonomy], index) => {
    adoptionRequest.request.input(`feature${index}`, sql.NVarChar(128), feature);
    adoptionRequest.request.input(`featureChat${index}`, sql.Bit, taxonomy.isChat);
    adoptionRequest.request.input(`featureAgent${index}`, sql.Bit, taxonomy.isAgent);
    adoptionRequest.request.input(`featureBucket${index}`, sql.VarChar(8), taxonomy.chatModeBucket ?? "");
    adoptionRequest.request.input(`featureCompletion${index}`, sql.Bit, feature === "code_completion");
    return `SELECT @feature${index} AS feature, @featureChat${index} AS is_chat,
      @featureAgent${index} AS is_agent, @featureBucket${index} AS mode_bucket,
      @featureCompletion${index} AS is_completion`;
  });
  const adoptionResult = await adoptionRequest.request.query<Record<string, number | null>>(`${scoped.cte},
    FeatureTaxonomy AS (
      ${featureValues.join("\n      UNION ALL\n      ")}
    ),
    FeatureSignals AS (
      SELECT b.user_id,
        MAX(CASE WHEN t.is_chat = 1 THEN 1 ELSE 0 END) AS chat,
        MAX(CASE WHEN t.is_agent = 1 THEN 1 ELSE 0 END) AS agent,
        MAX(CASE WHEN t.mode_bucket = 'ask' THEN 1 ELSE 0 END) AS ask_mode,
        MAX(CASE WHEN t.mode_bucket = 'inline' THEN 1 ELSE 0 END) AS inline_mode,
        MAX(CASE WHEN t.mode_bucket = 'plan' THEN 1 ELSE 0 END) AS plan_mode,
        MAX(CASE WHEN t.is_completion = 1 THEN 1 ELSE 0 END) AS completion
      FROM portal.fact_usage_breakdown AS b
      INNER JOIN AuthorizedUsers AS au ON au.user_id = b.user_id
      INNER JOIN FeatureTaxonomy AS t ON t.feature = b.key_1
      WHERE b.breakdown_kind = 'feature' AND b.usage_day BETWEEN @fromDay AND @toDay
        AND (b.interaction_count > 0 OR b.code_generation_count > 0)
        AND ${organizationFilter("b")}
      GROUP BY b.user_id
    ),
    DailySignals AS (
      SELECT f.user_id, MAX(CONVERT(INT, f.used_cli)) AS cli,
        MAX(CONVERT(INT, f.used_copilot_app)) AS app,
        MAX(CONVERT(INT, f.used_vscode_agent)) AS vscode_agent,
        MAX(CONVERT(INT, f.used_cloud_agent)) AS coding_agent,
        MAX(CONVERT(INT, CASE WHEN f.used_code_review_active = 1 OR f.used_code_review_passive = 1 THEN 1 ELSE 0 END)) AS review
      FROM portal.fact_user_daily_usage AS f
      INNER JOIN AuthorizedUsers AS au ON au.user_id = f.user_id
      WHERE f.usage_day BETWEEN @fromDay AND @toDay
        AND ${organizationFilter("f")}
      GROUP BY f.user_id
    ),
    UserSignals AS (
      SELECT d.user_id, COALESCE(s.completion, 0) AS completion,
        COALESCE(s.chat, 0) AS chat, COALESCE(s.agent, 0) AS agent,
        COALESCE(s.ask_mode, 0) AS ask_mode, COALESCE(s.inline_mode, 0) AS inline_mode,
        COALESCE(s.plan_mode, 0) AS plan_mode, d.cli, d.app, d.vscode_agent,
        d.coding_agent, d.review
      FROM DailySignals AS d
      LEFT JOIN FeatureSignals AS s ON s.user_id = d.user_id
    ),
    Population AS (
      SELECT * FROM UserSignals
      WHERE completion = 1 OR chat = 1 OR agent = 1 OR cli = 1 OR app = 1
        OR vscode_agent = 1 OR coding_agent = 1 OR review = 1
    )
    SELECT COUNT(*) AS totalUsers, SUM(completion) AS completionUsers,
      SUM(CASE WHEN completion = 1 AND chat = 0 AND agent = 0 AND cli = 0 AND app = 0
        AND vscode_agent = 0 AND coding_agent = 0 AND review = 0 THEN 1 ELSE 0 END) AS completionOnlyUsers,
      SUM(chat) AS chatUsers, SUM(agent) AS agentModeUsers, SUM(ask_mode) AS askModeUsers,
      SUM(inline_mode) AS inlineModeUsers, SUM(plan_mode) AS planModeUsers, SUM(cli) AS cliUsers,
      SUM(app) AS appUsers, SUM(vscode_agent) AS vscodeAgentUsers,
      SUM(coding_agent) AS codingAgentUsers, SUM(review) AS codeReviewUsers,
      SUM(CASE WHEN agent = 1 OR cli = 1 OR vscode_agent = 1 OR coding_agent = 1 THEN 1 ELSE 0 END) AS advancedUsers
    FROM Population
    OPTION (MAXRECURSION 100)`);

  const adoptionRow = adoptionResult.recordset[0] ?? {};
  const adoption: AdoptionSummary = {
    totalUsers: number(adoptionRow.totalUsers),
    completionUsers: number(adoptionRow.completionUsers),
    completionOnlyUsers: number(adoptionRow.completionOnlyUsers),
    chatUsers: number(adoptionRow.chatUsers),
    agentModeUsers: number(adoptionRow.agentModeUsers),
    askModeUsers: number(adoptionRow.askModeUsers),
    inlineModeUsers: number(adoptionRow.inlineModeUsers),
    planModeUsers: number(adoptionRow.planModeUsers),
    cliUsers: number(adoptionRow.cliUsers),
    appUsers: number(adoptionRow.appUsers),
    vscodeAgentUsers: number(adoptionRow.vscodeAgentUsers),
    codingAgentUsers: number(adoptionRow.codingAgentUsers),
    codeReviewUsers: number(adoptionRow.codeReviewUsers),
    advancedUsers: number(adoptionRow.advancedUsers),
  };
  const scopes = [...new Set(access.grants.map((grant) => grant.scope))];
  const series = seriesResult.recordset.map((row) => {
    const value: UsageSeriesPoint = {
      day: row.day.toISOString().slice(0, 10),
      activeUsers: number(row.activeUsers),
      interactions: number(row.interactions),
      codeGenerations: number(row.codeGenerations),
      codeAcceptances: number(row.codeAcceptances),
      locAdded: number(row.locAdded),
      locDeleted: number(row.locDeleted),
    };
    return seriesSuppression(scopes, value.activeUsers, value, minGroupSize);
  });
  return {
    series,
    adoption: adoptionSuppression(scopes, adoption.totalUsers, adoption, minGroupSize),
  };
}

const breakdownTableKind: Record<UsageBreakdownRequest["kind"], string> = {
  feature: "feature",
  model: "model_feature",
  client: "client",
  language: "language_feature",
  ide: "ide",
};

export async function getUsageBreakdown(
  pool: sql.ConnectionPool,
  access: AuthorizedUsageAccess,
  input: DateRange & { organizationIds?: number[]; kind: UsageBreakdownRequest["kind"]; page: number; pageSize: number },
  correlationId: string,
  minGroupSize = DEFAULT_MIN_GROUP_SIZE,
): Promise<{ rows: Suppressible<UsageBreakdownRow>[]; totalItems: number }> {
  const scoped = scopedRequest(pool, access, correlationId, input.organizationIds);
  bindRange(scoped.request, input);
  const offset = (input.page - 1) * input.pageSize;
  scoped.request.input("breakdownKind", sql.VarChar(24), breakdownTableKind[input.kind])
    .input("offset", sql.BigInt, offset)
    .input("pageSize", sql.Int, input.pageSize);
  const groupedCte = `ScopedBreakdowns AS (
    SELECT b.organization_id, b.usage_day, b.user_id, b.breakdown_kind, b.key_1, b.interaction_count, b.prompt_count
    FROM portal.fact_usage_breakdown AS b
    INNER JOIN AuthorizedUsers AS au ON au.user_id = b.user_id
    WHERE b.usage_day BETWEEN @fromDay AND @toDay
     AND ${input.kind === "ide" ? "b.breakdown_kind IN ('ide', 'feature', 'client')" : "b.breakdown_kind = @breakdownKind"}
      AND ${organizationFilter("b")}
  ),
  ${input.kind === "ide" ? `AppFeatures AS (
    SELECT organization_id, usage_day, user_id, SUM(interaction_count) AS interaction_count
    FROM ScopedBreakdowns
    WHERE breakdown_kind = 'feature' AND key_1 = N'copilot_app'
    GROUP BY organization_id, usage_day, user_id
  ),
  AppClients AS (
    SELECT organization_id, usage_day, user_id, MAX(prompt_count) AS prompt_count
    FROM ScopedBreakdowns
    WHERE breakdown_kind = 'client' AND key_1 = N'copilot_app'
    GROUP BY organization_id, usage_day, user_id
  ),
  AppFallbacks AS (
    SELECT organization_id, usage_day, user_id, prompt_count AS interaction_count
    FROM AppClients
    WHERE prompt_count IS NOT NULL
  ),
  IdeRows AS (
    SELECT b.key_1, b.user_id,
      CASE WHEN b.key_1 = N'copilot_app' AND b.interaction_count <= 0
        THEN ISNULL(c.prompt_count, b.interaction_count)
        ELSE b.interaction_count
      END AS interaction_count
    FROM ScopedBreakdowns AS b
    LEFT JOIN AppClients AS c
      ON c.organization_id = b.organization_id AND c.usage_day = b.usage_day
        AND c.user_id = b.user_id
    WHERE b.breakdown_kind = 'ide'
      AND (b.key_1 <> N'copilot_app' OR NOT EXISTS (
        SELECT 1 FROM AppFeatures AS a
        WHERE a.organization_id = b.organization_id AND a.usage_day = b.usage_day
          AND a.user_id = b.user_id
      ))
    UNION ALL
    SELECT N'copilot_app', user_id, interaction_count FROM AppFeatures
    UNION ALL
    SELECT N'copilot_app', f.user_id, f.interaction_count
    FROM AppFallbacks AS f
    WHERE NOT EXISTS (
      SELECT 1 FROM ScopedBreakdowns AS b
      WHERE b.organization_id = f.organization_id AND b.usage_day = f.usage_day
        AND b.user_id = f.user_id AND b.breakdown_kind = 'ide' AND b.key_1 = N'copilot_app'
    )
      AND NOT EXISTS (
        SELECT 1 FROM AppFeatures AS a
        WHERE a.organization_id = f.organization_id AND a.usage_day = f.usage_day
          AND a.user_id = f.user_id
      )
  ),
  ` : ""}Grouped AS (
    SELECT key_1 AS [key], SUM(interaction_count) AS interactions,
      COUNT(DISTINCT user_id) AS userCount
    FROM ${input.kind === "ide" ? "IdeRows" : "ScopedBreakdowns"}
    GROUP BY key_1
  )`;
  const result = await scoped.request.query<{ key: string; interactions: number; userCount: number; totalItems: number }>(`${scoped.cte},
    ${groupedCte}
    SELECT [key], interactions, userCount, COUNT(*) OVER() AS totalItems
    FROM Grouped
    ORDER BY [key]
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    OPTION (MAXRECURSION 100)`);
  let totalItems = result.recordset.length ? number(result.recordset[0]!.totalItems) : 0;
  if (!result.recordset.length) {
    const countScoped = scopedRequest(pool, access, correlationId, input.organizationIds);
    bindRange(countScoped.request, input);
    countScoped.request.input("breakdownKind", sql.VarChar(24), breakdownTableKind[input.kind]);
    const count = await countScoped.request.query<{ totalItems: number }>(`${countScoped.cte},
      ${groupedCte}
      SELECT COUNT(*) AS totalItems FROM Grouped
      OPTION (MAXRECURSION 100)`);
    totalItems = number(count.recordset[0]?.totalItems);
  }
  const scopes = [...new Set(access.grants.map((grant) => grant.scope))];
  const rows = result.recordset.map((row) => {
    const value: UsageBreakdownRow = {
      kind: input.kind,
      key: row.key,
      interactions: number(row.interactions),
      userCount: number(row.userCount),
    };
    let suppression: Suppressible<UsageBreakdownRow> = {
      suppressed: false,
      userCount: value.userCount,
      value,
    };
    for (const scope of scopes) {
      suppression = suppressForScope(scope, value.userCount, minGroupSize, value, false);
      if (suppression.suppressed) break;
    }
    return suppression;
  });
  return { rows, totalItems };
}

export async function getUserUsage(
  pool: sql.ConnectionPool,
  access: AuthorizedUsageAccess,
  input: DateRange & { organizationIds?: number[]; page: number; pageSize: number },
  correlationId: string,
): Promise<{ rows: UserUsageRow[]; totalItems: number }> {
  const scoped = scopedRequest(pool, access, correlationId, input.organizationIds);
  bindRange(scoped.request, input);
  const offset = (input.page - 1) * input.pageSize;
  scoped.request.input("offset", sql.BigInt, offset).input("pageSize", sql.Int, input.pageSize);
  const result = await scoped.request.query<{
    userId: number;
    login: string | null;
    daysActive: number;
    interactions: number;
    aiCreditsUsed: string;
    totalItems: number;
  }>(`${scoped.cte},
    UserUsage AS (
      SELECT f.user_id AS userId, u.login, COUNT(DISTINCT f.usage_day) AS daysActive,
        SUM(f.interaction_count) AS interactions,
        CONVERT(VARCHAR(40), SUM(f.ai_credits_used)) AS aiCreditsUsed
      FROM portal.fact_user_daily_usage AS f
      INNER JOIN AuthorizedUsers AS au ON au.user_id = f.user_id
      INNER JOIN portal.dim_user AS u ON u.user_id = f.user_id
      WHERE f.usage_day BETWEEN @fromDay AND @toDay
        AND ${organizationFilter("f")}
      GROUP BY f.user_id, u.login
    )
    SELECT userId, login, daysActive, interactions, aiCreditsUsed, COUNT(*) OVER() AS totalItems
    FROM UserUsage
    ORDER BY userId
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    OPTION (MAXRECURSION 100)`);
  let totalItems = result.recordset.length ? number(result.recordset[0]!.totalItems) : 0;
  if (!result.recordset.length) {
    const countScoped = scopedRequest(pool, access, correlationId, input.organizationIds);
    bindRange(countScoped.request, input);
    const count = await countScoped.request.query<{ totalItems: number }>(`${countScoped.cte},
      UserUsage AS (
        SELECT f.user_id
        FROM portal.fact_user_daily_usage AS f
        INNER JOIN AuthorizedUsers AS au ON au.user_id = f.user_id
        WHERE f.usage_day BETWEEN @fromDay AND @toDay
          AND ${organizationFilter("f")}
        GROUP BY f.user_id
      )
      SELECT COUNT(*) AS totalItems FROM UserUsage
      OPTION (MAXRECURSION 100)`);
    totalItems = number(count.recordset[0]?.totalItems);
  }
  return {
    rows: result.recordset.map((row) => ({
      userId: number(row.userId),
      login: row.login,
      daysActive: number(row.daysActive),
      interactions: number(row.interactions),
      aiCreditsUsed: row.aiCreditsUsed,
    })),
    totalItems,
  };
}

const DAY = "CONVERT(CHAR(10), {alias}.usage_day, 23) AS usage_day";

/**
 * Curated per-user daily rows for the authorized scope, shaped for `toUpstreamRecords`.
 * Callers own suppression: these rows are for server-side aggregation only.
 */
export async function getScopedCuratedRows(
  pool: sql.ConnectionPool,
  access: AuthorizedUsageAccess,
  range: DateRange & { organizationIds?: number[] },
  correlationId: string,
): Promise<{ daily: CuratedDailyRow[]; breakdown: CuratedBreakdownRow[]; families: CuratedFamilyRow[] }> {
  const query = async <T>(select: string): Promise<T[]> => {
    const scoped = scopedRequest(pool, access, correlationId, range.organizationIds);
    bindRange(scoped.request, range);
    const result = await scoped.request.query<T>(`${scoped.cte}
      ${select}
      OPTION (MAXRECURSION 100)`);
    return result.recordset;
  };
  const daily = await query<CuratedDailyRow>(`
    SELECT f.organization_id, f.user_id, u.login AS user_login, ${DAY.replace("{alias}", "f")},
      f.interaction_count, f.code_generation_count, f.code_acceptance_count,
      f.loc_suggested_to_add, f.loc_suggested_to_delete, f.loc_added, f.loc_deleted,
      f.used_agent, f.used_chat, f.used_cli, f.used_cloud_agent, f.used_copilot_app, f.used_vscode_agent,
      f.used_code_review_active, f.used_code_review_passive,
      CONVERT(VARCHAR(40), f.ai_credits_used) AS ai_credits_used,
      f.ai_adoption_phase_number, f.ai_adoption_phase, f.ai_adoption_phase_version, f.extra_json
    FROM portal.fact_user_daily_usage AS f
    INNER JOIN AuthorizedUsers AS au ON au.user_id = f.user_id
    INNER JOIN portal.dim_user AS u ON u.user_id = f.user_id
    WHERE f.usage_day BETWEEN @fromDay AND @toDay
      AND ${organizationFilter("f")}`);
  const breakdown = await query<CuratedBreakdownRow>(`
    SELECT b.organization_id, b.user_id, ${DAY.replace("{alias}", "b")}, b.breakdown_kind, b.key_1, b.key_2,
      b.interaction_count, b.code_generation_count, b.code_acceptance_count,
      b.loc_suggested_to_add, b.loc_suggested_to_delete, b.loc_added, b.loc_deleted,
      b.session_count, b.request_count, b.prompt_tokens, b.output_tokens, b.version_info,
      b.prompt_count, b.total_user_messages
    FROM portal.fact_usage_breakdown AS b
    INNER JOIN AuthorizedUsers AS au ON au.user_id = b.user_id
    WHERE b.usage_day BETWEEN @fromDay AND @toDay
      AND ${organizationFilter("b")}`);
  const families = await query<CuratedFamilyRow>(`
    SELECT c.organization_id, c.user_id, ${DAY.replace("{alias}", "c")}, c.family, c.item_name, c.interaction_count
    FROM portal.fact_usage_family_count AS c
    INNER JOIN AuthorizedUsers AS au ON au.user_id = c.user_id
    WHERE c.usage_day BETWEEN @fromDay AND @toDay
      AND ${organizationFilter("c")}`);
  return { daily, breakdown, families };
}

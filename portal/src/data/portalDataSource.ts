import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MIN_GROUP_SIZE,
  MAX_PAGE_SIZE,
  type DateRange,
  type UsageBreakdownRequest,
  type UsageBreakdownRow,
  type UsageOverviewRequest,
  type UsageOverviewResponse,
  type UsagePeriodRequest,
  type Suppressible,
  type UserUsageRow,
} from "../../../shared/src/api";
import type { Scope } from "../../../shared/src/rows";
import { computeSingleUserDetailedMetrics } from "../../upstream/src/domain/calculators/userDetailCalculator";
import { aggregateMetrics } from "../../upstream/src/domain/metricsAggregator";
import { parseMetricsLines } from "../../upstream/src/domain/metricsParser";
import {
  selectUserDetailsRouteReadModel,
  selectUserDetailsViewModel,
  type UserDetailsViewModel,
} from "../../upstream/src/read-models/userDetails";
import type { SelectedUser } from "../../upstream/src/types/navigation";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";
import type { PortalScopeSelection } from "../access/portalAccess";
import { isTestAuthEnabled } from "../auth/test-auth";
import { toFixtureCoreData, type FixtureCoreData } from "../adapters/fixtureApi";
import { getPortalSqlPool } from "../db/pool";
import { type AuthorizedUsageAccess } from "../usage/api";
import { getUsageBreakdown, getUsageOverview, getUserUsage, resolveUsageRange } from "../usage/sql-usage";

export interface PortalDataQuery {
  request: UsageOverviewRequest;
  scope: Scope;
  allowedUserIds: readonly number[];
  perUserDetailEnabled: boolean;
}

export interface PortalDataSource {
  getCoreData(query: PortalDataQuery): Promise<FixtureCoreData>;
  getUserDetails(query: PortalDataQuery, selectedUser: SelectedUser): Promise<UserDetailsViewModel | null>;
}

export const API_CORE_PAGE_SLUGS = [
  "overview",
  "copilot-adoption",
  "languages",
  "model-usage",
  "cli-adoption",
  "copilot-impact",
  "clients",
  "users",
] as const;

export type ApiCorePageSlug = typeof API_CORE_PAGE_SLUGS[number];

export type ApiCorePageData =
  | {
      page: "overview" | "copilot-adoption" | "cli-adoption" | "copilot-impact";
      overview: UsageOverviewResponse["data"];
    }
  | {
      page: "languages" | "model-usage" | "clients";
      overview: UsageOverviewResponse["data"];
      breakdownKind: UsageBreakdownRequest["kind"];
      breakdown: { rows: Suppressible<UsageBreakdownRow>[]; totalItems: number };
    }
  | {
      page: "users";
      overview: UsageOverviewResponse["data"];
      users: { rows: UserUsageRow[]; totalItems: number };
    };

export interface ApiPortalDataQuery {
  page: string;
  access: AuthorizedUsageAccess;
  selection: PortalScopeSelection;
  request: UsagePeriodRequest;
}

const FIXTURE_FILE = "fixtures/synthetic/users-1-day.ndjson";
const FIXTURE_RANGE: DateRange = { from: "2026-03-02", to: "2026-03-06" };

function repositoryRoot(): string {
  const workingDirectory = process.cwd();
  return basename(workingDirectory) === "portal"
    ? resolve(workingDirectory, "..")
    : workingDirectory;
}

async function readSyntheticMetrics(): Promise<CopilotMetrics[]> {
  if (!isTestAuthEnabled()) {
    throw new Error("Synthetic portal data is available only with the guarded test sign-in enabled.");
  }
  const ndjson = await readFile(resolve(repositoryRoot(), FIXTURE_FILE), "utf8");
  const lines = ndjson.split(/\r?\n/).filter((line) => line.length > 0);
  const metrics = parseMetricsLines(lines.map((line) => ({ line })));
  if (metrics.length === 0) {
    throw new Error(`Synthetic usage fixture contains no valid metric rows: ${FIXTURE_FILE}`);
  }
  return metrics;
}

export const syntheticPortalDataSource: PortalDataSource = {
  async getCoreData({ scope, allowedUserIds, perUserDetailEnabled }) {
    const allowedIds = new Set(allowedUserIds);
    const scopedMetrics = (await readSyntheticMetrics()).filter(
      ({ user_id, day }) => allowedIds.has(user_id) && day >= FIXTURE_RANGE.from && day <= FIXTURE_RANGE.to,
    );
    const { aggregated } = aggregateMetrics(scopedMetrics);
    const isSuppressed = new Set(scopedMetrics.map(({ user_id }) => user_id)).size < DEFAULT_MIN_GROUP_SIZE
      && !perUserDetailEnabled;
    return toFixtureCoreData({
      request: FIXTURE_RANGE,
      scope,
      metrics: scopedMetrics,
      aggregatedMetrics: isSuppressed ? aggregateMetrics([]).aggregated : aggregated,
      perUserDetailEnabled,
    });
  },

  async getUserDetails({ allowedUserIds, perUserDetailEnabled }, selectedUser) {
    if (!perUserDetailEnabled || !allowedUserIds.includes(selectedUser.id)) return null;
    const allowedIds = new Set(allowedUserIds);
    const scopedMetrics = (await readSyntheticMetrics()).filter(
      ({ user_id, day }) => allowedIds.has(user_id) && day >= FIXTURE_RANGE.from && day <= FIXTURE_RANGE.to,
    );
    const { aggregated, userDetailAccumulator } = aggregateMetrics(scopedMetrics);
    const details = computeSingleUserDetailedMetrics(userDetailAccumulator, selectedUser.id);
    if (!details) return null;
    const routeModel = selectUserDetailsRouteReadModel(aggregated, selectedUser);
    if (routeModel.status !== "resolved") return null;
    return selectUserDetailsViewModel(routeModel, details);
  },
};

export function getPortalDataSource(): PortalDataSource | null {
  return isTestAuthEnabled() ? syntheticPortalDataSource : null;
}

function grantsForSelection(
  access: AuthorizedUsageAccess,
  selection: PortalScopeSelection,
): AuthorizedUsageAccess | null {
  const grants = access.grants.filter((grant) => {
    if (selection.kind === "all") return grant.scope === "company";
    if (selection.kind === "team") return grant.scope === "team" && selection.value === "team";
    if (selection.kind === "self") return grant.scope === "self";
    return grant.scope === selection.kind
      && grant.scope_value.trim().toLowerCase() === selection.value.trim().toLowerCase();
  });
  return grants.length > 0 ? { ...access, grants } : null;
}

function isApiCorePage(page: string): page is ApiCorePageSlug {
  return (API_CORE_PAGE_SLUGS as readonly string[]).includes(page);
}

async function readAllBreakdown(
  pool: Awaited<ReturnType<typeof getPortalSqlPool>>,
  access: AuthorizedUsageAccess,
  range: DateRange & { organizationIds?: number[] },
  kind: UsageBreakdownRequest["kind"],
  correlationId: string,
): Promise<{ rows: Suppressible<UsageBreakdownRow>[]; totalItems: number }> {
  const rows: Suppressible<UsageBreakdownRow>[] = [];
  let totalItems: number;
  let page = 1;
  do {
    const result = await getUsageBreakdown(
      pool,
      access,
      { ...range, kind, page, pageSize: MAX_PAGE_SIZE },
      correlationId,
    );
    rows.push(...result.rows);
    totalItems = result.totalItems;
    if (!result.rows.length && rows.length < totalItems) {
      throw new Error("Usage breakdown paging did not make progress");
    }
    page += 1;
  } while (rows.length < totalItems);
  return { rows, totalItems };
}

async function readAllUsers(
  pool: Awaited<ReturnType<typeof getPortalSqlPool>>,
  access: AuthorizedUsageAccess,
  range: DateRange & { organizationIds?: number[] },
  correlationId: string,
): Promise<{ rows: UserUsageRow[]; totalItems: number }> {
  const rows: UserUsageRow[] = [];
  let totalItems: number;
  let page = 1;
  do {
    const result = await getUserUsage(
      pool,
      access,
      { ...range, page, pageSize: MAX_PAGE_SIZE },
      correlationId,
    );
    rows.push(...result.rows);
    totalItems = result.totalItems;
    if (!result.rows.length && rows.length < totalItems) {
      throw new Error("User usage paging did not make progress");
    }
    page += 1;
  } while (rows.length < totalItems);
  return { rows, totalItems };
}

export async function getApiCoreData(query: ApiPortalDataQuery): Promise<ApiCorePageData | null> {
  if (!isApiCorePage(query.page)) return null;
  const access = grantsForSelection(query.access, query.selection);
  if (!access || (query.page === "users" && !access.namesVisible)) return null;

  const correlationId = randomUUID();
  const pool = await getPortalSqlPool();
  const resolved = await resolveUsageRange(pool, query.request);
  if (!resolved.ok) throw new Error("The requested usage period is unavailable");
  const overview = await getUsageOverview(pool, access, resolved.range, correlationId);

  if (query.page === "languages" || query.page === "model-usage" || query.page === "clients") {
    const breakdownKind: UsageBreakdownRequest["kind"] = query.page === "languages"
      ? "language"
      : query.page === "model-usage" ? "model" : "client";
    return {
      page: query.page,
      overview,
      breakdownKind,
      breakdown: await readAllBreakdown(pool, access, resolved.range, breakdownKind, correlationId),
    };
  }

  if (query.page === "users") {
    return {
      page: query.page,
      overview,
      users: await readAllUsers(pool, access, resolved.range, correlationId),
    };
  }

  return { page: query.page, overview };
}

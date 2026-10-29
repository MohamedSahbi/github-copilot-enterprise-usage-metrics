import { randomUUID } from "node:crypto";
import type {
  UsageOverviewResponse,
  UsagePeriodRequest,
  UsageSeriesPoint,
} from "../../../shared/src/api";
import { CORE_PAGE_SLUGS, type CorePageSlug } from "../navigation/corePages";
import { getPortalSqlPool } from "../db/pool";
import type { AuthorizedUsageAccess } from "../usage/api";
import { getUsageOverview, resolveUsageRange } from "../usage/sql-usage";
import type { PortalScopeSelection } from "../access/portalAccess";

export const API_CORE_PAGE_SLUGS = CORE_PAGE_SLUGS;

export type ApiCorePageSlug = CorePageSlug;

export type ApiCorePageData =
  | { page: "overview"; series: UsageSeriesPoint[]; totalUsers: number | null }
  | { page: "copilot-impact"; series: UsageSeriesPoint[] };

export interface ApiPortalDataQuery {
  page: string;
  access: AuthorizedUsageAccess;
  selection: PortalScopeSelection;
  request: UsagePeriodRequest;
}

export function grantsForSelection(
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

export function projectCorePageData(
  page: ApiCorePageSlug,
  overview: UsageOverviewResponse["data"],
): ApiCorePageData {
  const series = overview.series.flatMap(({ suppressed, value }) => (
    suppressed || value === null ? [] : [value]
  ));
  if (page === "overview") {
    return {
      page,
      series,
      totalUsers: overview.adoption.suppressed ? null : overview.adoption.value?.totalUsers ?? null,
    };
  }
  return { page, series };
}

export async function getApiCoreData(query: ApiPortalDataQuery): Promise<ApiCorePageData | null> {
  if (!isApiCorePage(query.page)) return null;
  const access = grantsForSelection(query.access, query.selection);
  if (!access) return null;

  const correlationId = randomUUID();
  const pool = await getPortalSqlPool();
  const resolved = await resolveUsageRange(pool, query.request);
  if (!resolved.ok) throw new Error("The requested usage period is unavailable");
  const overview = await getUsageOverview(pool, access, resolved.range, correlationId);
  return projectCorePageData(query.page, overview);
}

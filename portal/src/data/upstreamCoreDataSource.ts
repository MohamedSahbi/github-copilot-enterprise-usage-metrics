import { randomUUID } from "node:crypto";
import { DEFAULT_MIN_GROUP_SIZE, type UsagePeriodRequest } from "../../../shared/src/api";
import { computeSingleUserDetailedMetrics } from "../../upstream/src/domain/calculators/userDetailCalculator";
import { aggregateMetrics } from "../../upstream/src/domain/metricsAggregator";
import {
  selectUserDetailsRouteReadModel,
  selectUserDetailsViewModel,
  type UserDetailsViewModel,
} from "../../upstream/src/read-models/userDetails";
import type { AggregatedMetrics } from "../../upstream/src/types/aggregatedMetrics";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";
import type { PortalScopeSelection } from "../access/portalAccess";
import { getPortalSqlPool } from "../db/pool";
import type { AuthorizedUsageAccess } from "../usage/api";
import { getScopedCuratedRows, resolveUsageRange } from "../usage/sql-usage";
import { pseudonymizeLogins, toUpstreamRecords } from "../usage/upstreamRecords";
import { grantsForSelection } from "./apiCoreDataSource";

export const UPSTREAM_REPORTING_PERIOD: UsagePeriodRequest = { period: "last_28_days" };

export type UpstreamCoreData =
  | { state: "ready"; metrics: AggregatedMetrics; userCount: number }
  | { state: "suppressed"; userCount: number };

export interface UpstreamQuery {
  access: AuthorizedUsageAccess;
  selection: PortalScopeSelection;
  perUserDetailEnabled: boolean;
  request?: UsagePeriodRequest;
  minGroupSize?: number;
}

/**
 * Whole-scope suppression: below the minimum group size nothing is aggregated, unless the
 * viewer looks at their own data or the deployment allows per-user detail. Without per-user
 * detail, logins are replaced before aggregation so no view can name a person.
 */
export function prepareUpstreamRecords(
  records: readonly CopilotMetrics[],
  { selection, perUserDetailEnabled, minGroupSize = DEFAULT_MIN_GROUP_SIZE }: Pick<
    UpstreamQuery,
    "selection" | "perUserDetailEnabled" | "minGroupSize"
  >,
): { state: "ready"; records: CopilotMetrics[]; userCount: number } | { state: "suppressed"; userCount: number } {
  const userCount = new Set(records.map(({ user_id }) => user_id)).size;
  if (selection.kind !== "self" && !perUserDetailEnabled && userCount < minGroupSize) {
    return { state: "suppressed", userCount };
  }
  return {
    state: "ready",
    records: perUserDetailEnabled ? [...records] : pseudonymizeLogins(records),
    userCount,
  };
}

async function loadScopedRecords(query: UpstreamQuery): Promise<CopilotMetrics[] | null> {
  const access = grantsForSelection(query.access, query.selection);
  if (!access) return null;
  const pool = await getPortalSqlPool();
  const resolved = await resolveUsageRange(pool, query.request ?? UPSTREAM_REPORTING_PERIOD);
  if (!resolved.ok) throw new Error("The requested usage period is unavailable");
  const rows = await getScopedCuratedRows(pool, access, resolved.range, randomUUID());
  return toUpstreamRecords(rows.daily, rows.breakdown, rows.families, resolved.range);
}

export async function getUpstreamCoreData(query: UpstreamQuery): Promise<UpstreamCoreData | null> {
  const records = await loadScopedRecords(query);
  if (!records) return null;
  const prepared = prepareUpstreamRecords(records, query);
  if (prepared.state === "suppressed") return prepared;
  return { state: "ready", metrics: aggregateMetrics(prepared.records).aggregated, userCount: prepared.userCount };
}

export async function getUpstreamUserDetails(
  query: UpstreamQuery,
  userId: number,
): Promise<UserDetailsViewModel | null> {
  if (!query.perUserDetailEnabled) return null;
  const records = await loadScopedRecords(query);
  if (!records) return null;
  const user = records.find(({ user_id }) => user_id === userId);
  if (!user) return null;
  const { aggregated, userDetailAccumulator } = aggregateMetrics(records);
  const details = computeSingleUserDetailedMetrics(userDetailAccumulator, userId);
  if (!details) return null;
  const routeModel = selectUserDetailsRouteReadModel(aggregated, { id: userId, login: user.user_login });
  if (routeModel.status !== "resolved") return null;
  return selectUserDetailsViewModel(routeModel, details);
}

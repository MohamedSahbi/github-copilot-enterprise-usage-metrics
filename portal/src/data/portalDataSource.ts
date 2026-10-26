import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  DEFAULT_MIN_GROUP_SIZE,
  type DateRange,
  type UsageOverviewRequest,
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
import { isTestAuthEnabled } from "../auth/test-auth";
import { toFixtureCoreData, type FixtureCoreData } from "../adapters/fixtureApi";

export {
  API_CORE_PAGE_SLUGS,
  getApiCoreData,
  projectCorePageData,
} from "./apiCoreDataSource";
export type {
  ApiCorePageData,
  ApiCorePageSlug,
  ApiPortalDataQuery,
} from "./apiCoreDataSource";

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

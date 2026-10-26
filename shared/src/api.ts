// API request/response contracts for the portal (§6.2 step 10, §6.3). Aggregates by default.
// Every response carries a correlation ID; every list is paged; every group can be suppressed.

import type { GrantErrorCode } from "./access";
import type { IsoDate, Role, Scope } from "./rows";

export const MAX_DATE_RANGE_DAYS = 400;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MIN_GROUP_SIZE = 5;

export type ApiErrorCode =
  | "invalid_request"
  | "date_range_too_large"
  | "page_size_too_large"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "per_user_detail_disabled"
  | "decimal_overflow"
  | "permissions_unavailable"
  | "module_disabled"
  | "rate_limited"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  correlationId: string;
  details?: { field: string; issue: string }[];
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface Meta {
  correlationId: string;
  generatedAt: string;
  minGroupSize: number;
  metricVersion: number;
}

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export interface PageRequest {
  page?: number;
  pageSize?: number;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface ScopedRangeRequest extends DateRange {
  organizationIds?: number[];
}

export type UsagePeriodRequest =
  | { period: "last_7_days"; organizationIds?: number[] }
  | { period: "last_28_days"; organizationIds?: number[] }
  | { period: "last_90_days"; organizationIds?: number[] }
  | { period: "calendar_month"; month: string; organizationIds?: number[] };

export type ScopedUsagePeriodRequest = UsagePeriodRequest & {
  scope?: CoreViewScopeSelection;
};

export type UsagePeriodValidation =
  | { ok: true; range: DateRange }
  | { ok: false; code: "invalid_request" };

export function validateUsagePeriod(
  request: UsagePeriodRequest,
  latestCompleteDay: IsoDate,
): UsagePeriodValidation {
  if (!validateDateRange({ from: latestCompleteDay, to: latestCompleteDay }).ok) {
    return { ok: false, code: "invalid_request" };
  }

  if (request.period === "calendar_month") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(request.month)) {
      return { ok: false, code: "invalid_request" };
    }
    const [year, month] = request.month.split("-").map(Number);
    const from = `${request.month}-01`;
    const to = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    if (to > latestCompleteDay) return { ok: false, code: "invalid_request" };
    return { ok: true, range: { from, to } };
  }

  const days = {
    last_7_days: 7,
    last_28_days: 28,
    last_90_days: 90,
  }[request.period];
  const to = new Date(`${latestCompleteDay}T00:00:00.000Z`);
  const from = new Date(to.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { ok: true, range: { from, to: latestCompleteDay } };
}

export interface Suppressible<T> {
  suppressed: boolean;
  // null when suppressed, so a small exact count never reaches the browser
  userCount: number | null;
  value: T | null;
}

export interface ApiResponse<T> {
  meta: Meta;
  data: T;
}

export interface PagedResponse<T> extends ApiResponse<T[]> {
  page: PageInfo;
}

export type RangeValidation = { ok: true } | { ok: false; code: "invalid_request" | "date_range_too_large" };

export function validateDateRange(range: DateRange): RangeValidation {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || Number.isNaN(from) || Number.isNaN(to) ||
      new Date(from).toISOString().slice(0, 10) !== range.from || new Date(to).toISOString().slice(0, 10) !== range.to || to < from) {
    return { ok: false, code: "invalid_request" };
  }
  const days = (to - from) / 86_400_000 + 1;
  return days > MAX_DATE_RANGE_DAYS ? { ok: false, code: "date_range_too_large" } : { ok: true };
}

export function normalizePage(req: PageRequest): { page: number; pageSize: number } | { error: "page_size_too_large" | "invalid_request" } {
  const page = req.page ?? 1;
  const pageSize = req.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) return { error: "invalid_request" };
  if (pageSize > MAX_PAGE_SIZE) return { error: "page_size_too_large" };
  return { page, pageSize };
}

export function suppress<T>(userCount: number, minGroupSize: number, value: T, namesVisible: boolean): Suppressible<T> {
  const floor = Number.isFinite(minGroupSize) ? Math.max(minGroupSize, DEFAULT_MIN_GROUP_SIZE) : DEFAULT_MIN_GROUP_SIZE;
  const small = !Number.isFinite(userCount) || userCount < 0 || userCount < floor;
  if (!namesVisible && small) return { suppressed: true, userCount: null, value: null };
  return { suppressed: false, userCount, value };
}

// Minimum group size applies to every scope, including business_area; there is no per-scope exemption (issue #44 item 11).
export function suppressForScope<T>(_scope: Scope, userCount: number, minGroupSize: number, value: T, namesVisible: boolean): Suppressible<T> {
  return suppress(userCount, minGroupSize, value, namesVisible);
}

// ---- Core usage pages -------------------------------------------------------------------------------------------

export interface UsageSeriesPoint {
  day: IsoDate;
  activeUsers: number;
  interactions: number;
  codeGenerations: number;
  codeAcceptances: number;
  locAdded: number;
  locDeleted: number;
}

export interface AdoptionSummary {
  totalUsers: number;
  completionUsers: number;
  completionOnlyUsers: number;
  chatUsers: number;
  agentModeUsers: number;
  askModeUsers: number;
  inlineModeUsers: number;
  planModeUsers: number;
  cliUsers: number;
  appUsers: number;
  vscodeAgentUsers: number;
  codingAgentUsers: number;
  codeReviewUsers: number;
  advancedUsers: number;
}

export interface UsageBreakdownRow {
  kind: "feature" | "model" | "client" | "language" | "ide";
  key: string;
  interactions: number;
  userCount: number;
}

export type UsageOverviewRequest = ScopedUsagePeriodRequest;
export type UsageOverviewResponse = ApiResponse<{
  series: Suppressible<UsageSeriesPoint>[];
  adoption: Suppressible<AdoptionSummary>;
}>;

export type UsageBreakdownRequest = ScopedUsagePeriodRequest & PageRequest & {
  kind: UsageBreakdownRow["kind"];
};
export type UsageBreakdownResponse = PagedResponse<Suppressible<UsageBreakdownRow>>;

// Per-user rows exist only when the deployment allows named users, only within the viewer's grants, and always paged.
export interface UserUsageRow {
  userId: number;
  login: string | null;
  daysActive: number;
  interactions: number;
  aiCreditsUsed: string;
}
export type UserUsageRequest = ScopedUsagePeriodRequest & PageRequest;
export type UserUsageResponse = PagedResponse<UserUsageRow>;

export type CoreViewMetric<T> =
  | { availability: "available"; value: T }
  | { availability: "not_reported"; value: null }
  | { availability: "unavailable"; reason: "source_discarded"; value: null }
  | { availability: "suppressed"; value: null };

export type CoreViewCohort<T> =
  | { availability: "available"; userCount: number; value: T }
  | { availability: "not_reported"; userCount: null; value: null }
  | { availability: "unavailable"; reason: "source_discarded"; userCount: null; value: null }
  | { availability: "suppressed"; userCount: null; value: null };

export type CoreViewScopeSelection =
  | { scope: "self" }
  | { scope: "team" }
  | { scope: "company" }
  | { scope: "department"; value: string }
  | { scope: "business_area"; value: string };

export type CoreViewScopeSelectionValidation =
  | { ok: true; selection?: CoreViewScopeSelection }
  | { ok: false; code: "invalid_request" };

export function parseCoreViewScopeSelection(params: URLSearchParams): CoreViewScopeSelectionValidation {
  const scopes = params.getAll("scope");
  const values = params.getAll("value");
  if (scopes.length === 0) {
    return values.length === 0 ? { ok: true } : { ok: false, code: "invalid_request" };
  }
  if (scopes.length !== 1 || values.length > 1) return { ok: false, code: "invalid_request" };

  const scope = scopes[0];
  if (scope === "self" || scope === "team" || scope === "company") {
    return values.length === 0
      ? { ok: true, selection: { scope } }
      : { ok: false, code: "invalid_request" };
  }
  if (scope === "department" || scope === "business_area") {
    const value = values[0];
    return value !== undefined && value.length > 0
      ? { ok: true, selection: { scope, value } }
      : { ok: false, code: "invalid_request" };
  }
  return { ok: false, code: "invalid_request" };
}

export function serializeCoreViewScopeSelection(selection?: CoreViewScopeSelection): URLSearchParams {
  const params = new URLSearchParams();
  if (selection === undefined) return params;

  params.set("scope", selection.scope);
  if ("value" in selection) params.set("value", selection.value);
  return params;
}

export interface CoreViewScopeOptions {
  departments: string[];
  businessAreas: string[];
}

export interface CoreViewScopeOptionPopulationCounts {
  departments: Readonly<Record<string, number>>;
  businessAreas: Readonly<Record<string, number>>;
}

export type CoreViewScopeOptionsResult =
  | { availability: "available"; options: CoreViewScopeOptions }
  | {
      availability: "unavailable";
      reason: "authorization_unavailable" | "option_data_unavailable";
      options: null;
    };

export function intersectCoreViewScopeOptions(
  authorizedOptions: CoreViewScopeOptions | null | undefined,
  directoryOptions: CoreViewScopeOptions | null | undefined,
  populationCounts: CoreViewScopeOptionPopulationCounts | null | undefined,
  minGroupSize = DEFAULT_MIN_GROUP_SIZE,
): CoreViewScopeOptionsResult {
  if (authorizedOptions === null || authorizedOptions === undefined) {
    return { availability: "unavailable", reason: "authorization_unavailable", options: null };
  }
  if (directoryOptions === null || directoryOptions === undefined
    || populationCounts === null || populationCounts === undefined) {
    return { availability: "unavailable", reason: "option_data_unavailable", options: null };
  }
  const intersect = (kind: keyof CoreViewScopeOptions): string[] | null => {
    const authorized = authorizedOptions[kind];
    const directory = directoryOptions[kind];
    const counts = populationCounts[kind];
    if (!Array.isArray(authorized) || !Array.isArray(directory) || !counts || typeof counts !== "object") return null;
    const permitted = new Set(authorized);
    const candidates = [...new Set(directory.filter((value) => permitted.has(value)))].sort();
    const visible: string[] = [];
    for (const value of candidates) {
      const userCount = counts[value];
      if (typeof userCount !== "number" || !Number.isSafeInteger(userCount) || userCount < 0) return null;
      if (!suppress(userCount, minGroupSize, value, false).suppressed) visible.push(value);
    }
    return visible;
  };
  const departments = intersect("departments");
  const businessAreas = intersect("businessAreas");
  if (departments === null || businessAreas === null) {
    return { availability: "unavailable", reason: "option_data_unavailable", options: null };
  }
  return {
    availability: "available",
    options: {
      departments,
      businessAreas,
    },
  };
}

export function deriveCoreViewMetric<T>(
  dependencies: readonly CoreViewMetric<unknown>[],
  calculate: () => T,
): CoreViewMetric<T> {
  if (dependencies.some(({ availability }) => availability === "suppressed")) {
    return { availability: "suppressed", value: null };
  }
  if (dependencies.some(({ availability }) => availability === "unavailable")) {
    return { availability: "unavailable", reason: "source_discarded", value: null };
  }
  if (dependencies.some(({ availability }) => availability === "not_reported")) {
    return { availability: "not_reported", value: null };
  }
  return { availability: "available", value: calculate() };
}

export interface CoreViewDailyParticipation {
  day: IsoDate;
  activeUsers: CoreViewCohort<number>;
}

export interface CoreViewPeakDay {
  day: CoreViewMetric<IsoDate>;
  activeUsers: CoreViewCohort<number>;
}

export interface CoreViewTopDecile {
  subsetUsers: CoreViewCohort<number>;
  subsetMetric: CoreViewCohort<number>;
  share: CoreViewMetric<string>;
}

export interface CoreViewTopNEntry {
  cohort: CoreViewCohort<{ key: string; metric: number }>;
}

export interface CoreViewCliTotals {
  users: CoreViewCohort<number>;
  sessions: CoreViewCohort<number>;
  requests: CoreViewCohort<number>;
  promptTokens: CoreViewCohort<number>;
  outputTokens: CoreViewCohort<number>;
}

export type CoreViewFeatureAdoption = {
  [Metric in keyof AdoptionSummary]: CoreViewCohort<number>;
};

export interface CoreViewMetrics {
  dailyParticipation: CoreViewDailyParticipation[];
  peakDay: CoreViewPeakDay;
  topDecile: CoreViewTopDecile;
  topModels: CoreViewTopNEntry[];
  topClients: CoreViewTopNEntry[];
  topLanguages: CoreViewTopNEntry[];
  topVersions: CoreViewTopNEntry[];
  topPhases: CoreViewTopNEntry[];
  cli: CoreViewCliTotals;
  ideCliOverlap: { users: CoreViewCohort<number>; share: CoreViewMetric<string> };
  featureAdoption: CoreViewFeatureAdoption;
  sourceFields: {
    aiAdoptionPhaseVersion: CoreViewMetric<string>;
    clientPromptCount: CoreViewMetric<number>;
    vscodeAgentTotalUserMessages: CoreViewMetric<number>;
  };
}

export type CoreViewResponse = ApiResponse<CoreViewMetrics>;

// ---- AI Credits module ------------------------------------------------------------------------------------------

export interface AiCreditsDailyRow {
  day: IsoDate;
  organizationLogin: string;
  model: string;
  costCenterName: string;
  aicQuantity: string;
  aicGrossAmount: string;
  netAmount: string;
}
export interface AiCreditsRequest extends DateRange, PageRequest {
  organizationLogins?: string[];
  groupBy?: "day" | "model" | "cost_center" | "organization";
}
export type AiCreditsResponse = PagedResponse<Suppressible<AiCreditsDailyRow>>;

// ---- Budget Lookup (read-only) ----------------------------------------------------------------------------------

// Normalized server request. URL input carries only an optional numeric userId, not target or scope.
export type BudgetLookupRequest =
  | { target: "self"; userId?: never }
  | { target: "user"; userId: number };

export type BudgetLookupRequestValidation =
  | { ok: true; request: BudgetLookupRequest }
  | { ok: false; code: "invalid_request" };

export function validateBudgetLookupRequest(request: unknown): BudgetLookupRequestValidation {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, code: "invalid_request" };
  }

  const input = request as Record<string, unknown>;
  const keys = Object.keys(input);
  if (input.target === "self" && keys.length === 1 && keys[0] === "target") {
    return { ok: true, request: { target: "self" } };
  }
  if (input.target === "user" && keys.length === 2 && keys.includes("target") && keys.includes("userId")) {
    const userId = input.userId;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
      return { ok: false, code: "invalid_request" };
    }
    return { ok: true, request: { target: "user", userId } };
  }
  return { ok: false, code: "invalid_request" };
}

export function parseBudgetLookupRequest(params: URLSearchParams): BudgetLookupRequestValidation {
  if (params.size === 0) return { ok: true, request: { target: "self" } };
  const userId = params.get("userId");
  if (params.size !== 1 || userId === null || !/^[1-9]\d*$/.test(userId)) {
    return { ok: false, code: "invalid_request" };
  }
  return validateBudgetLookupRequest({ target: "user", userId: Number(userId) });
}

export type BudgetLookupSourceErrorCode =
  | "budget_source_unavailable"
  | "budget_source_timeout"
  | "budget_source_invalid"
  | "budget_source_incomplete";

export interface BudgetLookupErrorResponse {
  error: Omit<ApiError, "code"> & { code: ApiErrorCode | BudgetLookupSourceErrorCode };
}

export const BUDGET_SOURCE_ERROR_STATUS = {
  budget_source_unavailable: 503,
  budget_source_timeout: 504,
  budget_source_invalid: 502,
  budget_source_incomplete: 502,
} as const satisfies Record<BudgetLookupSourceErrorCode, number>;

// Amounts are exactDecimal18_9 USD text under owner-attested source semantics; never convert AI credits.
export type BudgetLookupConsumption =
  | { status: "reported"; amount: string; unit: "USD" }
  | { status: "not_reported" };

export type BudgetLookupRecord = {
  id: string;
  amount: string;
  consumedAmount: BudgetLookupConsumption;
} & (
  | { kind: "individual"; expiresAt: IsoDate | null }
  | { kind: "default_per_user"; expiresAt: null }
);

export type BudgetLookupEffective =
  | { status: "reported"; budgetId: string; amount: string; consumedAmount: BudgetLookupConsumption }
  | { status: "not_reported" }
  | { status: "outside_mvp" };

export interface BudgetLookupData {
  userId: number;
  budgets: BudgetLookupRecord[];
  effectiveBudget: BudgetLookupEffective;
  amountUnit: "USD";
  cycle: "calendar_month_utc";
}

export type BudgetLookupResponse = ApiResponse<BudgetLookupData>;

// Deferred center/source descriptors below are not supported MVP response branches (D-55, #137).
export type BudgetLookupScope =
  | { type: "universal"; githubScope: "multi_user_customer" | "multi_user_cost_center" }
  | { type: "individual"; githubScope: "user" }
  | { type: "cost_center"; githubScope: "cost_center" }
  | { type: "raw"; githubScope: string };

export interface BudgetLookupAlerting {
  willAlert: boolean;
  alertRecipients: string[];
}

export interface BudgetLookupBudget {
  id: string;
  scope: BudgetLookupScope;
  entityName: string | null;
  budgetType: "SkuPricing" | "ProductPricing" | "BundlePricing";
  // Wrap singular budget_product_sku in an array; preserve every plural budget_product_skus entry.
  budgetProductSkus: string[];
  // Preserve JSON number tokens as text, then canonicalize with exactDecimal18_9; never parse through Number.
  amount: string;
  preventFurtherUsage: boolean;
  budgetAlerting: BudgetLookupAlerting;
  consumedAmount: string | null;
  // Listed as `expires_at` by the enterprise budgets list endpoint; not every budget has one.
  expiresAt: IsoDate | null;
}

export interface BudgetLookupEffectiveBudget {
  id: string;
  amount: string;
  consumedAmount: string;
}

export interface BudgetLookupCostCenterMembership {
  id: string;
  name: string;
  state: "active" | "deleted";
}

/**
 * Normalized `user-states` row. GitHub's login is used transiently for exact identity matching and
 * omitted from this portal response; numeric identity comes only from the portal's identity data.
 */
export interface BudgetLookupUserState {
  budgetId: string;
  /** Resolved by exact current-login match in portal identity data; null when no mapping exists. */
  userId: number | null;
  // Numeric tokens use the same lossless text conversion and exactDecimal18_9 validation as budgets.
  consumedAmount: string;
  targetAmount: string;
  /** GitHub omits this field when there is no override. */
  overrideBudgetId: string | null;
}

/**
 * Internal adapter input for GitHub's login-keyed user-states response. The login is transient
 * matching data only and must not be returned to callers or used as a permission key. The adapter
 * losslessly decodes the numeric JSON tokens into decimal strings before constructing this shape.
 */
export interface GitHubBudgetUserStatesPage {
  user_states: GitHubBudgetUserState[];
  has_next_page: boolean;
  total_count: number;
}

export interface GitHubBudgetUserState {
  user: string;
  consumed_amount: string;
  target_amount: string;
  override_budget_id?: string;
}

export interface BudgetLookupCostCenterMember {
  // Member data is scope-sensitive; consumers must authorize server-side under D-17 before returning it.
  resourceType: string;
  // GitHub resource name/login, descriptive only; never a lookup or permission key.
  resourceName: string;
  // Resolved from the current login in portal identity data; null when no exact mapping exists.
  userId: number | null;
  consumedAmount: string | null;
  targetAmount: string | null;
  overrideBudgetId: string | null;
}

/** Per-user budget data is scope-sensitive and must be authorized server-side under D-17. */
export interface DeferredBudgetLookupUserData {
  /** Portal identity for the requested numeric user; null if GitHub response identity cannot be mapped. */
  userId: number | null;
  budgets: BudgetLookupBudget[];
  effectiveBudget: BudgetLookupEffectiveBudget | null;
  userStates: BudgetLookupUserState[];
  costCenterMemberships: BudgetLookupCostCenterMembership[];
}

/** Member-level detail must be authorized server-side under D-17 before it is returned. */
export interface BudgetLookupCostCenterData {
  costCenterName: string;
  state: "active" | "deleted";
  budget: BudgetLookupBudget | null;
  members: BudgetLookupCostCenterMember[];
}

export type DeferredBudgetLookupResponse = ApiResponse<DeferredBudgetLookupUserData | BudgetLookupCostCenterData>;

// ---- Admin ------------------------------------------------------------------------------------------------------

export interface AdminPrincipalSummary {
  principalId: string;
  status: "active" | "disabled";
  hasEntraIdentity: boolean;
  hasGithubIdentity: boolean;
  permissionsVerifiedAt: string | null;
}
export interface AdminGrant {
  grantId: number;
  role: Role;
  scope: Scope;
  scopeValue: string;
  revokedAt: string | null;
}
export type AdminPrincipalsRequest = PageRequest;
export type AdminPrincipalsResponse = PagedResponse<AdminPrincipalSummary>;
export interface AdminGrantChangeRequest {
  principalId: string;
  role: Role;
  scope: Scope;
  scopeValue?: string;
  action: "grant" | "revoke";
}
export type AdminGrantChangeResponse = ApiResponse<AdminGrant>;

// POST /api/admin/grants (admin only, audited). 201 on success; 422 with a typed error code otherwise.
export interface AdminGrantCreateRequest {
  principalEntraObjectId: string;
  role: Role;
  scope: Scope;
  scopeValue?: string;
}
export type AdminGrantCreateResponse = ApiResponse<AdminGrant>; // HTTP 201
export type AdminGrantErrorCode = GrantErrorCode;
export interface AdminGrantErrorResponse {
  error: Omit<ApiError, "code"> & { code: AdminGrantErrorCode | "invalid_request" | "forbidden" | "unauthenticated" };
} // HTTP 422 for the four typed codes

// Data for the Admin grant form: only enabled scopes and the distinct values present in the directory.
export interface AdminGrantFormData {
  roleScopes: Record<Role, Scope[]>;
  enabledScopes: Scope[];
  scopeValues: { department: string[]; business_area: string[] };
}
export type AdminGrantFormResponse = ApiResponse<AdminGrantFormData>;

// ---- Feedback ---------------------------------------------------------------------------------------------------

export interface FeedbackItemView {
  itemId: number;
  title: string;
  body: string;
  status: "open" | "planned" | "done" | "declined";
  votes: number;
  commentCount: number;
  authorDisplayName: string | null;
  createdAt: string;
}
export interface FeedbackListRequest extends PageRequest {
  status?: FeedbackItemView["status"];
}
export type FeedbackListResponse = PagedResponse<FeedbackItemView>;
export interface FeedbackCreateRequest {
  title: string;
  body: string;
}
export type FeedbackCreateResponse = ApiResponse<FeedbackItemView>;

// ---- Health -----------------------------------------------------------------------------------------------------

export type HealthStatus = "ok" | "degraded" | "down";
export interface HealthResponse {
  status: HealthStatus;
  correlationId: string;
  checks: { name: string; status: HealthStatus }[];
  modules: { name: string; enabled: boolean }[];
}

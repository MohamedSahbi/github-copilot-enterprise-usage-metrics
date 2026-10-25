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

export type UsageOverviewRequest = ScopedRangeRequest;
export type UsageOverviewResponse = ApiResponse<{
  series: Suppressible<UsageSeriesPoint>[];
  adoption: Suppressible<AdoptionSummary>;
}>;

export interface UsageBreakdownRequest extends ScopedRangeRequest, PageRequest {
  kind: UsageBreakdownRow["kind"];
}
export type UsageBreakdownResponse = PagedResponse<Suppressible<UsageBreakdownRow>>;

// Per-user rows exist only when the deployment allows named users, only within the viewer's grants, and always paged.
export interface UserUsageRow {
  userId: number;
  login: string | null;
  daysActive: number;
  interactions: number;
  aiCreditsUsed: number;
}
export type UserUsageRequest = ScopedRangeRequest & PageRequest;
export type UserUsageResponse = PagedResponse<UserUsageRow>;

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

// Email and login are never lookup or permission keys.
export type BudgetLookupRequest =
  | { userId: number; costCenterName?: never }
  | { userId?: never; costCenterName: string };

export type BudgetLookupRequestValidation =
  | { ok: true; request: BudgetLookupRequest }
  | { ok: false; code: "invalid_request" };

export function validateBudgetLookupRequest(request: unknown): BudgetLookupRequestValidation {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, code: "invalid_request" };
  }

  const input = request as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 1) return { ok: false, code: "invalid_request" };

  if (keys[0] === "userId") {
    const userId = input.userId;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
      return { ok: false, code: "invalid_request" };
    }
    return { ok: true, request: { userId } };
  }

  if (keys[0] === "costCenterName") {
    const costCenterName = input.costCenterName;
    if (typeof costCenterName !== "string" || costCenterName.trim().length === 0) {
      return { ok: false, code: "invalid_request" };
    }
    return { ok: true, request: { costCenterName: costCenterName.trim() } };
  }

  return { ok: false, code: "invalid_request" };
}

// Raw values preserve unknown upstream scopes without expanding which scopes callers may request.
export type BudgetLookupScope =
  | { type: "universal"; githubScope: "multi_user_customer" | "multi_user_cost_center" }
  | { type: "individual"; githubScope: "user" }
  | { type: "cost_center"; githubScope: "cost_center" }
  | { type: "raw"; githubScope: string };

// The string intersection preserves recognized labels while allowing GitHub's raw fallback values.
export type BudgetLookupConsumedAgainstType =
  | "universal_default"
  | "team_budget"
  | "individual_budget"
  | "cost_center"
  | (string & {});

export interface BudgetLookupBudget {
  id: string;
  scope: BudgetLookupScope;
  entityName: string | null;
  amount: string;
  currency: string;
  consumedAmount: string | null;
  consumedAgainstType: BudgetLookupConsumedAgainstType | null;
  expiresAt: IsoDate | null;
}

export interface BudgetLookupEffectiveBudget {
  id: string;
  amount: string;
  consumedAmount: string;
  consumedAgainstType: BudgetLookupConsumedAgainstType | null;
}

export interface BudgetLookupCostCenterMembership {
  id: string;
  name: string;
  state: "active" | "deleted";
}

export interface BudgetLookupCostCenterMember {
  // Member data is scope-sensitive; consumers must authorize server-side under D-17 before returning it.
  resourceType: string;
  // Descriptive only; never a lookup or permission key.
  resourceName: string;
  userId: number | null;
  consumedAmount: string | null;
  targetAmount: string | null;
}

/** Per-user budget data is scope-sensitive and must be authorized server-side under D-17. */
export interface BudgetLookupUserData {
  userId: number;
  budgets: BudgetLookupBudget[];
  effectiveBudget: BudgetLookupEffectiveBudget | null;
  costCenterMemberships: BudgetLookupCostCenterMembership[];
}

/** Member-level detail must be authorized server-side under D-17 before it is returned. */
export interface BudgetLookupCostCenterData {
  costCenterName: string;
  budget: BudgetLookupBudget | null;
  members: BudgetLookupCostCenterMember[];
}

export type BudgetLookupResponse = ApiResponse<BudgetLookupUserData | BudgetLookupCostCenterData>;

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

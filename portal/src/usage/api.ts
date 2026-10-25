import { NextResponse } from "next/server";
import {
  DEFAULT_MIN_GROUP_SIZE,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ApiResponse,
  type Meta,
  normalizePage,
  type PageRequest,
  type UsagePeriodRequest,
  type UsageBreakdownRequest,
} from "../../../shared/src/api";
import { METRIC_DEFINITION_VERSION } from "../../../shared/src/metrics";
import type { AccessResult } from "../authz/access";

export type AuthorizedUsageAccess = Extract<AccessResult, { state: "authorized" }>;

export type ApiFailure = {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: { field: string; issue: string }[];
};

export type ParsedPeriod = UsagePeriodRequest;
export type ParsedPage = { page: number; pageSize: number };
export type ParsedBreakdown = UsagePeriodRequest & ParsedPage & { kind: UsageBreakdownRequest["kind"] };

export function errorResponse(failure: ApiFailure, correlationId: string): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        correlationId,
        ...(failure.details ? { details: failure.details } : {}),
      },
    },
    { status: failure.status, headers: responseHeaders(correlationId) },
  );
}

export function responseHeaders(correlationId: string): Record<string, string> {
  return { "Cache-Control": "private, no-store", "X-Correlation-ID": correlationId };
}

export function responseMeta(correlationId: string, minGroupSize = DEFAULT_MIN_GROUP_SIZE): Meta {
  return {
    correlationId,
    generatedAt: new Date().toISOString(),
    minGroupSize,
    metricVersion: Number(METRIC_DEFINITION_VERSION),
  };
}

function invalid(field: string, issue: string): ApiFailure {
  return { code: "invalid_request", message: "The request is invalid.", status: 400, details: [{ field, issue }] };
}

function parseOrganizationIds(params: URLSearchParams): { ok: true; organizationIds?: number[] } | { ok: false; failure: ApiFailure } {
  const rawOrganizationIds = params.getAll("organizationIds").flatMap((value) => value.split(","));
  const organizationIds: number[] = [];
  for (const value of rawOrganizationIds) {
    if (!/^[1-9]\d*$/.test(value)) {
      return { ok: false, failure: invalid("organizationIds", "must contain positive safe integers") };
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id)) {
      return { ok: false, failure: invalid("organizationIds", "must contain positive safe integers") };
    }
    if (!organizationIds.includes(id)) organizationIds.push(id);
  }
  return { ok: true, ...(organizationIds.length ? { organizationIds } : {}) };
}

export function parseUsagePeriod(params: URLSearchParams): { ok: true; period: ParsedPeriod } | { ok: false; failure: ApiFailure } {
  if (params.has("from") || params.has("to")) {
    return { ok: false, failure: invalid("period", "raw date ranges are not supported") };
  }
  const period = params.get("period");
  const month = params.get("month");
  let request: UsagePeriodRequest;
  if (period === "last_7_days" || period === "last_28_days" || period === "last_90_days") {
    if (month !== null) return { ok: false, failure: invalid("month", "is only valid for calendar_month") };
    request = { period };
  } else if (period === "calendar_month") {
    if (month === null) return { ok: false, failure: invalid("month", "is required for calendar_month") };
    request = { period, month };
  } else {
    return { ok: false, failure: invalid("period", "must be last_7_days, last_28_days, last_90_days, or calendar_month") };
  }
  const organizations = parseOrganizationIds(params);
  if (!organizations.ok) return organizations;
  return { ok: true, period: { ...request, ...organizations } };
}

export function parsePage(params: URLSearchParams): { ok: true; page: ParsedPage } | { ok: false; failure: ApiFailure } {
  const parsed: PageRequest = {};
  for (const field of ["page", "pageSize"] as const) {
    const raw = params.get(field);
    if (raw === null) continue;
    if (!/^[1-9]\d*$/.test(raw)) return { ok: false, failure: invalid(field, "must be a positive integer") };
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return { ok: false, failure: invalid(field, "must be a safe integer") };
    parsed[field] = value;
  }
  const page = normalizePage(parsed);
  if ("error" in page) {
    if (page.error === "page_size_too_large") {
      return { ok: false, failure: { code: page.error, message: "The page size exceeds the maximum allowed value.", status: 400 } };
    }
    return { ok: false, failure: invalid("page", "must be a positive integer") };
  }
  if (!Number.isSafeInteger((page.page - 1) * page.pageSize)) {
    return { ok: false, failure: invalid("page", "is too large") };
  }
  return { ok: true, page };
}

const breakdownKinds = ["feature", "model", "client", "language", "ide"] as const;
export function parseBreakdown(params: URLSearchParams): { ok: true; breakdown: ParsedBreakdown } | { ok: false; failure: ApiFailure } {
  const period = parseUsagePeriod(params);
  if (!period.ok) return period;
  const page = parsePage(params);
  if (!page.ok) return page;
  const kind = params.get("kind");
  if (!kind || !(breakdownKinds as readonly string[]).includes(kind)) {
    return { ok: false, failure: invalid("kind", `must be one of ${breakdownKinds.join(", ")}`) };
  }
  return { ok: true, breakdown: { ...period.period, ...page.page, kind: kind as ParsedBreakdown["kind"] } };
}

export function parsePageRequest(params: URLSearchParams): { ok: true; page: ParsedPage } | { ok: false; failure: ApiFailure } {
  return parsePage(params);
}

export function apiResponse<T>(data: T, correlationId: string): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ meta: responseMeta(correlationId), data }, { headers: responseHeaders(correlationId) });
}

export function logUsageFailure(correlationId: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "portal.usage_query_failed", correlationId, errorName })}\n`);
}

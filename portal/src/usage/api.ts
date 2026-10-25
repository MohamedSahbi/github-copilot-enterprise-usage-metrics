import { NextResponse } from "next/server";
import {
  DEFAULT_MIN_GROUP_SIZE,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ApiResponse,
  type Meta,
  normalizePage,
  validateDateRange,
  type PageRequest,
  type ScopedRangeRequest,
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

export type ParsedRange = ScopedRangeRequest;
export type ParsedPage = { page: number; pageSize: number };
export type ParsedBreakdown = Omit<UsageBreakdownRequest, "page" | "pageSize"> & ParsedPage;

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

export function parseRange(params: URLSearchParams): { ok: true; range: ParsedRange } | { ok: false; failure: ApiFailure } {
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) {
    return { ok: false, failure: invalid(!from ? "from" : "to", "is required") };
  }
  const validation = validateDateRange({ from, to });
  if (!validation.ok) {
    if (validation.code === "date_range_too_large") {
      return { ok: false, failure: { code: validation.code, message: "The date range exceeds the maximum allowed length.", status: 400 } };
    }
    return { ok: false, failure: invalid("dateRange", "must contain valid ISO dates with from on or before to") };
  }

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
  return { ok: true, range: { from, to, ...(organizationIds.length ? { organizationIds } : {}) } };
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
  const range = parseRange(params);
  if (!range.ok) return range;
  const page = parsePage(params);
  if (!page.ok) return page;
  const kind = params.get("kind");
  if (!kind || !(breakdownKinds as readonly string[]).includes(kind)) {
    return { ok: false, failure: invalid("kind", `must be one of ${breakdownKinds.join(", ")}`) };
  }
  return { ok: true, breakdown: { ...range.range, ...page.page, kind: kind as ParsedBreakdown["kind"] } };
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

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  BUDGET_SOURCE_ERROR_STATUS,
  parseBudgetLookupRequest,
  type ApiErrorCode,
  type BudgetLookupErrorResponse,
} from "../../../../../shared/src/api";
import { apiResponse, responseHeaders } from "../../../usage/api";
import { BudgetLookupSourceError } from "../../../budget/client";
import { lookupBudget } from "../../../budget/service";

type BudgetErrorCode = BudgetLookupErrorResponse["error"]["code"];

const accessErrors: Record<ApiErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  date_range_too_large: { status: 400, message: "The request is invalid." },
  page_size_too_large: { status: 400, message: "The request is invalid." },
  unauthenticated: { status: 401, message: "Authentication is required." },
  forbidden: { status: 403, message: "You do not have permission to access this budget." },
  not_found: { status: 404, message: "The requested resource is not available." },
  per_user_detail_disabled: { status: 403, message: "Per-user budget access is disabled." },
  decimal_overflow: { status: 502, message: "The budget source returned an invalid amount." },
  permissions_unavailable: { status: 503, message: "Permissions are temporarily unavailable." },
  module_disabled: { status: 404, message: "The requested resource is not available." },
  rate_limited: { status: 429, message: "The budget source rate limit was reached." },
  internal_error: { status: 500, message: "The budget request could not be completed." },
};

function budgetError(
  code: BudgetErrorCode,
  message: string,
  status: number,
  correlationId: string,
  retryAfterSeconds?: number,
): NextResponse<BudgetLookupErrorResponse> {
  const headers = responseHeaders(correlationId);
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json({
    error: { code, message, correlationId },
  }, { status, headers });
}

function accessError(code: ApiErrorCode, correlationId: string): NextResponse<BudgetLookupErrorResponse> {
  const failure = accessErrors[code];
  return budgetError(code, failure.message, failure.status, correlationId);
}

function sourceError(error: BudgetLookupSourceError, correlationId: string): NextResponse<BudgetLookupErrorResponse> {
  if (error.code === "rate_limited") {
    return budgetError(
      error.code,
      "The budget source rate limit was reached.",
      429,
      correlationId,
      error.retryAfterSeconds,
    );
  }
  const message = error.code === "budget_source_timeout"
    ? "The budget source request timed out."
    : error.code === "budget_source_invalid" || error.code === "budget_source_incomplete"
      ? "The budget source returned invalid or incomplete data."
      : "The budget source is temporarily unavailable.";
  return budgetError(error.code, message, BUDGET_SOURCE_ERROR_STATUS[error.code], correlationId);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const parsed = parseBudgetLookupRequest(request.nextUrl.searchParams);
  if (!parsed.ok) return accessError("invalid_request", correlationId);

  try {
    const result = await lookupBudget(correlationId, parsed.request, undefined, request.signal);
    if (result.state === "ok") return apiResponse(result.data, correlationId);
    if (result.state === "denied") return accessError(result.code, correlationId);
    if (result.state === "unauthenticated") return accessError("unauthenticated", correlationId);
    if (result.state === "forbidden") return accessError("forbidden", correlationId);
    return accessError("permissions_unavailable", correlationId);
  } catch (error: unknown) {
    if (error instanceof BudgetLookupSourceError) return sourceError(error, correlationId);
    process.stderr.write(`${JSON.stringify({
      level: "error",
      event: "portal.budget_lookup_failed",
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })}\n`);
    return budgetError("internal_error", accessErrors.internal_error.message, 500, correlationId);
  }
}

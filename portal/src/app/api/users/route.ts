import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UserUsageResponse } from "../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../db/pool";
import { errorResponse, logUsageFailure, parsePageRequest, parseUsagePeriod, responseHeaders, responseMeta } from "../../../usage/api";
import { requireUsageAccess } from "../../../usage/route-auth";
import { getUserUsage, resolveUsageRange } from "../../../usage/sql-usage";

export async function GET(request: NextRequest): Promise<NextResponse<UserUsageResponse | { error: unknown }>> {
  const correlationId = randomUUID();
  try {
    const gate = await requireUsageAccess(correlationId);
    if (!gate.ok) return gate.response;
    if (!gate.access.namesVisible) {
      return errorResponse({
        code: "per_user_detail_disabled",
        message: "Per-user usage detail is disabled for this deployment.",
        status: 403,
      }, correlationId);
    }
    const parsedPeriod = parseUsagePeriod(request.nextUrl.searchParams);
    if (!parsedPeriod.ok) return errorResponse(parsedPeriod.failure, correlationId);
    const parsedPage = parsePageRequest(request.nextUrl.searchParams);
    if (!parsedPage.ok) return errorResponse(parsedPage.failure, correlationId);
    const pool = await getPortalSqlPool();
    const resolved = await resolveUsageRange(pool, parsedPeriod.period);
    if (!resolved.ok) {
      return errorResponse({ code: "invalid_request", message: "The requested usage period is not available.", status: 400 }, correlationId);
    }
    const result = await getUserUsage(pool, gate.access, { ...resolved.range, ...parsedPage.page }, correlationId);
    return NextResponse.json({
      meta: responseMeta(correlationId),
      data: result.rows,
      page: { ...parsedPage.page, totalItems: result.totalItems },
    }, { headers: responseHeaders(correlationId) });
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    return NextResponse.json(
      { error: { code: "internal_error", message: "The usage request could not be completed.", correlationId } },
      { status: 500, headers: responseHeaders(correlationId) },
    );
  }
}

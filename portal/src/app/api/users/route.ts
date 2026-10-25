import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UserUsageResponse } from "../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../db/pool";
import { errorResponse, logUsageFailure, parsePageRequest, parseRange, responseHeaders, responseMeta } from "../../../usage/api";
import { requireUsageAccess } from "../../../usage/route-auth";
import { getUserUsage } from "../../../usage/sql-usage";

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
    const parsedRange = parseRange(request.nextUrl.searchParams);
    if (!parsedRange.ok) return errorResponse(parsedRange.failure, correlationId);
    const parsedPage = parsePageRequest(request.nextUrl.searchParams);
    if (!parsedPage.ok) return errorResponse(parsedPage.failure, correlationId);
    const result = await getUserUsage(await getPortalSqlPool(), gate.access, { ...parsedRange.range, ...parsedPage.page }, correlationId);
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

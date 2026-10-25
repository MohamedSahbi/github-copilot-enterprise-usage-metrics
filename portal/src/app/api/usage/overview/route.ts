import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UsageOverviewResponse } from "../../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../../db/pool";
import { apiResponse, errorResponse, logUsageFailure, parseUsagePeriod, responseHeaders } from "../../../../usage/api";
import { requireUsageAccess } from "../../../../usage/route-auth";
import { getUsageOverview, resolveUsageRange } from "../../../../usage/sql-usage";

export async function GET(request: NextRequest): Promise<NextResponse<UsageOverviewResponse | { error: unknown }>> {
  const correlationId = randomUUID();
  try {
    const gate = await requireUsageAccess(correlationId);
    if (!gate.ok) return gate.response;
    const parsed = parseUsagePeriod(request.nextUrl.searchParams);
    if (!parsed.ok) return errorResponse(parsed.failure, correlationId);
    const pool = await getPortalSqlPool();
    const resolved = await resolveUsageRange(pool, parsed.period);
    if (!resolved.ok) {
      return errorResponse({ code: "invalid_request", message: "The requested usage period is not available.", status: 400 }, correlationId);
    }
    const data = await getUsageOverview(pool, gate.access, resolved.range, correlationId);
    return apiResponse(data, correlationId);
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    return NextResponse.json(
      { error: { code: "internal_error", message: "The usage request could not be completed.", correlationId } },
      { status: 500, headers: responseHeaders(correlationId) },
    );
  }
}

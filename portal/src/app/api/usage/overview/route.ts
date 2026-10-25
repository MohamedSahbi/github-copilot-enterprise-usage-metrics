import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UsageOverviewResponse } from "../../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../../db/pool";
import { apiResponse, errorResponse, logUsageFailure, parseRange, responseHeaders } from "../../../../usage/api";
import { requireUsageAccess } from "../../../../usage/route-auth";
import { getUsageOverview } from "../../../../usage/sql-usage";

export async function GET(request: NextRequest): Promise<NextResponse<UsageOverviewResponse | { error: unknown }>> {
  const correlationId = randomUUID();
  try {
    const gate = await requireUsageAccess(correlationId);
    if (!gate.ok) return gate.response;
    const parsed = parseRange(request.nextUrl.searchParams);
    if (!parsed.ok) return errorResponse(parsed.failure, correlationId);
    const data = await getUsageOverview(await getPortalSqlPool(), gate.access, parsed.range, correlationId);
    return apiResponse(data, correlationId);
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    return NextResponse.json(
      { error: { code: "internal_error", message: "The usage request could not be completed.", correlationId } },
      { status: 500, headers: responseHeaders(correlationId) },
    );
  }
}

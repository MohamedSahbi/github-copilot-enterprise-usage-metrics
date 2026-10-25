import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { UsageBreakdownResponse } from "../../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../../db/pool";
import { errorResponse, logUsageFailure, parseBreakdown, responseHeaders, responseMeta } from "../../../../usage/api";
import { requireUsageAccess } from "../../../../usage/route-auth";
import { getUsageBreakdown } from "../../../../usage/sql-usage";

export async function GET(request: NextRequest): Promise<NextResponse<UsageBreakdownResponse | { error: unknown }>> {
  const correlationId = randomUUID();
  try {
    const gate = await requireUsageAccess(correlationId);
    if (!gate.ok) return gate.response;
    const parsed = parseBreakdown(request.nextUrl.searchParams);
    if (!parsed.ok) return errorResponse(parsed.failure, correlationId);
    const result = await getUsageBreakdown(await getPortalSqlPool(), gate.access, parsed.breakdown, correlationId);
    const { page, pageSize } = parsed.breakdown;
    return NextResponse.json({
      meta: responseMeta(correlationId),
      data: result.rows,
      page: { page, pageSize, totalItems: result.totalItems },
    }, { headers: responseHeaders(correlationId) });
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    return NextResponse.json(
      { error: { code: "internal_error", message: "The usage request could not be completed.", correlationId } },
      { status: 500, headers: responseHeaders(correlationId) },
    );
  }
}

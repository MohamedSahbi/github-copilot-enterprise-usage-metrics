import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { ApiErrorResponse } from "../../../../../../shared/src/api";
import { errorResponse, logUsageFailure, responseHeaders } from "../../../../usage/api";
import { requireUsageAccess } from "../../../../usage/route-auth";

export async function GET(request: NextRequest): Promise<NextResponse<ApiErrorResponse>> {
  void request;
  const correlationId = randomUUID();
  try {
    const gate = await requireUsageAccess(correlationId);
    if (!gate.ok) return gate.response;
    return errorResponse({
      code: "not_found",
      message: "The requested resource is not available.",
      status: 404,
    }, correlationId);
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    return NextResponse.json(
      { error: { code: "internal_error", message: "The usage request could not be completed.", correlationId } },
      { status: 500, headers: responseHeaders(correlationId) },
    );
  }
}

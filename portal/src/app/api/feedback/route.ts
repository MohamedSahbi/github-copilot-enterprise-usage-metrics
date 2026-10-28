import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { FeedbackListResponse } from "../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../db/pool";
import { requireFeedbackAccess, feedbackFailure } from "../../../feedback/api";
import { listFeedback } from "../../../feedback/sql-feedback";
import { errorResponse, parsePage, responseHeaders, responseMeta } from "../../../usage/api";

export async function GET(request: NextRequest) {
  const correlationId = randomUUID();
  try {
    const gate = await requireFeedbackAccess(correlationId);
    if (!gate.ok) return gate.response;
    const paging = parsePage(request.nextUrl.searchParams);
    if (!paging.ok) return errorResponse(paging.failure, correlationId);
    const parsed = z.enum(["open", "planned", "done", "declined"]).optional()
      .safeParse(request.nextUrl.searchParams.get("status") ?? undefined);
    if (!parsed.success) {
      return errorResponse({ code: "invalid_request", message: "Invalid Feedback status.", status: 400 }, correlationId);
    }
    const result = await listFeedback(await getPortalSqlPool(), gate.access, { ...paging.page, status: parsed.data });
    const body: FeedbackListResponse = {
      meta: responseMeta(correlationId), data: result.rows,
      page: { ...paging.page, totalItems: result.totalItems },
    };
    return NextResponse.json(body, { headers: responseHeaders(correlationId) });
  } catch (error) {
    return feedbackFailure(correlationId, error);
  }
}

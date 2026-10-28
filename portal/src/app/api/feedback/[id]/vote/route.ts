import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { ApiResponse, FeedbackItemView } from "../../../../../../../shared/src/api";
import { getPortalSqlPool } from "../../../../../db/pool";
import { requireFeedbackAccess, feedbackFailure } from "../../../../../feedback/api";
import { toggleFeedbackVote } from "../../../../../feedback/sql-feedback";
import { errorResponse, responseHeaders, responseMeta } from "../../../../../usage/api";
import { isFeedbackMutationOrigin } from "../../../../../feedback/origin";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = randomUUID();
  try {
    const gate = await requireFeedbackAccess(correlationId);
    if (!gate.ok) return gate.response;
    const { id } = await params;
    const itemId = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(itemId)) {
      return errorResponse({ code: "invalid_request", message: "Invalid Feedback item ID.", status: 400 }, correlationId);
    }
    if (!isFeedbackMutationOrigin(request.headers.get("origin"))) {
      return errorResponse({ code: "forbidden", message: "A same-origin request is required.", status: 403 }, correlationId);
    }
    const item = await toggleFeedbackVote(await getPortalSqlPool(), gate.access, itemId);
    if (!item) return errorResponse({ code: "not_found", message: "Feedback item not found.", status: 404 }, correlationId);
    const body: ApiResponse<FeedbackItemView> = { meta: responseMeta(correlationId), data: item };
    return NextResponse.json(body, { headers: responseHeaders(correlationId) });
  } catch (error) {
    return feedbackFailure(correlationId, error);
  }
}

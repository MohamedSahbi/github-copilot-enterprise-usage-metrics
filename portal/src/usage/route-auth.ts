import type { NextResponse } from "next/server";
import type { ApiErrorResponse } from "../../../shared/src/api";
import { getAccess } from "../authz/server";
import { errorResponse, type AuthorizedUsageAccess } from "./api";

export async function requireUsageAccess(
  correlationId: string,
): Promise<{ ok: true; access: AuthorizedUsageAccess } | { ok: false; response: NextResponse<ApiErrorResponse> }> {
  const access = await getAccess(correlationId);
  if (access.state === "authorized") return { ok: true, access };
  if (access.state === "signed-out") {
    return { ok: false, response: errorResponse({ code: "unauthenticated", message: "Authentication is required.", status: 401 }, correlationId) };
  }
  if (access.state === "unavailable") {
    return { ok: false, response: errorResponse({ code: "permissions_unavailable", message: "Permissions are temporarily unavailable.", status: 503 }, correlationId) };
  }
  return { ok: false, response: errorResponse({ code: "forbidden", message: "You do not have permission to access usage data.", status: 403 }, correlationId) };
}

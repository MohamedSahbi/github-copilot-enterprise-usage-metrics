import { getAccess } from "../authz/server";
import { canAccess } from "../authz/access";
import { errorResponse } from "../usage/api";
import { feedbackEnabled } from "./access";

export async function requireFeedbackAccess(correlationId: string) {
  const access = await getAccess(correlationId);
  if (access.state === "signed-out") {
    return { ok: false, response: errorResponse({
      code: "unauthenticated", message: "Authentication is required.", status: 401,
    }, correlationId) } as const;
  }
  if (access.state === "unavailable") {
    return { ok: false, response: errorResponse({
      code: "permissions_unavailable", message: "Permissions are temporarily unavailable.", status: 503,
    }, correlationId) } as const;
  }
  if (access.state !== "authorized" || !canAccess(access, "feedback")) {
    return { ok: false, response: errorResponse({
      code: "forbidden", message: "You do not have permission to access Feedback.", status: 403,
    }, correlationId) } as const;
  }
  if (!feedbackEnabled()) {
    return { ok: false, response: errorResponse({
      code: "module_disabled", message: "Feedback is disabled.", status: 404,
    }, correlationId) } as const;
  }
  return { ok: true, access } as const;
}

export function feedbackFailure(correlationId: string, error: unknown) {
  process.stderr.write(`${JSON.stringify({
    level: "error", event: "portal.feedback_request_failed", correlationId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  })}\n`);
  return errorResponse({
    code: "internal_error", message: "The Feedback request could not be completed.", status: 500,
  }, correlationId);
}

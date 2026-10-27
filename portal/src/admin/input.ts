import { isGuid, type GrantRequestInput } from "../../../shared/src/access";
import { ISSUE_ACTIONS, type IssueActionRequest } from "../../../shared/src/issues";

export class AdminError extends Error {
  constructor(readonly code: string, readonly status = 422) {
    super(code);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminError("invalid_request");
  return value as Record<string, unknown>;
}

export type GrantInput = Omit<GrantRequestInput, "principalEntraObjectId"> & {
  principalEntraObjectId?: string;
  principalId?: string;
  action?: "grant" | "revoke";
};

export function parseGrantInput(value: unknown, mode: "create" | "legacy"): GrantInput {
  const body = object(value);
  const target = mode === "create" ? "principalEntraObjectId" : "principalId";
  const fields = [target, "role", "scope", "scopeValue", ...(mode === "legacy" ? ["action"] : [])];
  if (Object.keys(body).some((key) => !fields.includes(key)) ||
    typeof body[target] !== "string" || !isGuid(body[target]) ||
    typeof body.role !== "string" || body.role.length > 12 ||
    typeof body.scope !== "string" || body.scope.length > 16 ||
    (body.scopeValue !== undefined && (typeof body.scopeValue !== "string" || body.scopeValue.length > 128)) ||
    (mode === "legacy" && body.action !== "grant" && body.action !== "revoke")) {
    throw new AdminError("invalid_request");
  }
  return body as GrantInput;
}

export function parseIssueInput(value: unknown): IssueActionRequest {
  const body = object(value);
  if (Object.keys(body).some((key) => !["issueId", "action", "confirm", "confirmDate"].includes(key)) ||
    !Number.isSafeInteger(body.issueId) || Number(body.issueId) < 1 ||
    typeof body.action !== "string" || !Object.values(ISSUE_ACTIONS).flat().some((action) => action === body.action) ||
    typeof body.confirm !== "boolean" ||
    (body.confirmDate !== undefined && (typeof body.confirmDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.confirmDate)))) {
    throw new AdminError("invalid_request");
  }
  return {
    issueId: Number(body.issueId), action: body.action, confirm: body.confirm,
    ...(typeof body.confirmDate === "string" ? { confirmDate: body.confirmDate } : {}),
  };
}

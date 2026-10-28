import { canAccess, type AccessResult } from "../authz/access";

export function feedbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.MODULE_FEEDBACK;
  if (flag === undefined || flag === "false") return false;
  if (flag === "true") return true;
  throw new Error("MODULE_FEEDBACK must be true or false");
}

export function canViewFeedbackItem(
  access: AccessResult,
  item: { visibility: string; author_principal_id: string },
): boolean {
  if (access.state !== "authorized" || !canAccess(access, "feedback")) return false;
  if (item.visibility !== "everyone" && item.visibility !== "admins") return false;
  return item.visibility === "everyone" ||
    access.grants.some(({ role }) => role === "admin") ||
    item.author_principal_id.toLowerCase() === access.principal.principal_id.toLowerCase();
}

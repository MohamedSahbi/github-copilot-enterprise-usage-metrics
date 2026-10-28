import type { BudgetLookupRequest } from "../../../shared/src/api";
import { resolveBudgetLookupRequestAccess } from "./request-access";
import { BudgetLookupSourceError, createBudgetLookupClient } from "./client";
import { mapBudgetLookupSource } from "./mapper";
import { recordBudgetLookupPermission } from "./health";

export async function lookupBudget(
  correlationId: string,
  request: BudgetLookupRequest,
  now?: Date,
  requestSignal?: AbortSignal,
) {
  const access = await resolveBudgetLookupRequestAccess(correlationId, request, now);
  if (access.state !== "authorized") return access;

  const token = process.env.BUDGET_LOOKUP_KEY;
  const enterprise = process.env.ENTERPRISE_SLUG;
  if (!token || !enterprise) {
    throw new BudgetLookupSourceError("budget_source_unavailable", "The budget source is not configured.");
  }

  const source = await createBudgetLookupClient({
    token,
    enterprise,
    onPermissionObservation: recordBudgetLookupPermission,
  }).read(access.login, requestSignal);
  return {
    state: "ok" as const,
    data: mapBudgetLookupSource(source, access.login, access.userId),
  };
}

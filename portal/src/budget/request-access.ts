import { auth } from "../auth/config";
import type { BudgetLookupRequest } from "../../../shared/src/api";
import {
  logBudgetLookupAccessUnavailable,
  resolveBudgetLookupAccess,
} from "./access";
import type { BudgetLookupAccess } from "./access";

export async function resolveBudgetLookupRequestAccess(
  correlationId: string,
  request: BudgetLookupRequest,
  now?: Date,
): Promise<BudgetLookupAccess> {
  const sessionResult = await auth().then(
    (session) => ({ ok: true as const, session }),
    () => ({ ok: false as const }),
  );
  if (!sessionResult.ok) {
    logBudgetLookupAccessUnavailable(correlationId);
    return { state: "permissions_unavailable" };
  }
  return resolveBudgetLookupAccess(correlationId, sessionResult.session?.identity ?? null, request, now);
}

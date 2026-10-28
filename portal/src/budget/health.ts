import "server-only";

type PermissionObservation =
  | { state: "unobserved"; observedAt: null }
  | { state: "allowed" | "denied"; observedAt: string };

// Historical, instance-local evidence only; never a current permission guarantee.
let permission: PermissionObservation = { state: "unobserved", observedAt: null };

export function recordBudgetLookupPermission(status: 200 | 401 | 403): void {
  permission = {
    state: status === 200 ? "allowed" : "denied",
    observedAt: new Date().toISOString(),
  };
}

// The Admin caller must apply its existing HEALTH authorization before reading.
export function readBudgetLookupHealth(): {
  credentialConfigured: boolean;
  permission: PermissionObservation;
} {
  return {
    credentialConfigured: Boolean(process.env.BUDGET_LOOKUP_KEY?.trim()),
    permission: { ...permission },
  };
}

// Access model contract (issue #44, items 1, 2, 6, 7): which role may hold which scope, and the grant validator
// shared by the admin API and the grant form. Permissions attach to one principal keyed on the Entra object ID (D-5, D-36).

import type { Role, Scope } from "./rows";

export const ROLES = ["user", "manager", "executive", "admin"] as const satisfies readonly Role[];
export const SCOPES = ["self", "team", "department", "business_area", "company"] as const satisfies readonly Scope[];

export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
  user: ["self"],
  manager: ["self", "team"],
  executive: ["department", "business_area", "company"],
  admin: ["company"],
};

// Scopes whose grant carries a value taken from the directory; the others must have an empty value.
export const VALUED_SCOPES = ["department", "business_area"] as const satisfies readonly Scope[];

export function isValidRoleScope(role: string, scope: string): role is Role {
  return (ROLES as readonly string[]).includes(role) && (ROLE_SCOPES[role as Role] as readonly string[]).includes(scope);
}

export function isValuedScope(scope: Scope): boolean {
  return (VALUED_SCOPES as readonly string[]).includes(scope);
}

export interface DirectoryAttributeSettings {
  departmentAttribute: string;
  businessAreaAttribute: string;
}

// An empty attribute name disables that scope: no grant of that scope is accepted.
export function enabledScopes(attrs: DirectoryAttributeSettings): Scope[] {
  return SCOPES.filter(
    (s) =>
      (s !== "department" || attrs.departmentAttribute.trim() !== "") &&
      (s !== "business_area" || attrs.businessAreaAttribute.trim() !== ""),
  );
}

export type GrantErrorCode = "scope_disabled" | "invalid_role_scope" | "unknown_scope_value" | "principal_not_linked";

export interface GrantRequestInput {
  principalEntraObjectId: string;
  role: string;
  scope: string;
  scopeValue?: string;
}

export interface ValidGrant {
  principalEntraObjectId: string;
  role: Role;
  scope: Scope;
  scopeValue: string;
}

export interface GrantValidationContext {
  enabledScopes: readonly Scope[];
  // Distinct, already normalized values present in the directory, per valued scope.
  directoryValues: { department: readonly string[]; business_area: readonly string[] };
  // True only when the principal has a stored Entra object ID (a GitHub-only principal cannot hold grants).
  principalHasLinkedEntraId: boolean;
}

export type GrantValidation = { ok: true; grant: ValidGrant } | { ok: false; code: GrantErrorCode | "invalid_request" };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string): boolean => GUID.test(v);

export function normalizeScopeValue(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase();
}

// Order is fixed so every caller reports the same error: pair, scope enabled, principal link, scope value.
export function validateGrantRequest(req: GrantRequestInput, ctx: GrantValidationContext): GrantValidation {
  if (!isValidRoleScope(req.role, req.scope)) return { ok: false, code: "invalid_role_scope" };
  const scope = req.scope as Scope;
  if (!ctx.enabledScopes.includes(scope)) return { ok: false, code: "scope_disabled" };
  if (!ctx.principalHasLinkedEntraId || !isGuid(req.principalEntraObjectId)) return { ok: false, code: "principal_not_linked" };
  const value = normalizeScopeValue(req.scopeValue ?? "");
  if (scope === "department" || scope === "business_area") {
    if (value === "" || !ctx.directoryValues[scope].includes(value)) return { ok: false, code: "unknown_scope_value" };
  } else if (value !== "") {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, grant: { principalEntraObjectId: req.principalEntraObjectId, role: req.role, scope, scopeValue: value } };
}

import { describe, expect, it } from "vitest";
import { ROLES, ROLE_SCOPES, SCOPES, enabledScopes, isValidRoleScope, validateGrantRequest } from "./access";
import type { GrantValidationContext } from "./access";
import { suppressForScope } from "./api";

const OID = "11111111-1111-1111-1111-111111111111";
const ctx = (over: Partial<GrantValidationContext> = {}): GrantValidationContext => ({
  enabledScopes: ["self", "team", "department", "business_area", "company"],
  directoryValues: { department: ["engineering"], business_area: ["sales"] },
  principalHasLinkedEntraId: true,
  ...over,
});
const req = (role: string, scope: string, scopeValue?: string) => ({ principalEntraObjectId: OID, role, scope, scopeValue });

describe("role/scope matrix (issue #44 item 1)", () => {
  it("allows exactly the agreed pairs", () => {
    expect(ROLE_SCOPES).toEqual({
      user: ["self"],
      manager: ["self", "team"],
      executive: ["department", "business_area", "company"],
      admin: ["company"],
    });
    const valid = ROLES.flatMap((r) => SCOPES.filter((s) => isValidRoleScope(r, s)).map((s) => `${r}:${s}`));
    expect(valid).toEqual([
      "user:self", "manager:self", "manager:team", "executive:department", "executive:business_area", "executive:company", "admin:company",
    ]);
  });

  it("rejects values outside the role and scope sets", () => {
    expect(isValidRoleScope("user", "company")).toBe(false);
    expect(isValidRoleScope("superuser", "company")).toBe(false);
    expect(isValidRoleScope("admin", "galaxy")).toBe(false);
  });
});

describe("enabledScopes (item 6)", () => {
  it("disables department and business_area when their attribute is empty", () => {
    expect(enabledScopes({ departmentAttribute: "", businessAreaAttribute: "" })).toEqual(["self", "team", "company"]);
    expect(enabledScopes({ departmentAttribute: "department", businessAreaAttribute: "" })).toEqual(["self", "team", "department", "company"]);
    expect(enabledScopes({ departmentAttribute: " ", businessAreaAttribute: "x" })).toEqual(["self", "team", "business_area", "company"]);
  });
});

describe("validateGrantRequest (items 1, 2, 7)", () => {
  it("accepts a valid executive business_area grant", () => {
    expect(validateGrantRequest(req("executive", "business_area", "Sales"), ctx())).toEqual({
      ok: true,
      grant: { principalEntraObjectId: OID, role: "executive", scope: "business_area", scopeValue: "sales" },
    });
  });

  it("returns invalid_role_scope for a pair that is not allowed", () => {
    expect(validateGrantRequest(req("user", "company"), ctx())).toEqual({ ok: false, code: "invalid_role_scope" });
    expect(validateGrantRequest(req("bogus", "self"), ctx())).toEqual({ ok: false, code: "invalid_role_scope" });
  });

  it("returns scope_disabled when the attribute for the scope is empty", () => {
    const c = ctx({ enabledScopes: ["self", "team", "company"] });
    expect(validateGrantRequest(req("executive", "business_area", "sales"), c)).toEqual({ ok: false, code: "scope_disabled" });
  });

  it("returns principal_not_linked for a GitHub-only principal", () => {
    const c = ctx({ principalHasLinkedEntraId: false });
    expect(validateGrantRequest(req("user", "self"), c)).toEqual({ ok: false, code: "principal_not_linked" });
  });

  it("rejects a malformed Entra object ID as principal_not_linked", () => {
    expect(validateGrantRequest({ ...req("user", "self"), principalEntraObjectId: "alice@example.com" }, ctx())).toEqual({
      ok: false,
      code: "principal_not_linked",
    });
  });

  it("returns unknown_scope_value when the value is not in the directory", () => {
    expect(validateGrantRequest(req("executive", "department", "Marketing"), ctx())).toEqual({ ok: false, code: "unknown_scope_value" });
    expect(validateGrantRequest(req("executive", "department"), ctx())).toEqual({ ok: false, code: "unknown_scope_value" });
  });

  it("requires an empty scope value for self, team and company", () => {
    expect(validateGrantRequest(req("admin", "company", "sales"), ctx())).toEqual({ ok: false, code: "invalid_request" });
    expect(validateGrantRequest(req("admin", "company"), ctx())).toMatchObject({ ok: true });
  });

  it("checks in a fixed order: pair, then scope enabled, then link, then value", () => {
    const c = ctx({ enabledScopes: ["self"], principalHasLinkedEntraId: false });
    expect(validateGrantRequest(req("user", "company"), c)).toMatchObject({ code: "invalid_role_scope" });
    expect(validateGrantRequest(req("executive", "department", "x"), c)).toMatchObject({ code: "scope_disabled" });
    expect(validateGrantRequest(req("user", "self"), c)).toMatchObject({ code: "principal_not_linked" });
  });
});

describe("minimum group size applies to every scope (item 11)", () => {
  it.each(SCOPES)("suppresses a %s group below 5 users, even with a lowered setting", (scope) => {
    expect(suppressForScope(scope, 4, 1, { n: 1 }, false)).toEqual({ suppressed: true, userCount: null, value: null });
    expect(suppressForScope(scope, 5, 1, { n: 1 }, false).suppressed).toBe(false);
  });

  it("shows a business area with fewer than 5 users as suppressed", () => {
    expect(suppressForScope("business_area", 3, 5, { n: 1 }, false).suppressed).toBe(true);
  });
});

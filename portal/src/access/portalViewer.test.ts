import { describe, expect, it } from "vitest";
import type { AccessResult, AccessScopedUser } from "../authz/access";
import type { Role, Scope } from "../../../shared/src/rows";
import { portalViewerFromAccess } from "./portalViewer";

const principal = {
  principal_id: "00000000-0000-4000-8000-000000000001",
  entra_tenant_id: "00000000-0000-4000-8000-000000000002",
  entra_object_id: "00000000-0000-4000-8000-000000000003",
  github_user_id: null,
  status: "active" as const,
};

function authorized(role: string, scope: string, scopeValue = "", namesVisible = false): AccessResult {
  return {
    state: "authorized",
    breakGlass: false,
    principal,
    grants: [{ role: role as Role, scope: scope as Scope, scope_value: scopeValue }],
    namesVisible,
  };
}

const directoryUsers: AccessScopedUser[] = [
  {
    user_id: 1000003,
    entra_object_id: "10000000-0000-4000-8000-000000100003",
    manager_entra_object_id: principal.entra_object_id,
    department: "department-a",
    business_area: "business-area-a",
  },
  {
    user_id: 1000007,
    entra_object_id: "10000000-0000-4000-8000-000000100007",
    manager_entra_object_id: "10000000-0000-4000-8000-000000100003",
    department: "department-a",
    business_area: "business-area-a",
  },
];

describe("portal viewer access mapping", () => {
  it("maps signed-out, no-access, and unavailable states without granting a role", () => {
    expect(portalViewerFromAccess({ state: "signed-out", breakGlass: false })).toMatchObject({
      accessState: "signed-out",
      authenticated: false,
      allowedUserIds: [],
      scopeOptions: [],
    });
    expect(portalViewerFromAccess({ state: "no-access", breakGlass: false })).toMatchObject({
      accessState: "no-access",
      role: "no-access",
      allowedUserIds: [],
    });
    expect(portalViewerFromAccess({ state: "unavailable", breakGlass: false })).toMatchObject({
      accessState: "unavailable",
      role: "unavailable",
      allowedUserIds: [],
    });
  });

  it("maps an authorized team grant and only its server-resolved report IDs", () => {
    const viewer = portalViewerFromAccess(authorized("manager", "team"), directoryUsers);

    expect(viewer).toMatchObject({
      accessState: "authorized",
      role: "manager",
      allowedUserIds: [1000003, 1000007],
      perUserDetailEnabled: false,
    });
    expect(viewer.scopeOptions).toEqual([
      { kind: "team", value: "team", label: "My reports", userIds: [1000003, 1000007] },
      { kind: "business_area", value: "business-area-a", label: "business area a", userIds: [1000003, 1000007] },
      { kind: "department", value: "department-a", label: "department a", userIds: [1000003, 1000007] },
    ]);
  });

  it("maps company grants to admin navigation and honors per-user deployment permission", () => {
    const viewer = portalViewerFromAccess(authorized("admin", "company", "", true), directoryUsers);

    expect(viewer.role).toBe("admin");
    expect(viewer.perUserDetailEnabled).toBe(true);
    expect(viewer.scopeOptions[0]).toEqual({
      kind: "all",
      value: "all",
      label: "All available data",
      userIds: [1000003, 1000007],
    });
  });

  it("fails closed for an unknown access state or role", () => {
    expect(portalViewerFromAccess({ state: "unexpected" } as unknown as AccessResult).accessState).toBe("unavailable");
    expect(portalViewerFromAccess(authorized("owner", "company"), directoryUsers).role).toBe("unavailable");
  });
});

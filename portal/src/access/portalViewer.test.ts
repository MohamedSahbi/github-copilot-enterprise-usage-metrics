import { describe, expect, it } from "vitest";
import type { AccessResult, AccessScopedUser } from "../authz/access";
import type { Role, Scope } from "../../../shared/src/rows";
import { portalViewerFromAccess, resolvePortalScope } from "./portalViewer";

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

  it("maps an authorized team grant without inventing dimension or team scopes", () => {
    const viewer = portalViewerFromAccess(authorized("manager", "team"), directoryUsers);

    expect(viewer).toMatchObject({
      accessState: "authorized",
      role: "manager",
      allowedUserIds: [1000003, 1000007],
      perUserDetailEnabled: false,
    });
    expect(viewer.scopeOptions).toEqual([
      { kind: "team", value: "team", label: "My reports", userIds: [1000003, 1000007] },
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
    expect(viewer.scopeOptions).toHaveLength(1);
  });

  it("offers only exact held department and business-area grants", () => {
    const access = authorized("executive", "department", "held-department");
    if (access.state !== "authorized") throw new Error("Expected authorized access");
    access.grants.push({ role: "executive", scope: "business_area", scope_value: "held-area" });
    const viewer = portalViewerFromAccess(access, directoryUsers);

    expect(viewer.scopeOptions.map(({ kind, value, label }) => ({ kind, value, label }))).toEqual([
      { kind: "department", value: "held-department", label: "held department" },
      { kind: "business_area", value: "held-area", label: "held area" },
    ]);
  });

  it("deduplicates repeated exact grants when building scope options", () => {
    const access = authorized("executive", "department", "department-a");
    if (access.state !== "authorized") throw new Error("Expected authorized access");
    access.grants.push({ ...access.grants[0]! });

    expect(portalViewerFromAccess(access, directoryUsers).scopeOptions).toEqual([
      {
        kind: "department",
        value: "department-a",
        label: "department a",
        userIds: [1000003, 1000007],
      },
    ]);
  });

  it("defaults only when scope is omitted and rejects malformed, repeated, or stale tokens", () => {
    const viewer = portalViewerFromAccess(authorized("manager", "team"), directoryUsers);

    expect(resolvePortalScope(viewer)).toMatchObject({ kind: "team", value: "team" });
    expect(resolvePortalScope(viewer, "team:team")).toMatchObject({ kind: "team", value: "team" });
    expect(resolvePortalScope(viewer, "")).toBeNull();
    expect(resolvePortalScope(viewer, "team")).toBeNull();
    expect(resolvePortalScope(viewer, "team:team-1")).toBeNull();
    expect(resolvePortalScope(viewer, "department:department-a")).toBeNull();
    expect(resolvePortalScope(viewer, ["team:team", "team:team"])).toBeNull();
  });

  it("fails closed for an unknown access state or role", () => {
    expect(portalViewerFromAccess({ state: "unexpected" } as unknown as AccessResult).accessState).toBe("unavailable");
    expect(portalViewerFromAccess(authorized("owner", "company"), directoryUsers).role).toBe("unavailable");
  });
});

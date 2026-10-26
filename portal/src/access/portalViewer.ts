import type { AccessResult, AccessScopedUser } from "../authz/access";

export type PortalScopeKind = "all" | "business_area" | "department" | "team" | "self";

export interface PortalScopeOption {
  kind: PortalScopeKind;
  value: string;
  label: string;
  userIds: number[];
}

export interface PortalViewer {
  accessState: "signed-out" | "no-access" | "unavailable" | "authorized";
  displayName: string;
  role: "admin" | "executive" | "manager" | "member" | "no-access" | "anonymous" | "unavailable";
  authenticated: boolean;
  perUserDetailEnabled: boolean;
  scopeOptions: PortalScopeOption[];
  allowedUserIds: number[];
}

export type PortalScopeSelection = PortalScopeOption;

const EMPTY_VIEWER: Omit<PortalViewer, "accessState" | "role" | "authenticated"> = {
  displayName: "Portal user",
  perUserDetailEnabled: false,
  scopeOptions: [],
  allowedUserIds: [],
};

function deniedViewer(accessState: PortalViewer["accessState"]): PortalViewer {
  return {
    ...EMPTY_VIEWER,
    accessState,
    role: accessState === "signed-out" ? "anonymous" : accessState === "no-access" ? "no-access" : "unavailable",
    authenticated: accessState !== "signed-out",
  };
}

function roleForAccess(access: Extract<AccessResult, { state: "authorized" }>): PortalViewer["role"] | null {
  const roles = new Set(access.grants.map(({ role }) => role));
  if ([...roles].some((role) => !["admin", "executive", "manager", "user"].includes(role))) return null;
  if (roles.has("admin")) return "admin";
  if (roles.has("executive")) return "executive";
  if (roles.has("manager")) return "manager";
  if (roles.has("user")) return "member";
  return null;
}

function labelFor(value: string): string {
  return value.replaceAll("-", " ");
}

function uniqueUsers(users: readonly AccessScopedUser[]): number[] {
  return [...new Set(users.map(({ user_id }) => user_id).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

function uniqueUserIds(userIds: readonly number[]): number[] {
  return [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

function teamUserIds(users: readonly AccessScopedUser[], managerObjectId: string): number[] {
  const children = new Map<string, AccessScopedUser[]>();
  for (const user of users) {
    const manager = user.manager_entra_object_id?.toLowerCase();
    if (manager) children.set(manager, [...(children.get(manager) ?? []), user]);
  }

  const userIds = new Set<number>();
  const visitedManagers = new Set<string>([managerObjectId.toLowerCase()]);
  const pending = [managerObjectId.toLowerCase()];
  while (pending.length > 0) {
    const manager = pending.pop()!;
    for (const member of children.get(manager) ?? []) {
      userIds.add(member.user_id);
      const objectId = member.entra_object_id?.toLowerCase();
      if (objectId && !visitedManagers.has(objectId)) {
        visitedManagers.add(objectId);
        pending.push(objectId);
      }
    }
  }
  return [...userIds].sort((a, b) => a - b);
}

function scopeOptionsFor(
  access: Extract<AccessResult, { state: "authorized" }>,
  users: readonly AccessScopedUser[],
  principalObjectId: string,
): PortalScopeOption[] {
  const allowedUserIds = uniqueUsers(users);
  const options = new Map<string, PortalScopeOption>();
  const add = (option: PortalScopeOption) => {
    const key = `${option.kind}:${option.value}`;
    const existing = options.get(key);
    options.set(key, existing
      ? { ...existing, userIds: uniqueUserIds([...existing.userIds, ...option.userIds]) }
      : { ...option, userIds: option.userIds.filter((id) => allowedUserIds.includes(id)) });
  };

  const normalizedPrincipalObjectId = principalObjectId.toLowerCase();
  for (const grant of access.grants) {
    if (grant.scope === "company") {
      add({ kind: "all", value: "all", label: "All available data", userIds: allowedUserIds });
    } else if (grant.scope === "team") {
      add({
        kind: "team",
        value: "team",
        label: "My reports",
        userIds: teamUserIds(users, normalizedPrincipalObjectId),
      });
    } else if (grant.scope === "self") {
      add({
        kind: "self",
        value: "self",
        label: "Self",
        userIds: users
          .filter(({ entra_object_id }) => entra_object_id?.toLowerCase() === normalizedPrincipalObjectId)
          .map(({ user_id }) => user_id),
      });
    } else if (grant.scope === "department" || grant.scope === "business_area") {
      const kind = grant.scope;
      const value = grant.scope_value.trim().toLowerCase();
      if (!value) continue;
      const attribute = kind === "department" ? "department" : "business_area";
      add({
        kind,
        value,
        label: labelFor(value),
        userIds: users
          .filter((user) => user[attribute]?.trim().toLowerCase() === value)
          .map(({ user_id }) => user_id),
      });
    }
  }
  return [...options.values()];
}

export function portalViewerFromAccess(
  access: AccessResult,
  users: readonly AccessScopedUser[] = [],
): PortalViewer {
  if (!access || typeof access !== "object" || !("state" in access)) return deniedViewer("unavailable");
  switch (access.state) {
    case "signed-out":
      return deniedViewer("signed-out");
    case "no-access":
      return deniedViewer("no-access");
    case "unavailable":
      return deniedViewer("unavailable");
    case "authorized": {
      const role = roleForAccess(access);
      const principalObjectId = access.principal.entra_object_id;
      if (!role || !access.grants.length || !principalObjectId) return deniedViewer("unavailable");
      return {
        ...EMPTY_VIEWER,
        accessState: "authorized",
        role,
        authenticated: true,
        perUserDetailEnabled: access.namesVisible,
        scopeOptions: scopeOptionsFor(access, users, principalObjectId),
        allowedUserIds: uniqueUsers(users),
      };
    }
    default:
      return deniedViewer("unavailable");
  }
}

export function resolvePortalScope(
  viewer: PortalViewer,
  requestedScope?: string | string[],
): PortalScopeSelection | null {
  if (viewer.accessState !== "authorized") return null;
  let option: PortalScopeOption | undefined;
  if (requestedScope === undefined) {
    option = viewer.role === "admin"
      ? viewer.scopeOptions.find(({ kind }) => kind === "all")
      : viewer.scopeOptions[0];
  } else {
    if (typeof requestedScope !== "string" || requestedScope.length === 0) return null;
    const separator = requestedScope.indexOf(":");
    if (separator <= 0 || separator === requestedScope.length - 1) return null;
    const kind = requestedScope.slice(0, separator);
    const value = requestedScope.slice(separator + 1);
    option = viewer.scopeOptions.find((scope) => scope.kind === kind && scope.value === value);
  }
  if (!option) return null;

  const allowed = new Set(viewer.allowedUserIds);
  return { ...option, userIds: option.userIds.filter((userId) => allowed.has(userId)) };
}

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

function dimensionOptions(
  kind: "business_area" | "department",
  users: readonly AccessScopedUser[],
): PortalScopeOption[] {
  const column = kind === "business_area" ? "business_area" : "department";
  const grouped = new Map<string, number[]>();
  for (const user of users) {
    const value = user[column]?.trim().toLowerCase();
    if (!value) continue;
    grouped.set(value, [...(grouped.get(value) ?? []), user.user_id]);
  }
  return [...grouped].map(([value, userIds]) => ({ kind, value, label: labelFor(value), userIds: uniqueUsers(users.filter(({ user_id }) => userIds.includes(user_id))) }));
}

function teamOptions(users: readonly AccessScopedUser[]): PortalScopeOption[] {
  const byObjectId = new Map(users.flatMap((user) => user.entra_object_id ? [[user.entra_object_id.toLowerCase(), user] as const] : []));
  const children = new Map<string, AccessScopedUser[]>();
  for (const user of users) {
    const manager = user.manager_entra_object_id?.toLowerCase();
    if (manager && byObjectId.has(manager)) children.set(manager, [...(children.get(manager) ?? []), user]);
  }

  const teams: PortalScopeOption[] = [];
  for (const manager of users) {
    if (!manager.entra_object_id) continue;
    const userIds = new Set<number>([manager.user_id]);
    const pending = [...(children.get(manager.entra_object_id.toLowerCase()) ?? [])];
    while (pending.length) {
      const member = pending.pop()!;
      if (userIds.has(member.user_id)) continue;
      userIds.add(member.user_id);
      if (member.entra_object_id) pending.push(...(children.get(member.entra_object_id.toLowerCase()) ?? []));
    }
    if (userIds.size > 1) {
      const number = teams.length + 1;
      teams.push({ kind: "team", value: `team-${number}`, label: `Team ${number}`, userIds: [...userIds].sort((a, b) => a - b) });
    }
  }
  return teams;
}

function scopeOptionsFor(
  access: Extract<AccessResult, { state: "authorized" }>,
  users: readonly AccessScopedUser[],
): PortalScopeOption[] {
  const allowedUserIds = uniqueUsers(users);
  const options = new Map<string, PortalScopeOption>();
  const add = (option: PortalScopeOption) => {
    const key = `${option.kind}:${option.value}`;
    const existing = options.get(key);
    options.set(key, existing
      ? { ...existing, userIds: uniqueUsers([...users.filter(({ user_id }) => existing.userIds.includes(user_id)), ...users.filter(({ user_id }) => option.userIds.includes(user_id))]) }
      : { ...option, userIds: option.userIds.filter((id) => allowedUserIds.includes(id)) });
  };

  for (const grant of access.grants) {
    if (grant.scope === "company") add({ kind: "all", value: "all", label: "All available data", userIds: allowedUserIds });
    if (grant.scope === "team") add({ kind: "team", value: "team", label: "My reports", userIds: allowedUserIds });
    if (grant.scope === "self") add({ kind: "self", value: "self", label: "Self", userIds: allowedUserIds });
    if (grant.scope === "department" || grant.scope === "business_area") {
      const kind = grant.scope;
      add({
        kind,
        value: grant.scope_value.trim().toLowerCase(),
        label: labelFor(grant.scope_value.trim().toLowerCase()),
        userIds: allowedUserIds,
      });
    }
  }

  const canNarrow = access.grants.some(({ scope }) =>
    scope === "company" || scope === "team" || scope === "department" || scope === "business_area",
  );
  if (canNarrow) {
    for (const option of dimensionOptions("business_area", users)) add(option);
    for (const option of dimensionOptions("department", users)) add(option);
  }
  if (access.grants.some(({ scope }) => scope === "company")) {
    for (const option of teamOptions(users)) add(option);
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
      if (!role || !access.grants.length) return deniedViewer("unavailable");
      return {
        ...EMPTY_VIEWER,
        accessState: "authorized",
        role,
        authenticated: true,
        perUserDetailEnabled: access.namesVisible,
        scopeOptions: scopeOptionsFor(access, users),
        allowedUserIds: uniqueUsers(users),
      };
    }
    default:
      return deniedViewer("unavailable");
  }
}

export function resolvePortalScope(
  viewer: PortalViewer,
  requestedKind?: string,
  requestedValue?: string,
): PortalScopeSelection | null {
  if (viewer.accessState !== "authorized") return null;
  const selected = viewer.scopeOptions.find(
    ({ kind, value }) => kind === requestedKind && value === requestedValue,
  );
  const defaultSelection = viewer.role === "admin"
    ? viewer.scopeOptions.find(({ kind }) => kind === "all")
    : viewer.scopeOptions[0];
  const option = selected ?? defaultSelection;
  if (!option) return null;

  const allowed = new Set(viewer.allowedUserIds);
  return { ...option, userIds: option.userIds.filter((userId) => allowed.has(userId)) };
}

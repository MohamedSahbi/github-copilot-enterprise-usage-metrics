import type { PrincipalRow, Role, Scope } from "../../../shared/src/rows";
import { enabledScopes, isValidRoleScope } from "../../../shared/src/access";
import type { AccessSettings } from "../auth/settings";
import { isSqlConnectivityOutage } from "./sql-connectivity";

export type Identity =
  | { provider: "entra"; tenantId: string; objectId: string; groups: string[]; groupsVerifiedAt?: number }
  | { provider: "github"; userId: number };

export type Grant = { role: Role; scope: Scope; scope_value: string };
export type Principal = Pick<PrincipalRow, "principal_id" | "entra_tenant_id" | "entra_object_id" | "github_user_id" | "status">;
export interface AccessScopedUser {
  user_id: number;
  entra_object_id: string | null;
  manager_entra_object_id: string | null;
  department: string | null;
  business_area: string | null;
}
export interface AccessSnapshot {
  principal: Principal | null;
  grants: Grant[];
  sync: { source: string; last_success_at: Date | null }[];
  teamAvailable?: boolean;
}
export interface AccessRepository {
  read(identity: Identity): Promise<AccessSnapshot>;
}
export type AccessResult =
  | { state: "signed-out"; breakGlass: false }
  | { state: "no-access" | "unavailable"; breakGlass: boolean }
  | { state: "authorized"; breakGlass: boolean; principal: Principal; grants: Grant[]; namesVisible: boolean };

// DATETIME2(0) rounds SYSUTCDATETIME() to the nearest second, so a fresh sync can read back up to 0.5 s in the future.
const FUTURE_SYNC_TOLERANCE_MS = 500;

export async function resolveAccess(
  identity: Identity | null,
  repository: AccessRepository,
  settings: AccessSettings,
  now = new Date(),
): Promise<AccessResult> {
  if (!identity) return { state: "signed-out", breakGlass: false };
  const groupAge = identity.provider === "entra" && identity.groupsVerifiedAt !== undefined
    ? now.getTime() - identity.groupsVerifiedAt : Infinity;
  const breakGlass = identity.provider === "entra" && settings.breakGlassGroupId !== "" &&
    groupAge >= 0 && groupAge < settings.permissionFreshnessMinutes * 60000 &&
    identity.groups.some((g) => g.toLowerCase() === settings.breakGlassGroupId.toLowerCase());
  // No permission cache: every request reads the authoritative grant view, so revocations apply immediately.
  let snapshot: AccessSnapshot;
  try {
    snapshot = await repository.read(identity);
  } catch (error) {
    return { state: "unavailable", breakGlass: breakGlass && isSqlConnectivityOutage(error) };
  }
  const { principal, sync } = snapshot;
  if (!principal || principal.status !== "active" || !principal.entra_object_id || !principal.entra_tenant_id) {
    return { state: "no-access", breakGlass: false };
  }
  const directoryFresh = settings.directorySources.every((source) => {
    const success = sync.find((s) => s.source === source)?.last_success_at;
    const age = success ? now.getTime() - success.getTime() : Infinity;
    return age >= -FUTURE_SYNC_TOLERANCE_MS && age <= settings.directoryStaleHours * 3600000;
  });
  const scopes = enabledScopes(settings.directory);
  const grants = snapshot.grants.filter((g) => isValidRoleScope(g.role, g.scope) && scopes.includes(g.scope) &&
    (g.scope !== "team" || snapshot.teamAvailable === true) &&
    (directoryFresh || (g.role !== "executive" && g.role !== "admin")));
  if (!grants.length) return { state: "no-access", breakGlass: false };
  return { state: "authorized", breakGlass: false, principal, grants, namesVisible: settings.perUserDetailEnabled };
}

export function canAccess(result: AccessResult, surface: "admin" | "health" | "data" | "feedback"): boolean {
  if ((surface === "admin" || surface === "health") && result.state === "unavailable" && result.breakGlass) return true;
  if (result.state !== "authorized") return false;
  return surface === "admin" || surface === "health"
    ? result.grants.some((g) => g.role === "admin") : true;
}

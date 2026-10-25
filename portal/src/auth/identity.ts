import { isGuid } from "../../../shared/src/access";
import type { Identity } from "../authz/access";

export function identityFromProfile(provider: string, profile: Record<string, unknown>, tenantId: string, now = Date.now()): Identity | null {
  if (provider === "microsoft-entra-id") {
    if (typeof profile.tid !== "string" || !isGuid(profile.tid) || profile.tid.toLowerCase() !== tenantId.toLowerCase() ||
      typeof profile.oid !== "string" || !isGuid(profile.oid)) return null;
    return {
      provider: "entra", tenantId: profile.tid, objectId: profile.oid,
      groups: Array.isArray(profile.groups) ? profile.groups.filter((g): g is string => typeof g === "string" && isGuid(g)) : [],
      groupsVerifiedAt: now,
    };
  }
  if (provider === "github" && typeof profile.id === "number" && Number.isSafeInteger(profile.id) && profile.id > 0) {
    return { provider: "github", userId: profile.id };
  }
  return null;
}

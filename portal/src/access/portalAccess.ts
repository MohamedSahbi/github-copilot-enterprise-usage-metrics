import { getAccess, getAuthorizedScopeUsers } from "../authz/server";
import type { AccessResult } from "../authz/access";
import { portalViewerFromAccess } from "./portalViewer";

export {
  resolvePortalScope,
  type PortalScopeKind,
  type PortalScopeOption,
  type PortalScopeSelection,
  type PortalViewer,
} from "./portalViewer";

export interface PortalViewerContext {
  viewer: Awaited<ReturnType<typeof portalViewerFromAccess>>;
  access: AccessResult;
}

export async function getPortalViewerContext(correlationId?: string): Promise<PortalViewerContext> {
  try {
    const access = await getAccess(correlationId);
    if (access.state !== "authorized") return { viewer: portalViewerFromAccess(access), access };
    const scopedUsers = await getAuthorizedScopeUsers(access);
    return { viewer: portalViewerFromAccess(access, scopedUsers), access };
  } catch {
    const access: AccessResult = { state: "unavailable", breakGlass: false };
    return { viewer: portalViewerFromAccess(access), access };
  }
}

export async function getPortalViewer() {
  return (await getPortalViewerContext()).viewer;
}

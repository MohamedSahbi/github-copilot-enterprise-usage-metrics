import { getAccess, getAuthorizedScopeUsers } from "../authz/server";
import { portalViewerFromAccess } from "./portalViewer";

export {
  resolvePortalScope,
  type PortalScopeKind,
  type PortalScopeOption,
  type PortalScopeSelection,
  type PortalViewer,
} from "./portalViewer";

export async function getPortalViewer() {
  try {
    const access = await getAccess();
    if (access.state !== "authorized") return portalViewerFromAccess(access);
    const scopedUsers = await getAuthorizedScopeUsers(access);
    return portalViewerFromAccess(access, scopedUsers);
  } catch {
    return portalViewerFromAccess({ state: "unavailable", breakGlass: false });
  }
}

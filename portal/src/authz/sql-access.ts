import sql from "mssql";
import type { AccessRepository, AccessSnapshot, Grant, Identity, Principal } from "./access";
import type { GrantValidationContext } from "../../../shared/src/access";
import { enabledScopes } from "../../../shared/src/access";
import type { AccessSettings } from "../auth/settings";

export class SqlAccessRepository implements AccessRepository {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async grantValidationContext(tenantId: string, objectId: string, settings: AccessSettings): Promise<GrantValidationContext> {
    const principal = await this.pool.request().input("tenant", sql.UniqueIdentifier, tenantId)
      .input("oid", sql.UniqueIdentifier, objectId)
      .query<{ found: number }>(`SELECT 1 AS found FROM portal.Principal
        WHERE entra_tenant_id = @tenant AND entra_object_id = @oid AND status = 'active'`);
    const directory = (await this.pool.request().query<{ department: string | null; business_area: string | null }>(
      "SELECT DISTINCT department, business_area FROM portal.dim_user WHERE state = 'active'",
    )).recordset;
    return {
      enabledScopes: enabledScopes(settings.directory),
      principalHasLinkedEntraId: principal.recordset.length === 1,
      directoryValues: {
        department: directory.flatMap((r) => r.department ? [r.department] : []),
        business_area: directory.flatMap((r) => r.business_area ? [r.business_area] : []),
      },
    };
  }

  async read(identity: Identity): Promise<AccessSnapshot> {
    const request = this.pool.request();
    if (identity.provider === "entra") {
      request.input("tenant", sql.UniqueIdentifier, identity.tenantId).input("oid", sql.UniqueIdentifier, identity.objectId);
    } else {
      request.input("github", sql.BigInt, identity.userId);
    }
    // LinkState decides whether the stored GitHub link remains active; Entra sign-in never keys on that link.
    const match = identity.provider === "entra"
      ? "p.entra_tenant_id = @tenant AND p.entra_object_id = @oid"
      : `EXISTS (SELECT 1 FROM portal.PrincipalLinkState l
          WHERE l.github_user_id = @github AND l.unlinked_at IS NULL
            AND l.entra_tenant_id = p.entra_tenant_id AND l.entra_object_id = p.entra_object_id)`;
    const principal = (await request.query<Principal>(`
      SELECT p.principal_id, p.entra_tenant_id, p.entra_object_id, p.github_user_id, p.status
      FROM portal.Principal p WHERE ${match}`)).recordset[0] ?? null;
    if (!principal) return { principal: null, grants: [], sync: [] };
    const grants = (await this.pool.request().input("principal", sql.UniqueIdentifier, principal.principal_id)
      .query<Grant>(`SELECT role, scope, scope_value FROM portal.v_active_grant WHERE principal_id = @principal`)).recordset;
    const sync = (await this.pool.request().query<AccessSnapshot["sync"][number]>(
      "SELECT source, last_success_at FROM portal.DirectorySyncState",
    )).recordset;
    return { principal, grants, sync };
  }
}

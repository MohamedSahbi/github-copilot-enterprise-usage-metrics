import sql from "mssql";
import type { AccessRepository, AccessScopedUser, AccessSnapshot, Grant, Identity, Principal } from "./access";
import type { GrantValidationContext } from "../../../shared/src/access";
import { enabledScopes } from "../../../shared/src/access";
import type { AccessSettings } from "../auth/settings";
import { bindTeamFreshness, eligibleManagerEdge } from "./sql-team-freshness";

function safeUserId(value: number | string): number {
  const userId = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Directory user ID is not a safe positive integer");
  }
  return userId;
}

export class SqlAccessRepository implements AccessRepository {
  constructor(private readonly pool: sql.ConnectionPool | sql.Transaction) {}

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
    let teamAvailable = false;
    if (grants.some(({ scope }) => scope === "team")) {
      const request = this.pool.request().input("principal_oid", sql.UniqueIdentifier, principal.entra_object_id);
      bindTeamFreshness(request);
      const reports = await request.query<{ available: boolean }>(`
        SELECT CAST(CASE WHEN EXISTS (
          SELECT 1 FROM portal.dim_user AS child
          WHERE child.state = 'active' AND child.manager_entra_object_id = @principal_oid
            AND child.entra_object_id <> @principal_oid
            AND ${eligibleManagerEdge("child")}
        ) THEN 1 ELSE 0 END AS BIT) AS available`);
      teamAvailable = reports.recordset[0]?.available === true;
    }
    return { principal, grants, sync, teamAvailable };
  }

  async readScopedUsers(principalObjectId: string, grants: readonly Grant[]): Promise<AccessScopedUser[]> {
    const request = this.pool.request().input("principal_oid", sql.UniqueIdentifier, principalObjectId);
    const predicates: string[] = [];
    let usesTeamScope = false;

    grants.forEach((grant, index) => {
      switch (grant.scope) {
        case "company":
          predicates.push("1 = 1");
          break;
        case "self":
          predicates.push("u.entra_object_id = @principal_oid");
          break;
        case "team":
          usesTeamScope = true;
          predicates.push("u.user_id IN (SELECT user_id FROM team_tree WHERE entra_object_id <> @principal_oid)");
          break;
        case "department":
        case "business_area": {
          const value = grant.scope_value.trim().toLowerCase();
          if (!value) break;
          const param = `scope_value_${index}`;
          request.input(param, sql.NVarChar(255), value);
          const column = grant.scope === "department" ? "department" : "business_area";
          predicates.push(`LOWER(LTRIM(RTRIM(u.${column}))) = @${param}`);
          break;
        }
        default:
          break;
      }
    });

    if (!predicates.length) return [];
    if (usesTeamScope) bindTeamFreshness(request);

    const teamTree = usesTeamScope ? `
      WITH team_tree AS (
        SELECT user_id, entra_object_id,
          CAST(CONCAT('/', CONVERT(varchar(36), entra_object_id), '/') AS varchar(max)) AS path
        FROM portal.dim_user
        WHERE state = 'active' AND entra_object_id = @principal_oid
        UNION ALL
        SELECT child.user_id, child.entra_object_id,
          CAST(CONCAT(parent.path, CONVERT(varchar(36), child.entra_object_id), '/') AS varchar(max))
        FROM portal.dim_user child
        INNER JOIN team_tree parent ON child.manager_entra_object_id = parent.entra_object_id
        WHERE child.state = 'active'
          AND ${eligibleManagerEdge("child")}
          AND (child.entra_object_id IS NULL OR CHARINDEX(CONCAT('/', CONVERT(varchar(36), child.entra_object_id), '/'), parent.path) = 0)
      )` : "";

    const query = await request.query<Omit<AccessScopedUser, "user_id"> & { user_id: number | string }>(`
      ${teamTree}
      SELECT DISTINCT u.user_id, u.entra_object_id, u.manager_entra_object_id, u.department, u.business_area
      FROM portal.dim_user u
      WHERE u.state = 'active' AND (${predicates.join(" OR ")})
      ${usesTeamScope ? "OPTION (MAXRECURSION 100)" : ""}`);
    return query.recordset.map(({ user_id, ...user }) => ({ ...user, user_id: safeUserId(user_id) }));
  }
}

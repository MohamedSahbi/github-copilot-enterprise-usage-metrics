import sql from "mssql";
import { enabledScopes, normalizeScopeValue, ROLE_SCOPES, validateGrantRequest } from "../../../shared/src/access";
import type { AdminGrant, AdminGrantFormData } from "../../../shared/src/api";
import type { AccessSettings } from "../auth/settings";
import { AdminError, type GrantInput } from "./input";

export interface AdminActor {
  principalId: string | null;
  entraObjectId: string;
}
type Executor = sql.ConnectionPool | sql.Transaction;

export async function grantFormData(executor: Executor, settings: AccessSettings): Promise<AdminGrantFormData> {
  const rows = (await executor.request().query<{ department: string | null; business_area: string | null }>(
    "SELECT DISTINCT department, business_area FROM portal.dim_user WHERE state = 'active'",
  )).recordset;
  const values = (field: "department" | "business_area") =>
    [...new Set(rows.flatMap((row) => row[field] ? [normalizeScopeValue(row[field])] : []))].sort();
  return {
    roleScopes: {
      user: [...ROLE_SCOPES.user], manager: [...ROLE_SCOPES.manager],
      executive: [...ROLE_SCOPES.executive], admin: [...ROLE_SCOPES.admin],
    },
    enabledScopes: enabledScopes(settings.directory),
    scopeValues: { department: values("department"), business_area: values("business_area") },
  };
}

export async function appendAdminAudit(
  transaction: sql.Transaction, actor: AdminActor, correlationId: string,
  action: "grant.created" | "grant.revoked" | "issue.action_applied",
  targetType: string, targetId: number, detail: Record<string, unknown>,
): Promise<void> {
  await transaction.request()
    .input("actor", sql.UniqueIdentifier, actor.principalId)
    .input("oid", sql.UniqueIdentifier, actor.entraObjectId)
    .input("action", sql.VarChar(64), action)
    .input("targetType", sql.VarChar(64), targetType)
    .input("targetId", sql.NVarChar(128), String(targetId))
    .input("correlation", sql.VarChar(64), correlationId)
    .input("detail", sql.NVarChar(sql.MAX), JSON.stringify(detail))
    .query(`INSERT INTO portal.AuditLog
      (actor_principal_id, actor_entra_oid, action, target_type, target_id, outcome, correlation_id, detail_json)
      VALUES (@actor, @oid, @action, @targetType, @targetId, 'success', @correlation, @detail)`);
}

// Actor authorization belongs to the entry point; this helper never provisions a Principal.
export async function changeGrant(
  pool: sql.ConnectionPool, actor: AdminActor, tenantId: string,
  input: GrantInput, action: "grant" | "revoke", settings: AccessSettings, correlationId: string,
): Promise<AdminGrant> {
  const transaction = new sql.Transaction(pool);
  let rolledBack = false;
  transaction.on("rollback", () => { rolledBack = true; });
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    // Shares the directory lifecycle lock so a concurrent unlink cannot be overtaken by a new grant.
    const lock = await transaction.request().query<{ result: number }>(`
      DECLARE @result INT;
      EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
      SELECT @result AS result`);
    if ((lock.recordset[0]?.result ?? -1) < 0) throw new AdminError("invalid_request", 409);
    const target = (await transaction.request()
      .input("tenant", sql.UniqueIdentifier, tenantId)
      .input("oid", sql.UniqueIdentifier, input.principalEntraObjectId ?? null)
      .input("id", sql.UniqueIdentifier, input.principalId ?? null)
      .query<{ principal_id: string; entra_object_id: string }>(`
        SELECT principal_id, entra_object_id FROM portal.Principal WITH (UPDLOCK, HOLDLOCK)
        WHERE entra_tenant_id = @tenant AND status = 'active'
          AND ((@oid IS NOT NULL AND entra_object_id = @oid) OR (@id IS NOT NULL AND principal_id = @id))`)).recordset[0];
    const form = await grantFormData(transaction, settings);
    const validated = validateGrantRequest({
      principalEntraObjectId: target?.entra_object_id ?? "",
      role: input.role, scope: input.scope, scopeValue: input.scopeValue,
    }, {
      enabledScopes: form.enabledScopes, directoryValues: form.scopeValues,
      principalHasLinkedEntraId: target !== undefined,
    });
    if (!validated.ok) throw new AdminError(validated.code);
    if (!target) throw new AdminError("principal_not_linked");
    const grant = validated.grant;
    const request = () => transaction.request()
      .input("principal", sql.UniqueIdentifier, target.principal_id)
      .input("role", sql.VarChar(12), grant.role)
      .input("scope", sql.VarChar(16), grant.scope)
      .input("value", sql.NVarChar(128), grant.scopeValue);
    const existing = (await request().query<AdminGrant>(`
      SELECT grant_id AS grantId, role, scope, scope_value AS scopeValue, CAST(NULL AS datetime2) AS revokedAt
      FROM portal.v_active_grant
      WHERE principal_id = @principal AND role = @role AND scope = @scope AND scope_value = @value`)).recordset[0];
    if (action === "grant" && existing) throw new AdminError("invalid_request", 409);
    if (action === "revoke" && !existing) throw new AdminError("not_found", 404);
    if (action === "revoke" && grant.role === "admin") {
      const count = (await transaction.request().input("tenant", sql.UniqueIdentifier, tenantId)
        .query<{ total: number }>(`SELECT COUNT(*) AS total FROM portal.v_active_grant g
          JOIN portal.Principal p ON p.principal_id = g.principal_id
          WHERE p.entra_tenant_id = @tenant AND g.role = 'admin' AND g.scope = 'company'`)).recordset[0]!.total;
      if (count <= 1) throw new AdminError("invalid_request", 409);
    }
    let result: AdminGrant;
    if (action === "grant") {
      // An ineffective lifecycle-revoked row still occupies the filtered unique key; never silently revive it.
      result = (await request()
        .input("oid", sql.UniqueIdentifier, target.entra_object_id)
        .input("actor", sql.UniqueIdentifier, actor.principalId)
        .query<AdminGrant>(`INSERT INTO portal.AccessGrant
          (principal_id, principal_entra_oid, role, scope, scope_value, granted_by)
          OUTPUT INSERTED.grant_id AS grantId, INSERTED.role, INSERTED.scope,
            INSERTED.scope_value AS scopeValue, INSERTED.revoked_at AS revokedAt
          VALUES (@principal, @oid, @role, @scope, @value, @actor)`)).recordset[0]!;
    } else {
      result = (await transaction.request().input("id", sql.BigInt, existing!.grantId)
        .query<AdminGrant>(`UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME()
          OUTPUT INSERTED.grant_id AS grantId, INSERTED.role, INSERTED.scope,
            INSERTED.scope_value AS scopeValue, INSERTED.revoked_at AS revokedAt
          WHERE grant_id = @id AND revoked_at IS NULL`)).recordset[0]!;
    }
    await appendAdminAudit(transaction, actor, correlationId, action === "grant" ? "grant.created" : "grant.revoked",
      "AccessGrant", result.grantId, { role: grant.role, scope: grant.scope, scopeValue: grant.scopeValue });
    await transaction.commit();
    return result;
  } catch (error) {
    if (!rolledBack) await transaction.rollback();
    throw error;
  }
}

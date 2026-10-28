import sql from "mssql";
import type { ValidGrant } from "../../../shared/src/access";

export interface GrantCreateAudit {
  actorEntraObjectId: string;
  actorPrincipalId: string | null;
  correlationId: string;
  approvalReference: string;
  principalId: string;
  grant: ValidGrant;
}

export async function createGrantWithAudit(
  transaction: sql.Transaction,
  input: GrantCreateAudit,
): Promise<string> {
  const inserted = await transaction.request()
    .input("principalId", sql.UniqueIdentifier, input.principalId)
    .input("principalEntraObjectId", sql.UniqueIdentifier, input.grant.principalEntraObjectId)
    .input("role", sql.VarChar(12), input.grant.role)
    .input("scope", sql.VarChar(16), input.grant.scope)
    .input("scopeValue", sql.NVarChar(128), input.grant.scopeValue)
    .input("grantedBy", sql.UniqueIdentifier, input.actorPrincipalId)
    .query<{ grant_id: number | string }>(`
      INSERT INTO portal.AccessGrant
        (principal_id, principal_entra_oid, role, scope, scope_value, granted_by)
      OUTPUT INSERTED.grant_id AS grant_id
      VALUES
        (@principalId, @principalEntraObjectId, @role, @scope, @scopeValue, @grantedBy)`);
  const grantId = inserted.recordset[0]?.grant_id;
  if (grantId === undefined || grantId === null) throw new Error("grant_insert_missing_id");

  const detail = JSON.stringify({
    principal_id: input.principalId,
    role: input.grant.role,
    scope: input.grant.scope,
    scope_value: input.grant.scopeValue,
    approval_reference: input.approvalReference,
  });
  await transaction.request()
    .input("actorPrincipalId", sql.UniqueIdentifier, input.actorPrincipalId)
    .input("actorEntraObjectId", sql.UniqueIdentifier, input.actorEntraObjectId)
    .input("targetId", sql.NVarChar(128), String(grantId))
    .input("correlationId", sql.VarChar(64), input.correlationId)
    .input("detail", sql.NVarChar(sql.MAX), detail)
    .query(`
      INSERT INTO portal.AuditLog
        (actor_principal_id, actor_entra_oid, action, target_type, target_id, outcome, correlation_id, detail_json)
      VALUES
        (@actorPrincipalId, @actorEntraObjectId, 'grant.created', 'access_grant', @targetId, 'success', @correlationId, @detail)`);

  return String(grantId);
}

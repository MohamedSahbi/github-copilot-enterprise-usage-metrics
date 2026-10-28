import sql from "mssql";
import { z } from "zod";
import {
  enabledScopes,
  isGuid,
  ROLES,
  SCOPES,
  validateGrantRequest,
} from "../../../shared/src/access";
import type { ValidGrant } from "../../../shared/src/access";
import { readAccessSettings } from "../auth/settings";
import type { AccessSettings } from "../auth/settings";
import { eligibleManagerEdge } from "../authz/sql-team-freshness";
import { createGrantWithAudit } from "./grant-create";

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const sqlHost = z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/);
const bootstrapInputSchema = z.object({
  expectedSqlServer: sqlHost,
  expectedSqlDatabase: z.string().min(1).max(128).refine((value) => !/[;\\]/.test(value)),
  tenantId: guid,
  operatorObjectId: guid,
  targetObjectId: guid,
  grant: z.object({
    role: z.enum(ROLES),
    scope: z.enum(SCOPES),
    scopeValue: z.string().max(128).optional(),
  }).strict(),
  approvalReference: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/),
}).strict();

export type AccessBootstrapInput = z.infer<typeof bootstrapInputSchema>;
export type BootstrapErrorCode =
  | "invalid_input"
  | "configuration_mismatch"
  | "wrong_database"
  | "operator_identity_unavailable"
  | "operator_identity_mismatch"
  | "directory_lock_unavailable"
  | "target_not_active"
  | "identity_conflict"
  | "principal_disabled"
  | "lifecycle_conflict"
  | "directory_stale"
  | "team_ineligible"
  | "grant_invalid"
  | "historical_grant_conflict"
  | "transaction_failed";

export class BootstrapError extends Error {
  constructor(readonly code: BootstrapErrorCode) {
    super(code);
    this.name = "BootstrapError";
  }
}

export function parseAccessBootstrapInput(value: unknown): AccessBootstrapInput {
  const parsed = bootstrapInputSchema.safeParse(value);
  if (!parsed.success) throw new BootstrapError("invalid_input");
  return parsed.data;
}

export function assertBootstrapEnvironment(
  input: AccessBootstrapInput,
  env: Record<string, string | undefined>,
): void {
  if (!env.SQL_SERVER || !env.SQL_DATABASE || !env.ENTRA_TENANT_ID ||
      env.SQL_SERVER.toLowerCase().replace(/\.$/, "") !== input.expectedSqlServer.toLowerCase().replace(/\.$/, "") ||
      env.SQL_DATABASE !== input.expectedSqlDatabase ||
      env.ENTRA_TENANT_ID.toLowerCase() !== input.tenantId.toLowerCase()) {
    throw new BootstrapError("configuration_mismatch");
  }
}

export interface BootstrapResult {
  status: "dry-run" | "applied" | "already-effective";
  principalCreated: boolean;
  principalWouldBeCreated: boolean;
  grantId?: string;
  correlationId: string;
}

interface BootstrapOptions {
  apply: boolean;
  correlationId: string;
  settings?: AccessSettings;
  now?: Date;
  resolveActor?: (transaction: sql.Transaction) => Promise<string>;
}

async function authenticatedActorObjectId(transaction: sql.Transaction): Promise<string> {
  const result = await transaction.request().query<{ actor_object_id: string | null }>(`
    SELECT TRY_CONVERT(uniqueidentifier, SUSER_SID()) AS actor_object_id`);
  const actor = result.recordset[0]?.actor_object_id;
  if (!actor || !isGuid(actor)) throw new BootstrapError("operator_identity_unavailable");
  return actor;
}

function isDirectoryFresh(
  rows: { source: string; last_success_at: Date | null }[],
  settings: AccessSettings,
  now: Date,
): boolean {
  const futureToleranceMs = 500;
  return settings.directorySources.every((source) => {
    const success = rows.find((row) => row.source === source)?.last_success_at;
    if (!success) return false;
    const age = now.getTime() - success.getTime();
    return age >= -futureToleranceMs && age <= settings.directoryStaleHours * 60 * 60 * 1000;
  });
}

export async function runAccessBootstrap(
  pool: sql.ConnectionPool,
  input: AccessBootstrapInput,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const settings = options.settings ?? readAccessSettings();
  const now = options.now ?? new Date();
  const transaction = new sql.Transaction(pool);
  let active = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    active = true;

    const lock = await transaction.request().query<{ result: number }>(`
      DECLARE @result INT;
      EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
      SELECT @result AS result`);
    const lockResult = lock.recordset[0]?.result;
    if (lockResult === undefined || lockResult < 0) throw new BootstrapError("directory_lock_unavailable");

    const database = await transaction.request().query<{ database_name: string }>(
      "SELECT DB_NAME() AS database_name",
    );
    if (database.recordset[0]?.database_name !== input.expectedSqlDatabase) {
      throw new BootstrapError("wrong_database");
    }

    const actorObjectId = await (options.resolveActor ?? authenticatedActorObjectId)(transaction);
    if (actorObjectId.toLowerCase() !== input.operatorObjectId.toLowerCase()) {
      throw new BootstrapError("operator_identity_mismatch");
    }

    const directoryRows = (await transaction.request()
      .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
      .query<{ department: string | null; business_area: string | null; state: string }>(`
        SELECT department, business_area, state
        FROM portal.dim_user WITH (HOLDLOCK)
        WHERE entra_object_id = @targetObjectId`)).recordset;
    if (directoryRows.length !== 1 || directoryRows[0]?.state !== "active") {
      throw new BootstrapError("target_not_active");
    }

    const otherTenant = await transaction.request()
      .input("tenantId", sql.UniqueIdentifier, input.tenantId)
      .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
      .query<{ found: number }>(`
        SELECT TOP (1) 1 AS found
        FROM portal.Principal WITH (UPDLOCK, HOLDLOCK)
        WHERE entra_object_id = @targetObjectId
          AND entra_tenant_id <> @tenantId`);
    if (otherTenant.recordset.length > 0) throw new BootstrapError("identity_conflict");

    const principalRows = await transaction.request()
      .input("tenantId", sql.UniqueIdentifier, input.tenantId)
      .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
      .query<{ principal_id: string; status: string }>(`
        SELECT principal_id, status
        FROM portal.Principal WITH (UPDLOCK, HOLDLOCK)
        WHERE entra_tenant_id = @tenantId AND entra_object_id = @targetObjectId`);
    if (principalRows.recordset.length > 1) throw new BootstrapError("identity_conflict");
    let principal = principalRows.recordset[0];
    if (principal?.status === "disabled") throw new BootstrapError("principal_disabled");

    const lifecycle = await transaction.request()
      .input("tenantId", sql.UniqueIdentifier, input.tenantId)
      .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
      .query<{ found: number }>(`
        SELECT TOP (1) 1 AS found
        FROM portal.GrantRevocation WITH (HOLDLOCK)
        WHERE entra_tenant_id = @tenantId AND entra_object_id = @targetObjectId
        UNION ALL
        SELECT TOP (1) 1 AS found
        FROM portal.PrincipalLinkState WITH (HOLDLOCK)
        WHERE entra_tenant_id = @tenantId AND entra_object_id = @targetObjectId AND unlinked_at IS NOT NULL`);
    if (lifecycle.recordset.length > 0) throw new BootstrapError("lifecycle_conflict");

    let principalCreated = false;
    if (!principal && options.apply) {
      await transaction.request()
        .input("tenantId", sql.UniqueIdentifier, input.tenantId)
        .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
        .query(`
          INSERT INTO portal.Principal (entra_tenant_id, entra_object_id, github_user_id, status)
          VALUES (@tenantId, @targetObjectId, NULL, 'active')`);
      principalCreated = true;
      const created = await transaction.request()
        .input("tenantId", sql.UniqueIdentifier, input.tenantId)
        .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
        .query<{ principal_id: string; status: string }>(`
          SELECT principal_id, status
          FROM portal.Principal WITH (UPDLOCK, HOLDLOCK)
          WHERE entra_tenant_id = @tenantId AND entra_object_id = @targetObjectId`);
      principal = created.recordset[0];
      if (!principal || principal.status !== "active") throw new BootstrapError("identity_conflict");
    }

    const values = (await transaction.request().query<{ department: string | null; business_area: string | null }>(`
      SELECT DISTINCT department, business_area
      FROM portal.dim_user WITH (HOLDLOCK)
      WHERE state = 'active'`)).recordset;
    const validation = validateGrantRequest({
      principalEntraObjectId: input.targetObjectId,
      role: input.grant.role,
      scope: input.grant.scope,
      scopeValue: input.grant.scopeValue,
    }, {
      enabledScopes: enabledScopes(settings.directory),
      directoryValues: {
        department: [...new Set(values.flatMap(({ department }) => department ? [department] : []))],
        business_area: [...new Set(values.flatMap(({ business_area }) => business_area ? [business_area] : []))],
      },
      principalHasLinkedEntraId: principal?.status === "active" || (!principal && directoryRows.length === 1),
    });
    if (!validation.ok) throw new BootstrapError("grant_invalid");
    const grant: ValidGrant = validation.grant;
    const principalId = principal?.principal_id ?? null;

    if (principalId) {
      const effective = await transaction.request()
        .input("principalId", sql.UniqueIdentifier, principalId)
        .input("role", sql.VarChar(12), grant.role)
        .input("scope", sql.VarChar(16), grant.scope)
        .input("scopeValue", sql.NVarChar(128), grant.scopeValue)
        .query<{ grant_id: number | string }>(`
          SELECT grant_id
          FROM portal.v_active_grant
          WHERE principal_id = @principalId AND role = @role AND scope = @scope AND scope_value = @scopeValue`);
      if (effective.recordset.length > 0) {
        await transaction.commit();
        active = false;
        return {
          status: "already-effective",
          principalCreated: false,
          principalWouldBeCreated: false,
          grantId: String(effective.recordset[0]!.grant_id),
          correlationId: options.correlationId,
        };
      }

      // Denial-only contract (#172): never read AccessGrant directly, never regrant a revoked grant.
      const historical = await transaction.request()
        .input("entra_tenant_id", sql.UniqueIdentifier, input.tenantId)
        .input("entra_object_id", sql.UniqueIdentifier, input.targetObjectId)
        .input("role", sql.VarChar(sql.MAX), grant.role)
        .input("scope", sql.VarChar(sql.MAX), grant.scope)
        .input("scope_value", sql.NVarChar(sql.MAX), grant.scopeValue)
        .output("has_conflict", sql.Bit)
        .execute("portal.usp_has_revoked_grant_conflict");
      if (historical.output.has_conflict === true) throw new BootstrapError("historical_grant_conflict");
    }

    if ((grant.role === "admin" || grant.role === "executive")) {
      const sync = (await transaction.request().query<{ source: string; last_success_at: Date | null }>(`
        SELECT source, last_success_at FROM portal.DirectorySyncState WITH (HOLDLOCK)`)).recordset;
      if (!isDirectoryFresh(sync, settings, now)) throw new BootstrapError("directory_stale");
    }

    if (grant.scope === "team") {
      const team = await transaction.request()
        .input("targetObjectId", sql.UniqueIdentifier, input.targetObjectId)
        .input("teamDirectoryStaleHours", sql.Int, settings.directoryStaleHours)
        .query<{ available: boolean }>(`
          SELECT CAST(CASE WHEN EXISTS (
            SELECT 1 FROM portal.dim_user AS child WITH (HOLDLOCK)
            WHERE child.state = 'active' AND child.manager_entra_object_id = @targetObjectId
              AND child.entra_object_id <> @targetObjectId
              AND ${eligibleManagerEdge("child")}
          ) THEN 1 ELSE 0 END AS BIT) AS available`);
      if (team.recordset[0]?.available !== true) throw new BootstrapError("team_ineligible");
    }

    if (!options.apply) {
      await transaction.commit();
      active = false;
      return {
        status: "dry-run",
        principalCreated: false,
        principalWouldBeCreated: principalId === null,
        correlationId: options.correlationId,
      };
    }
    if (!principalId && !principal) throw new BootstrapError("transaction_failed");

    const actorPrincipal = await transaction.request()
      .input("tenantId", sql.UniqueIdentifier, input.tenantId)
      .input("actorObjectId", sql.UniqueIdentifier, actorObjectId)
      .query<{ principal_id: string | null }>(`
        SELECT TOP (1) principal_id FROM portal.Principal WITH (HOLDLOCK)
        WHERE entra_tenant_id = @tenantId AND entra_object_id = @actorObjectId AND status = 'active'`);
    const grantId = await createGrantWithAudit(transaction, {
      actorEntraObjectId: actorObjectId,
      actorPrincipalId: actorPrincipal.recordset[0]?.principal_id ?? null,
      correlationId: options.correlationId,
      approvalReference: input.approvalReference,
      principalId: principal!.principal_id,
      grant,
    });
    await transaction.commit();
    active = false;
    return {
      status: "applied",
      principalCreated,
      principalWouldBeCreated: false,
      grantId,
      correlationId: options.correlationId,
    };
  } catch (error) {
    if (active) {
      try {
        await transaction.rollback();
      } catch {
        throw new BootstrapError("transaction_failed");
      }
    }
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("transaction_failed");
  }
}

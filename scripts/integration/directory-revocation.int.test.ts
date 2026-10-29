import { randomUUID } from "node:crypto";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryUserSchema } from "../../shared/src/directory-input";
import { applyDirectoryRevocations } from "../../functions/src/directory/revocation";
import { createDirectorySqlWriter } from "../../functions/src/directory/sql-writer";
import type { DirectoryCommit } from "../../functions/src/directory/sync";
import { openPool } from "./db";

const userId = 990076001;
const tenant = "00000000-0000-4000-8000-000000007600";
const oid = "00000000-0000-4000-8000-000000007601";
const principalId = "00000000-0000-4000-8000-000000007602";
const scope = "directory-revocation-integration";
let pool: sql.ConnectionPool;
let clock = Date.now() - 60_000;

function command(state: "active" | "suspended"): DirectoryCommit {
  const runId = randomUUID();
  const startedAt = new Date(clock += 2_000).toISOString();
  const completedAt = new Date(clock + 1_000).toISOString();
  return {
    managerCheckUserIds: [userId],
    users: [{
      user: DirectoryUserSchema.parse({
        user_id: userId, login: `revocation-user-${userId}`, entra_object_id: oid,
        entra_account_enabled: state === "active", state,
      }),
      managerResolved: true, errorCode: null,
    }],
    run: {
      run_id: runId, source_kind: "directory", scope_key: scope, report_day: null, range_start: null, range_end: null,
      status: "published", is_current: false, transform_version: "1", attempt: 1, rows_read: 1, rows_loaded: 1,
      rows_quarantined: 0, error_code: null, correlation_id: runId, started_at: startedAt, completed_at: completedAt,
    },
    sync: (["scim", "seats", "graph"] as const).map((source) => ({
      source, last_attempt_at: completedAt, last_success_at: completedAt, last_error_code: null,
    })),
  };
}

async function count(query: string): Promise<number> {
  const result = await pool.request().input("tenant", sql.UniqueIdentifier, tenant).input("oid", sql.UniqueIdentifier, oid)
    .input("principal", sql.UniqueIdentifier, principalId).input("scope", sql.NVarChar(100), scope)
    .query<{ n: number }>(query);
  return Number(result.recordset[0]?.n ?? 0);
}

const activeGrants = () => count("SELECT COUNT(*) AS n FROM portal.v_active_grant WHERE principal_id = @principal");
const revocations = () => count("SELECT COUNT(*) AS n FROM portal.GrantRevocation WHERE entra_tenant_id = @tenant AND entra_object_id = @oid");
const auditRows = () => count(`SELECT COUNT(*) AS n FROM portal.IngestionAuditEvent AS e
  INNER JOIN portal.IngestionRun AS r ON r.run_id = e.run_id WHERE r.scope_key = @scope`);

async function cleanup(): Promise<void> {
  await pool.request().input("tenant", sql.UniqueIdentifier, tenant).input("oid", sql.UniqueIdentifier, oid)
    .input("principal", sql.UniqueIdentifier, principalId).input("scope", sql.NVarChar(100), scope)
    .input("userId", sql.BigInt, userId).query(`
      DELETE e FROM portal.IngestionAuditEvent AS e
        INNER JOIN portal.IngestionRun AS r ON r.run_id = e.run_id WHERE r.scope_key = @scope;
      DELETE FROM portal.GrantRevocation WHERE entra_tenant_id = @tenant AND entra_object_id = @oid;
      DELETE FROM portal.PrincipalLinkState WHERE entra_tenant_id = @tenant AND entra_object_id = @oid;
      DELETE FROM portal.AccessGrant WHERE principal_id = @principal;
      DELETE FROM portal.Principal WHERE principal_id = @principal;
      DELETE FROM portal.dim_user WHERE user_id = @userId;
      DELETE FROM portal.IngestionRun WHERE source_kind = 'directory' AND scope_key = @scope;`);
}

describe("directory soft revocation (#76, real SQL)", () => {
  const writer = () => createDirectorySqlWriter(() => new sql.Transaction(pool), { entraTenantId: tenant });

  beforeAll(async () => {
    pool = await openPool();
    await cleanup();
    await pool.request().input("tenant", sql.UniqueIdentifier, tenant).input("oid", sql.UniqueIdentifier, oid)
      .input("principal", sql.UniqueIdentifier, principalId).input("userId", sql.BigInt, userId).query(`
        INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id, github_user_id)
        VALUES (@principal, @tenant, @oid, @userId);
        INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope, scope_value)
        VALUES (@principal, @oid, 'manager', 'team', N'');
        INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id)
        VALUES (@tenant, @oid, @userId);`);
    await writer().commit(command("active"));
  });
  afterAll(async () => {
    await cleanup();
    await pool.close();
  });

  it("leaves an active user's grant and link alone", async () => {
    expect(await activeGrants()).toBe(1);
    expect(await revocations()).toBe(0);
    expect(await auditRows()).toBe(0);
  });

  it("unlinks and revokes when Entra disables the account, without deleting anything", async () => {
    await writer().commit(command("suspended"));
    expect(await activeGrants()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM portal.AccessGrant WHERE principal_id = @principal AND revoked_at IS NULL")).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM portal.PrincipalLinkState
      WHERE entra_tenant_id = @tenant AND entra_object_id = @oid AND unlink_reason = 'entra_disabled' AND unlink_seq IS NOT NULL`)).toBe(1);
    expect(await revocations()).toBe(1);
    const audit = await pool.request().input("scope", sql.NVarChar(100), scope).query<{
      action: string; target_type: string; target_id: string; detail_json: string;
    }>(`SELECT e.action, e.target_type, e.target_id, e.detail_json FROM portal.IngestionAuditEvent AS e
        INNER JOIN portal.IngestionRun AS r ON r.run_id = e.run_id WHERE r.scope_key = @scope ORDER BY e.action`);
    expect(audit.recordset.map(({ action, target_type }) => [action, target_type])).toEqual([
      ["grant.revoked_by_directory_sync", "grant_revocation"],
      ["principal.unlinked_by_directory_sync", "principal_link"],
    ]);
    for (const row of audit.recordset) {
      expect(JSON.parse(row.detail_json)).toEqual({ reason: "entra_disabled" });
      expect(row.target_id).toMatch(/^\d+$/);
      expect(JSON.stringify(row)).not.toMatch(new RegExp(`${oid}|${userId}|revocation-user`, "i"));
    }
  });

  it("does not append again while the account stays disabled", async () => {
    await writer().commit(command("suspended"));
    expect(await revocations()).toBe(1);
    expect(await auditRows()).toBe(2);
  });

  it("does not give a re-enabled account its old grant back", async () => {
    await writer().commit(command("active"));
    expect(await activeGrants()).toBe(0);
  });

  it("revokes again on the next disable", async () => {
    await writer().commit(command("suspended"));
    expect(await revocations()).toBe(2);
  });

  it("runs with only the ingestion role's permissions", async () => {
    await pool.request().query(`IF DATABASE_PRINCIPAL_ID('t_ingest') IS NULL
      BEGIN CREATE USER t_ingest WITHOUT LOGIN; ALTER ROLE portal_ingest ADD MEMBER t_ingest; END`);
    const otherOid = "00000000-0000-4000-8000-000000007603";
    const runId = randomUUID();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction.request().input("runId", sql.UniqueIdentifier, runId).input("scope", sql.NVarChar(100), scope)
        .input("tenant", sql.UniqueIdentifier, tenant).input("oid", sql.UniqueIdentifier, otherOid).query(`
          INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, is_current, transform_version, started_at)
          VALUES (@runId, 'directory', @scope, 'started', 0, '1', SYSUTCDATETIME());
          INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id)
          VALUES (@tenant, @oid, 990076003);`);
      await transaction.request().query("EXECUTE AS USER = 't_ingest'");
      await expect(applyDirectoryRevocations(transaction, {
        candidates: [{ entra_object_id: otherOid, reason: "entra_disabled", transitioned: true }],
        tenantId: tenant, runId, correlationId: runId,
      })).resolves.toEqual({ unlinked: 1, revoked: 1 });
      await transaction.request().query("REVERT");
    } finally {
      await transaction.rollback();
    }
  });
});

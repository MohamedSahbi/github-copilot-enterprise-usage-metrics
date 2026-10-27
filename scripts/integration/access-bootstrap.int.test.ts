import sql from "mssql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readAccessSettings } from "../../portal/src/auth/settings";
import { BootstrapError, parseAccessBootstrapInput, runAccessBootstrap } from "../../portal/src/access/bootstrap";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";
import { resolveAccess } from "../../portal/src/authz/access";
import { openPool } from "./db";
import { seedAuth } from "./auth-seed";

const TENANT = "00000000-0000-4000-8169-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8169-000000000004";
const OPERATOR = "00000000-0000-4000-8169-000000000002";
const TARGET = "00000000-0000-4000-8169-000000000003";
const OTHER_PRINCIPAL = "00000000-0000-4000-8169-000000000005";
const TARGET_USER = 991690001;
const REPORT_USER = 991690002;
const CORRELATION_PREFIX = "00000000-0000-4000-8169-";
const INPUT = {
  expectedSqlServer: "localhost",
  expectedSqlDatabase: "portal_local",
  tenantId: TENANT,
  operatorObjectId: OPERATOR,
  targetObjectId: TARGET,
  grant: { role: "user", scope: "self", scopeValue: "" },
  approvalReference: "CHANGE-169",
};

let pool: sql.ConnectionPool;

function config(overrides: Record<string, unknown> = {}) {
  return parseAccessBootstrapInput({ ...INPUT, ...overrides });
}

function options(overrides: Partial<Parameters<typeof runAccessBootstrap>[2]> = {}) {
  return {
    apply: true,
    correlationId: `${CORRELATION_PREFIX}000000000001`,
    resolveActor: async () => OPERATOR,
    settings: readAccessSettings({
      DIRECTORY_DEPARTMENT_ATTRIBUTE: "department",
      DIRECTORY_BUSINESS_AREA_ATTRIBUTE: "businessArea",
    }),
    ...overrides,
  };
}

async function seedTarget(): Promise<void> {
  await pool.request()
    .input("targetUser", sql.BigInt, TARGET_USER)
    .input("reportUser", sql.BigInt, REPORT_USER)
    .input("target", sql.UniqueIdentifier, TARGET)
    .query(`
      DELETE FROM portal.dim_user WHERE user_id IN (@targetUser, @reportUser);
      INSERT INTO portal.dim_user (user_id, login, state, entra_object_id, department, business_area)
      VALUES (@targetUser, N'bootstrap-target-169', 'active', @target, N'bootstrap-dept', N'bootstrap-area'),
        (@reportUser, N'bootstrap-report-169', 'active', NULL, NULL, NULL)`);
  await pool.request()
    .input("reportUser", sql.BigInt, REPORT_USER)
    .input("target", sql.UniqueIdentifier, TARGET)
    .query(`
      UPDATE portal.dim_user SET manager_entra_object_id = @target, manager_email = N'manager@example.invalid',
        manager_resolved = 1, manager_checked_at = DATEADD(second, -1, SYSUTCDATETIME())
      WHERE user_id = @reportUser`);
}

async function cleanup(): Promise<void> {
  await pool.request()
    .input("targetUser", sql.BigInt, TARGET_USER)
    .input("reportUser", sql.BigInt, REPORT_USER)
    .input("tenant", sql.UniqueIdentifier, TENANT)
    .input("otherTenant", sql.UniqueIdentifier, OTHER_TENANT)
    .input("target", sql.UniqueIdentifier, TARGET)
    .input("otherPrincipal", sql.UniqueIdentifier, OTHER_PRINCIPAL)
    .input("correlationPrefix", sql.VarChar(64), `${CORRELATION_PREFIX}%`)
    .query(`
      DELETE FROM portal.AuditLog WHERE correlation_id LIKE @correlationPrefix;
      DELETE FROM portal.AccessGrant WHERE principal_id IN (
        SELECT principal_id FROM portal.Principal
        WHERE entra_object_id = @target AND entra_tenant_id IN (@tenant, @otherTenant)
      );
      DELETE FROM portal.PrincipalLinkState WHERE entra_object_id = @target AND entra_tenant_id = @tenant;
      DELETE FROM portal.GrantRevocation WHERE entra_object_id = @target AND entra_tenant_id = @tenant;
      DELETE FROM portal.Principal WHERE entra_object_id = @target AND entra_tenant_id IN (@tenant, @otherTenant);
      DELETE FROM portal.Principal WHERE principal_id = @otherPrincipal;
      DELETE FROM portal.dim_user WHERE user_id IN (@targetUser, @reportUser)`);
}

async function apply(overrides: Record<string, unknown> = {}, runOptions = options()) {
  return runAccessBootstrap(pool, config(overrides), runOptions);
}

describe("explicit Entra access bootstrap", () => {
  beforeAll(async () => {
    pool = await openPool();
    await seedAuth(pool);
  });

  afterEach(async () => {
    await cleanup();
    await seedAuth(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.close();
  });

  it("refuses SQL sessions without a GUID Entra identity from the authenticated connection", async () => {
    await seedTarget();
    await expect(runAccessBootstrap(pool, config(), {
      apply: true,
      correlationId: `${CORRELATION_PREFIX}000000000002`,
      settings: readAccessSettings({}),
    })).rejects.toMatchObject({ code: "operator_identity_unavailable" });
  });

  it("dry-runs missing principal creation without persisting a principal, grant, or audit", async () => {
    await seedTarget();
    const result = await apply({}, options({ apply: false }));
    expect(result).toMatchObject({ status: "dry-run", principalCreated: false, principalWouldBeCreated: true });
    const rows = await pool.request().input("target", sql.UniqueIdentifier, TARGET).query(`
      SELECT
        (SELECT COUNT(*) FROM portal.Principal WHERE entra_tenant_id = '${TENANT}' AND entra_object_id = @target) AS principals,
        (SELECT COUNT(*) FROM portal.AccessGrant WHERE principal_entra_oid = @target) AS grants,
        (SELECT COUNT(*) FROM portal.AuditLog WHERE correlation_id LIKE '${CORRELATION_PREFIX}%') AS audits`);
    expect(rows.recordset[0]).toMatchObject({ principals: 0, grants: 0, audits: 0 });
  });

  it("atomically creates a principal, explicit grant, and correlated audit visible to the auth reader", async () => {
    await seedTarget();
    const result = await apply();
    expect(result).toMatchObject({ status: "applied", principalCreated: true, principalWouldBeCreated: false });
    const principal = await pool.request().input("target", sql.UniqueIdentifier, TARGET).query<{
      principal_id: string;
      status: string;
      github_user_id: number | null;
    }>(`SELECT principal_id, status, github_user_id FROM portal.Principal WHERE entra_tenant_id = '${TENANT}' AND entra_object_id = @target`);
    expect(principal.recordset[0]).toMatchObject({ status: "active", github_user_id: null });
    const visible = await new SqlAccessRepository(pool).read({
      provider: "entra", tenantId: TENANT, objectId: TARGET, groups: [],
    });
    expect(visible.grants).toEqual([{ role: "user", scope: "self", scope_value: "" }]);
    expect((await resolveAccess({
      provider: "entra", tenantId: TENANT, objectId: TARGET, groups: [],
    }, new SqlAccessRepository(pool), readAccessSettings({}))).state).toBe("authorized");
    const audit = await pool.request()
      .input("correlation", sql.VarChar(64), result.correlationId)
      .query<{ actor_entra_oid: string; action: string; outcome: string; target_id: string; detail_json: string }>(`
        SELECT actor_entra_oid, action, outcome, target_id, detail_json
        FROM portal.AuditLog WHERE correlation_id = @correlation`);
    expect(audit.recordset).toHaveLength(1);
    expect(audit.recordset[0]).toMatchObject({
      actor_entra_oid: OPERATOR,
      action: "grant.created",
      outcome: "success",
      target_id: result.grantId,
    });
    expect(audit.recordset[0]?.detail_json).not.toMatch(/email|display_name|token|group_claim/i);
  });

  it("makes repeated and concurrent identical apply idempotent with one success audit", async () => {
    await seedTarget();
    const first = await apply({}, options({ correlationId: `${CORRELATION_PREFIX}000000000003` }));
    const repeat = await apply({}, options({ correlationId: `${CORRELATION_PREFIX}000000000004` }));
    expect(first.status).toBe("applied");
    expect(repeat.status).toBe("already-effective");
    const concurrent = await Promise.allSettled([
      apply({}, options({ correlationId: `${CORRELATION_PREFIX}000000000005` })),
      apply({}, options({ correlationId: `${CORRELATION_PREFIX}000000000006` })),
    ]);
    expect(concurrent).toHaveLength(2);
    for (const item of concurrent) {
      if (item.status === "fulfilled") {
        expect(["applied", "already-effective"]).toContain(item.value.status);
      } else {
        expect(item.reason).toMatchObject({ code: "directory_lock_unavailable" });
      }
    }
    const counts = await pool.request().input("target", sql.UniqueIdentifier, TARGET).query(`
      SELECT
        (SELECT COUNT(*) FROM portal.v_active_grant g JOIN portal.Principal p ON p.principal_id = g.principal_id
          WHERE p.entra_tenant_id = '${TENANT}' AND p.entra_object_id = @target AND g.role = 'user' AND g.scope = 'self') AS grants,
        (SELECT COUNT(*) FROM portal.AuditLog WHERE correlation_id LIKE '${CORRELATION_PREFIX}%'
          AND action = 'grant.created') AS audits`);
    expect(counts.recordset[0]).toMatchObject({ grants: 1, audits: 1 });
  });

  it("preserves disabled principals and refuses cross-tenant identity collisions", async () => {
    await seedTarget();
    await pool.request().input("id", sql.UniqueIdentifier, OTHER_PRINCIPAL)
      .input("tenant", sql.UniqueIdentifier, TENANT).input("target", sql.UniqueIdentifier, TARGET)
      .query("INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id, status) VALUES (@id, @tenant, @target, 'disabled')");
    await expect(apply()).rejects.toMatchObject({ code: "principal_disabled" });
    await pool.request().input("id", sql.UniqueIdentifier, OTHER_PRINCIPAL)
      .query("DELETE FROM portal.Principal WHERE principal_id = @id");
    await pool.request().input("id", sql.UniqueIdentifier, OTHER_PRINCIPAL)
      .input("tenant", sql.UniqueIdentifier, OTHER_TENANT).input("target", sql.UniqueIdentifier, TARGET)
      .query("INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id) VALUES (@id, @tenant, @target)");
    await expect(apply()).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("denies directory lifecycle revocation and unlink history instead of restoring access", async () => {
    await seedTarget();
    await pool.request()
      .input("tenant", sql.UniqueIdentifier, TENANT).input("target", sql.UniqueIdentifier, TARGET)
      .query("INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, reason) VALUES (@tenant, @target, 'entra_disabled')");
    await expect(apply()).rejects.toMatchObject({ code: "lifecycle_conflict" });
  });

  it("refuses an exact historical revoked grant instead of silently regranting it", async () => {
    await seedTarget();
    await pool.request()
      .input("principalId", sql.UniqueIdentifier, OTHER_PRINCIPAL)
      .input("tenant", sql.UniqueIdentifier, TENANT)
      .input("target", sql.UniqueIdentifier, TARGET)
      .query(`
        INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id)
        VALUES (@principalId, @tenant, @target);
        INSERT INTO portal.AccessGrant
          (principal_id, principal_entra_oid, role, scope, scope_value, revoked_at)
        VALUES (@principalId, @target, 'user', 'self', N'', SYSUTCDATETIME())`);
    await expect(apply()).rejects.toMatchObject({ code: "historical_grant_conflict" });
  });

  it("denies stale elevated scopes and disabled directory scopes from SQL-derived facts", async () => {
    await seedTarget();
    await pool.request().query("UPDATE portal.DirectorySyncState SET last_success_at = DATEADD(hour, -37, SYSUTCDATETIME()) WHERE source = 'graph'");
    const adminInput = {
      grant: { role: "admin", scope: "company", scopeValue: "" },
    };
    await expect(apply(adminInput)).rejects.toMatchObject({ code: "directory_stale" });
    await seedAuth(pool);
    await expect(apply({
      grant: { role: "executive", scope: "department", scopeValue: "bootstrap-dept" },
    }, options({ settings: readAccessSettings({}) }))).rejects.toMatchObject({ code: "grant_invalid" });
    const applied = await apply({
      grant: { role: "executive", scope: "department", scopeValue: "bootstrap-dept" },
    }, options({
      settings: readAccessSettings({ DIRECTORY_DEPARTMENT_ATTRIBUTE: "department" }),
      correlationId: `${CORRELATION_PREFIX}000000000007`,
    }));
    expect(applied.status).toBe("applied");
  });

  it("requires a fresh eligible directory edge for team grants", async () => {
    await seedTarget();
    const team = { grant: { role: "manager", scope: "team", scopeValue: "" } };
    expect((await apply(team)).status).toBe("applied");
    await cleanup();
    await seedTarget();
    await pool.request().input("reportUser", sql.BigInt, REPORT_USER)
      .query("UPDATE portal.dim_user SET manager_resolved = 0 WHERE user_id = @reportUser");
    await expect(apply(team)).rejects.toMatchObject({ code: "team_ineligible" });
  });

  it("rolls back principal and grant when the success audit insert fails", async () => {
    await seedTarget();
    const triggerName = "portal.trg_test_access_bootstrap_audit_failure";
    await pool.request().query(`
      IF OBJECT_ID(N'${triggerName}', N'TR') IS NOT NULL
        THROW 51001, 'test trigger already exists', 1;
      EXEC(N'CREATE TRIGGER ${triggerName} ON portal.AuditLog AFTER INSERT AS
        BEGIN
          SET NOCOUNT ON;
          THROW 51002, ''expected test audit failure'', 1;
        END;')`);
    try {
      await expect(apply({}, options({ correlationId: `${CORRELATION_PREFIX}000000000008` })))
        .rejects.toMatchObject({ code: "transaction_failed" });
    } finally {
      await pool.request().query(`DROP TRIGGER ${triggerName}`);
    }
    const rows = await pool.request().input("target", sql.UniqueIdentifier, TARGET).query(`
      SELECT
        (SELECT COUNT(*) FROM portal.Principal WHERE entra_tenant_id = '${TENANT}' AND entra_object_id = @target) AS principals,
        (SELECT COUNT(*) FROM portal.AccessGrant WHERE principal_entra_oid = @target) AS grants,
        (SELECT COUNT(*) FROM portal.AuditLog WHERE correlation_id = '${CORRELATION_PREFIX}000000000008') AS audits`);
    expect(rows.recordset[0]).toMatchObject({ principals: 0, grants: 0, audits: 0 });
  });
});

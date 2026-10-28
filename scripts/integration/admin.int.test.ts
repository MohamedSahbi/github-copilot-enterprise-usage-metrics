import sql from "mssql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPool } from "./db";
import { AUTH_PRINCIPALS_BY_PERSONA, AUTH_TENANT, seedAuth } from "./auth-seed";
import { changeGrant } from "../../portal/src/admin/grants";
import { applyIssueAction } from "../../portal/src/admin/issues";
import { readAudit, readLoginHistory } from "../../portal/src/admin/queries";
import { readAccessSettings } from "../../portal/src/auth/settings";
import { canAccess, resolveAccess, type Identity } from "../../portal/src/authz/access";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";

let pool: sql.ConnectionPool;
const principal = "00000000-0000-4000-8090-000000000001";
const oid = "00000000-0000-4000-8090-000000000002";
const actor = { principalId: principal, entraObjectId: oid };
const settings = readAccessSettings({});
const target = { principalEntraObjectId: oid, role: "user", scope: "self" };
let issueId: number;
const runId = "00000000-0000-4000-8090-000000000003";
describe("admin SQL mutations and correlated audit", () => {
  beforeAll(async () => {
    pool = await openPool();
    await seedAuth(pool);
    await pool.request().query(`
      INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id)
        VALUES ('${principal}', '${AUTH_TENANT}', '${oid}');
      INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, transform_version, rows_loaded)
        VALUES ('${runId}', 'users_1_day', 'admin-test', '2026-01-01', 'quarantined', '1', 0);
      INSERT INTO portal.ValidationIssue (run_id, severity, error_code, issue_type, report_day)
        VALUES ('${runId}', 'fatal', 'smaller_day_blocked', 'smaller_day', '2026-01-01');
    `);
    issueId = Number((await pool.request().query<{ id: number }>(`SELECT issue_id AS id FROM portal.ValidationIssue WHERE run_id = '${runId}'`)).recordset[0]!.id);
  });
  afterAll(async () => {
    if (pool) {
      await pool.request().query(`
        DROP TRIGGER IF EXISTS portal.admin_test_audit_failure;
        DELETE FROM portal.AuditLog WHERE correlation_id LIKE 'admin-test-%';
        DELETE FROM portal.AccessGrant WHERE principal_id = '${principal}';
        DELETE FROM portal.Principal WHERE principal_id = '${principal}';
        DELETE FROM portal.IssueAction WHERE issue_id IN (SELECT issue_id FROM portal.ValidationIssue WHERE run_id = '${runId}');
        DELETE FROM portal.ValidationIssue WHERE run_id = '${runId}';
        DELETE FROM portal.IngestionRun WHERE run_id = '${runId}';`);
      await pool.close();
    }
  });
  beforeEach(async () => {
    await pool.request().query(`
      DELETE FROM portal.AuditLog WHERE correlation_id LIKE 'admin-test-%';
      DELETE FROM portal.AccessGrant WHERE principal_id = '${principal}';
      DELETE FROM portal.IssueAction WHERE issue_id = ${issueId};`);
  });
  it("creates, revokes and regrants through both paths with one audit row per actual change", async () => {
    const grant = await changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-create");
    expect(grant.role).toBe("user");
    const repository = new SqlAccessRepository(pool);
    const identity: Identity = { provider: "entra", tenantId: AUTH_TENANT, objectId: oid, groups: [] };
    expect((await repository.read(identity)).grants).toHaveLength(1);
    await expect(changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-duplicate")).rejects.toMatchObject({ status: 409 });
    await changeGrant(pool, actor, AUTH_TENANT, { principalId: principal, role: "user", scope: "self", action: "revoke" }, "revoke", settings, "admin-test-revoke");
    expect((await repository.read(identity)).grants).toHaveLength(0);
    const regrant = await changeGrant(pool, actor, AUTH_TENANT, { principalId: principal, role: "user", scope: "self", action: "grant" }, "grant", settings, "admin-test-regrant");
    expect(Number(regrant.grantId)).not.toBe(Number(grant.grantId));
    const audits = (await readAudit(pool, { page: 1, pageSize: 100 })).filter((row) => row.correlation_id?.startsWith("admin-test-"));
    expect(audits.map((row) => row.action).sort()).toEqual(["grant.created", "grant.created", "grant.revoked"]);
    expect(audits.every((row) => row.actor_entra_oid?.toLowerCase() === oid)).toBe(true);
  });
  it("returns shared validator errors for direct and legacy paths; ignores no caller facts", async () => {
    for (const input of [{ ...target, role: "manager", scope: "company" }, { principalId: principal, role: "manager", scope: "company" }]) {
      await expect(changeGrant(pool, actor, AUTH_TENANT, input, "grant", settings, "admin-test-invalid")).rejects.toMatchObject({ code: "invalid_role_scope", status: 422 });
    }
    await expect(changeGrant(pool, actor, AUTH_TENANT, { ...target, role: "executive", scope: "department" }, "grant", settings, "admin-test-disabled"))
      .rejects.toMatchObject({ code: "scope_disabled" });
    await expect(changeGrant(pool, actor, oid, target, "grant", settings, "admin-test-tenant"))
      .rejects.toMatchObject({ code: "principal_not_linked" });
  });
  it("serializes concurrent grant changes without duplicate success evidence", async () => {
    const results = await Promise.allSettled([
      changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-concurrent-1"),
      changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-concurrent-2"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const audits = await pool.request().query<{ total: number }>("SELECT COUNT(*) AS total FROM portal.AuditLog WHERE correlation_id LIKE 'admin-test-concurrent-%'");
    expect(audits.recordset[0]?.total).toBe(1);
  });
  it("refuses disabled targets and protects the last effective administrator", async () => {
    await pool.request().query(`UPDATE portal.Principal SET status = 'disabled' WHERE principal_id = '${principal}'`);
    try {
      await expect(changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-disabled-principal"))
        .rejects.toMatchObject({ code: "principal_not_linked" });
    } finally { await pool.request().query(`UPDATE portal.Principal SET status = 'active' WHERE principal_id = '${principal}'`); }
    const admin = { ...target, role: "admin", scope: "company" };
    await changeGrant(pool, actor, AUTH_TENANT, admin, "grant", settings, "admin-test-last-admin");
    await pool.request().query(`UPDATE portal.Principal SET status = 'disabled' WHERE principal_id = '${AUTH_PRINCIPALS_BY_PERSONA.admin}'`);
    try {
      await expect(changeGrant(pool, actor, AUTH_TENANT, admin, "revoke", settings, "admin-test-lockout"))
        .rejects.toMatchObject({ status: 409 });
    } finally { await pool.request().query(`UPDATE portal.Principal SET status = 'active' WHERE principal_id = '${AUTH_PRINCIPALS_BY_PERSONA.admin}'`); }
  });
  it("does not bypass a directory lifecycle transaction", async () => {
    const lifecycle = new sql.Transaction(pool);
    await lifecycle.begin();
    try {
      await lifecycle.request().query(`DECLARE @result INT;
        EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory', @LockMode = 'Exclusive',
          @LockOwner = 'Transaction', @LockTimeout = 0;
        IF @result < 0 THROW 51091, 'Cannot acquire test lifecycle lock', 1;`);
      await expect(changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-lifecycle"))
        .rejects.toMatchObject({ status: 409 });
    } finally { await lifecycle.rollback(); }
  });
  it("rolls a grant back when its audit insert fails", async () => {
    await pool.request().query(`CREATE TRIGGER portal.admin_test_audit_failure ON portal.AuditLog AFTER INSERT AS
      IF EXISTS (SELECT 1 FROM inserted WHERE correlation_id = 'admin-test-audit-fail') THROW 51090, 'Test audit failure', 1;`);
    try {
      await expect(changeGrant(pool, actor, AUTH_TENANT, { ...target, role: "manager", scope: "self" }, "grant", settings, "admin-test-audit-fail")).rejects.toThrow();
      const read = await new SqlAccessRepository(pool).read({ provider: "entra", tenantId: AUTH_TENANT, objectId: oid, groups: [] });
      expect(read.grants.some((grant) => grant.role === "manager")).toBe(false);
    } finally { await pool.request().query("DROP TRIGGER portal.admin_test_audit_failure"); }
  });
  it("enforces inbox confirmation from stored row counts and audits the one accepted action", async () => {
    await expect(applyIssueAction(pool, actor, { issueId, action: "force", confirm: true }, "admin-test-empty"))
      .rejects.toMatchObject({ code: "empty_day_confirmation_required" });
    await expect(applyIssueAction(pool, actor, { issueId, action: "retry", confirm: true }, "admin-test-wrong-action"))
      .rejects.toMatchObject({ code: "invalid_action" });
    const result = await applyIssueAction(pool, actor, { issueId, action: "force", confirm: true, confirmDate: "2026-01-01" }, "admin-test-issue");
    expect(result).toMatchObject({ status: "open", reprocessRequested: true });
    await expect(applyIssueAction(pool, actor, { issueId, action: "discard", confirm: true }, "admin-test-issue-repeat"))
      .rejects.toMatchObject({ status: 409 });
    const audits = await pool.request().query<{ total: number }>("SELECT COUNT(*) AS total FROM portal.AuditLog WHERE correlation_id = 'admin-test-issue'");
    expect(audits.recordset[0]?.total).toBe(1);
  });
  it("enforces the admin-only boundary with fresh SQL grants and immediate revocation", async () => {
    await changeGrant(pool, actor, AUTH_TENANT, target, "grant", settings, "admin-test-user");
    const identity: Identity = { provider: "entra", tenantId: AUTH_TENANT, objectId: oid, groups: [] };
    const repository = new SqlAccessRepository(pool);
    expect(canAccess(await resolveAccess(identity, repository, settings), "admin")).toBe(false);
    const admin = { ...target, role: "admin", scope: "company" };
    await changeGrant(pool, actor, AUTH_TENANT, admin, "grant", settings, "admin-test-admin");
    expect(canAccess(await resolveAccess(identity, repository, settings), "admin")).toBe(true);
    await changeGrant(pool, actor, AUTH_TENANT, admin, "revoke", settings, "admin-test-admin-revoke");
    expect(canAccess(await resolveAccess(identity, repository, settings), "admin")).toBe(false);
    expect(Array.isArray(await readLoginHistory(pool, { page: 1, pageSize: 50 }, 1000001))).toBe(true);
  });
});

// Optional: applies the migrations to a SQL Server 2022 container. Run with RUN_SQL_TESTS=1 (needs a running Docker daemon).
// Slow under emulation on Apple Silicon (linux/amd64). Never points at a real server.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_SQL_TESTS === "1";
const migrations = join(__dirname, "..", "..", "db", "migrations");
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
const name = `portal-sql-test-${randomBytes(4).toString("hex")}`;
const sa = `Aa1!${randomBytes(12).toString("hex")}`;
const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });
const sqlcmd = (...args: string[]): string =>
  docker("exec", "-e", `SQLCMDPASSWORD=${sa}`, name, SQLCMD, "-C", "-I", "-b", "-S", "localhost", "-U", "sa", ...args);

describe.skipIf(!enabled)("migrations on SQL Server 2022 (RUN_SQL_TESTS=1)", () => {
  beforeAll(async () => {
    expect(spawnSync("docker", ["info"]).status, "docker daemon must be running").toBe(0);
    docker("run", "-d", "--rm", "--platform", "linux/amd64", "--name", name, "-e", "ACCEPT_EULA=Y", "-e", `MSSQL_SA_PASSWORD=${sa}`, "mcr.microsoft.com/mssql/server:2022-latest");
    for (let i = 0; i < 90; i++) {
      try { sqlcmd("-Q", "SELECT 1"); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    sqlcmd("-Q", "SELECT 1");
    docker("cp", migrations, `${name}:/migrations`);
  }, 240_000);

  afterAll(() => { spawnSync("docker", ["rm", "-f", name]); });

  const apply = (): void => { for (const f of files) sqlcmd("-d", "portal_test", "-i", `/migrations/${f}`); };

  it("applies in order", () => {
    sqlcmd("-Q", "CREATE DATABASE portal_test");
    expect(() => apply()).not.toThrow();
  }, 240_000);

  it("is idempotent when re-applied (the schema_version bookkeeping aside)", () => {
    expect(() => apply()).not.toThrow();
  }, 240_000);

  it("created only portal objects and nothing in dbo", () => {
    const out = sqlcmd("-d", "portal_test", "-h", "-1", "-W", "-Q", "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo')");
    expect(out.trim()).toBe("0");
  });

  const run = (q: string): string => sqlcmd("-d", "portal_test", "-h", "-1", "-W", "-Q", `SET NOCOUNT ON; ${q}`).trim();
  const fails = (q: string, pattern: RegExp): void => {
    let message = "";
    try { run(q); } catch (e) { message = String((e as { stdout?: unknown; message?: string }).stdout ?? "") + String((e as Error).message); }
    expect(message, `expected failure for: ${q}`).toMatch(pattern);
  };
  const T = "11111111-1111-1111-1111-111111111111";
  const O1 = "aaaaaaaa-0000-0000-0000-000000000001";
  const O2 = "aaaaaaaa-0000-0000-0000-000000000002";
  const principal = (oid: string | null, gh: number | null): string => {
    const id = randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
    run(`INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id, github_user_id) VALUES ('${id}', ${oid ? `'${T}'` : "NULL"}, ${oid ? `'${oid}'` : "NULL"}, ${gh ?? "NULL"})`);
    return id;
  };
  const grant = (pid: string, oid: string, role: string, scope: string, value = ""): string =>
    `INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope, scope_value) VALUES ('${pid}', '${oid}', '${role}', '${scope}', N'${value}')`;

  it("accepts exactly the valid role/scope pairs", () => {
    const pid = principal(O1, 1001);
    const valid: [string, string, string][] = [
      ["user", "self", ""], ["manager", "self", ""], ["manager", "team", ""], ["executive", "department", "d1"],
      ["executive", "business_area", "b1"], ["executive", "company", ""], ["admin", "company", ""],
    ];
    for (const [r, s, v] of valid) expect(() => run(grant(pid, O1, r, s, v))).not.toThrow();
    for (const [r, s, v] of [["user", "team", ""], ["manager", "company", ""], ["executive", "self", ""], ["admin", "self", ""], ["admin", "department", "d1"]] as const) {
      fails(grant(pid, O1, r, s, v), /CK_AccessGrant_role_scope/);
    }
    fails(grant(pid, O1, "executive", "department", ""), /CK_AccessGrant_value/);
    fails(grant(pid, O1, "manager", "team", "x"), /CK_AccessGrant_value_empty/);
  });

  it("blocks grants for a GitHub-only principal and a mismatching Entra object ID", () => {
    const gh = principal(null, 1002);
    fails(grant(gh, O2, "user", "self"), /FK_AccessGrant_principal_entra/);
    const linked = principal(O2, 1003);
    fails(grant(linked, O1, "user", "self"), /FK_AccessGrant_principal_entra/);
  });

  it("allows one active link per Entra identity and per GitHub account, in both directions", () => {
    const link = (oid: string, gh: number): string => `INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id) VALUES ('${T}', '${oid}', ${gh})`;
    const L1 = "bbbbbbbb-0000-0000-0000-000000000001";
    const L2 = "bbbbbbbb-0000-0000-0000-000000000002";
    run(link(L1, 2001));
    fails(link(L1, 2002), /UX_PrincipalLinkState_entra/);
    fails(link(L2, 2001), /UX_PrincipalLinkState_github/);
    run(`UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(), unlink_reason = 'entra_disabled' WHERE entra_object_id = '${L1}'`);
    expect(() => run(link(L2, 2001))).not.toThrow();
    fails(`UPDATE portal.PrincipalLinkState SET unlink_reason = 'entra_disabled' WHERE entra_object_id = '${L2}'`, /CK_PrincipalLinkState_pair/);
  });

  it("hides a grant from v_active_grant after the directory sync revokes it, soft only", () => {
    const O3 = "aaaaaaaa-0000-0000-0000-000000000003";
    const pid = principal(O3, 1004);
    run(grant(pid, O3, "manager", "team"));
    expect(run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${pid}'`)).toBe("1");
    run(`INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, revoked_at, reason) VALUES ('${T}', '${O3}', DATEADD(SECOND, 5, SYSUTCDATETIME()), 'entra_disabled')`);
    expect(run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${pid}'`)).toBe("0");
    expect(run(`SELECT COUNT(*) FROM portal.AccessGrant WHERE principal_id = '${pid}' AND revoked_at IS NULL`)).toBe("1");
  });

  it("keeps event order below one second: a re-grant after a revocation is active, a tie fails closed", () => {
    const O6 = "aaaaaaaa-0000-0000-0000-000000000006";
    const pid = principal(O6, 1006);
    run(`INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope, scope_value, granted_at) VALUES ('${pid}', '${O6}', 'user', 'self', N'', '2030-01-01T00:00:00.1234567')`);
    run(`INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, revoked_at, reason) VALUES ('${T}', '${O6}', '2030-01-01T00:00:00.1234568', 'entra_disabled')`);
    expect(run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${pid}'`)).toBe("0");
    run(`UPDATE portal.AccessGrant SET revoked_at = '2030-01-01T00:00:00.1234568' WHERE principal_id = '${pid}'`);
    run(`INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope, scope_value, granted_at) VALUES ('${pid}', '${O6}', 'user', 'self', N'', '2030-01-01T00:00:00.1234569')`);
    expect(run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${pid}'`)).toBe("1");
    run(`INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, revoked_at, reason) VALUES ('${T}', '${O6}', '2030-01-01T00:00:00.1234569', 'entra_disabled')`);
    expect(run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${pid}'`)).toBe("0");
  });

  it("fills a missing Entra ID once through usp_link_principal_entra, without reassignment", () => {
    run("IF DATABASE_PRINCIPAL_ID('t_writer') IS NULL BEGIN CREATE USER t_writer WITHOUT LOGIN; ALTER ROLE portal_writer ADD MEMBER t_writer; END");
    const O7 = "aaaaaaaa-0000-0000-0000-000000000007";
    const O8 = "aaaaaaaa-0000-0000-0000-000000000008";
    const pid = principal(null, 1007);
    asUserFails("t_writer", `UPDATE portal.Principal SET entra_tenant_id = '${T}', entra_object_id = '${O7}' WHERE principal_id = '${pid}'`);
    expect(() => asUser("t_writer", `EXEC portal.usp_link_principal_entra @principal_id = '${pid}', @entra_tenant_id = '${T}', @entra_object_id = '${O7}'`)).not.toThrow();
    expect(run(`SELECT github_user_id FROM portal.Principal WHERE entra_object_id = '${O7}'`)).toBe("1007");
    fails(`EXECUTE AS USER = 't_writer'; EXEC portal.usp_link_principal_entra @principal_id = '${pid}', @entra_tenant_id = '${T}', @entra_object_id = '${O8}'; REVERT`, /not found or already linked/);
    const other = principal(null, 1008);
    fails(`EXECUTE AS USER = 't_writer'; EXEC portal.usp_link_principal_entra @principal_id = '${other}', @entra_tenant_id = '${T}', @entra_object_id = '${O7}'; REVERT`, /UX_Principal_entra/);
  });

  it("requires the manager email whenever a manager object ID is stored", () => {
    fails(`INSERT INTO portal.dim_user (user_id, manager_entra_object_id) VALUES (3001, '${O1}')`, /CK_dim_user_manager_email/);
    expect(() => run(`INSERT INTO portal.dim_user (user_id, manager_entra_object_id, manager_email, department, business_area) VALUES (3002, '${O1}', N'm@example.test', N'dept', N'area')`)).not.toThrow();
  });

  it("purges login history only past the maximum age and audits it", () => {
    run("INSERT INTO portal.dim_user (user_id) VALUES (3003)");
    run("INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day) VALUES (3003, N'old', '2000-01-01', '2000-01-02'), (3003, N'new', '2000-01-01', CAST(SYSUTCDATETIME() AS DATE))");
    fails("EXEC portal.usp_purge_login_history @max_age_months = 0", /between 1 and 60/);
    fails("EXEC portal.usp_purge_login_history @max_age_months = 61", /between 1 and 60/);
    expect(run("EXEC portal.usp_purge_login_history @max_age_months = 60")).toBe("1");
    run("INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day) VALUES (3003, N'old', '2000-01-01', '2000-01-02')");
    expect(run("EXEC portal.usp_purge_login_history @max_age_months = 24")).toBe("1");
    expect(run("SELECT login FROM portal.dim_user_login_history WHERE user_id = 3003")).toBe("new");
    expect(run("SELECT COUNT(*) FROM portal.IngestionAuditEvent WHERE action = 'login_history.purged'")).toBe("2");
  });

  it("accepts a quarantined run and issue actions, and rejects unknown actions", () => {
    run("INSERT INTO portal.TransformVersion (transform_version) SELECT 'q' WHERE NOT EXISTS (SELECT 1 FROM portal.TransformVersion WHERE transform_version = 'q')");
    const rid = "cccccccc-0000-0000-0000-000000000001";
    run(`INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, transform_version) VALUES ('${rid}', 'users_1_day', 'k', '2026-01-01', 'quarantined', 'q')`);
    run(`INSERT INTO portal.ValidationIssue (run_id, severity, error_code, issue_type, report_day) VALUES ('${rid}', 'fatal', 'smaller_day_blocked', 'smaller_day', '2026-01-01')`);
    const iid = run(`SELECT MAX(issue_id) FROM portal.ValidationIssue WHERE run_id = '${rid}'`);
    expect(() => run(`INSERT INTO portal.IssueAction (issue_id, action, actor_entra_oid) VALUES (${iid}, 'force', '${O1}')`)).not.toThrow();
    fails(`INSERT INTO portal.IssueAction (issue_id, action, actor_entra_oid) VALUES (${iid}, 'wipe', '${O1}')`, /CK_IssueAction_action/);
    fails(`INSERT INTO portal.IngestionAuditEvent (action, outcome) VALUES ('grant.created', 'success')`, /CK_IngestionAuditEvent_action/);
  });

  const asUser = (user: string, q: string): string => run(`EXECUTE AS USER = '${user}'; ${q}; REVERT`);
  const asUserFails = (user: string, q: string): void => fails(`EXECUTE AS USER = '${user}'; ${q}; REVERT`, /permission was denied|permission denied/i);

  it("enforces runtime permissions: ingestion cannot read grants, writer cannot rewrite a grant", () => {
    run("CREATE USER t_ingest WITHOUT LOGIN; ALTER ROLE portal_ingest ADD MEMBER t_ingest");
    asUserFails("t_ingest", "SELECT COUNT(*) FROM portal.v_active_grant");
    asUserFails("t_ingest", "SELECT COUNT(*) FROM portal.AccessGrant");

    const O5 = "aaaaaaaa-0000-0000-0000-000000000005";
    const pid = principal(O5, 1005);
    run(grant(pid, O5, "user", "self"));
    asUserFails("t_writer", `UPDATE portal.AccessGrant SET granted_at = DATEADD(DAY, 1, granted_at) WHERE principal_id = '${pid}'`);
    asUserFails("t_writer", `UPDATE portal.AccessGrant SET role = 'admin', scope = 'company' WHERE principal_id = '${pid}'`);
    asUserFails("t_writer", `DELETE FROM portal.AccessGrant WHERE principal_id = '${pid}'`);
    asUserFails("t_writer", `UPDATE portal.Principal SET entra_object_id = '${O1}' WHERE principal_id = '${pid}'`);
    expect(() => asUser("t_writer", `UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = '${pid}'`)).not.toThrow();
    // a re-grant is a new row once the old one is revoked
    expect(() => run(grant(pid, O5, "user", "self"))).not.toThrow();
    fails(grant(pid, O5, "user", "self"), /UX_AccessGrant_active/);
  });

  it("lets only the purge procedure delete login history for the ingestion role", () => {
    run("INSERT INTO portal.dim_user (user_id) VALUES (3004)");
    run("INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day) VALUES (3004, N'ancient', '2000-01-01', '2000-01-02')");
    asUserFails("t_ingest", "DELETE FROM portal.dim_user_login_history WHERE user_id = 3004");
    expect(() => asUser("t_ingest", "EXEC portal.usp_purge_login_history @max_age_months = 24")).not.toThrow();
    expect(run("SELECT COUNT(*) FROM portal.dim_user_login_history WHERE user_id = 3004")).toBe("0");
  });

  it("lets ingestion unlink but not relink or delete, and keeps the audit tables append-only", () => {
    const L3 = "bbbbbbbb-0000-0000-0000-000000000003";
    run(`INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id) VALUES ('${T}', '${L3}', 4001)`);
    asUserFails("t_ingest", `UPDATE portal.PrincipalLinkState SET github_user_id = 4002 WHERE entra_object_id = '${L3}'`);
    asUserFails("t_ingest", `DELETE FROM portal.PrincipalLinkState WHERE entra_object_id = '${L3}'`);
    expect(() => asUser("t_ingest", `UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(), unlink_reason = 'entra_disabled' WHERE entra_object_id = '${L3}'`)).not.toThrow();
    asUserFails("t_ingest", "UPDATE portal.IngestionAuditEvent SET outcome = 'failure'");
    asUserFails("t_ingest", "DELETE FROM portal.GrantRevocation");
  });
});

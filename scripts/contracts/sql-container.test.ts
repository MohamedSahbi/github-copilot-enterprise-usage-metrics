// Applies db/migrations through the migration runner on a SQL Server 2022 container. Run with RUN_SQL_TESTS=1 (needs Docker).
// Slow under emulation on Apple Silicon (linux/amd64). Uses a throwaway container with a random password and never a real server.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate";

const enabled = process.env.RUN_SQL_TESTS === "1";
const realMigrations = join(__dirname, "..", "..", "db", "migrations");
const realFiles = readdirSync(realMigrations).filter((f) => f.endsWith(".sql"));
const name = `portal-sql-test-${randomBytes(4).toString("hex")}`;
const sa = `Aa1!${randomBytes(12).toString("hex")}`;
let port = 0;
const tmpDirs: string[] = [];

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });
const connectionString = (database: string): string =>
  `Server=127.0.0.1,${port};Database=${database};User Id=sa;Password=${sa};Encrypt=true;TrustServerCertificate=true`;

async function query<T = Record<string, unknown>>(database: string, text: string): Promise<T[]> {
  const pool = await new sql.ConnectionPool(connectionString(database)).connect();
  try {
    return (await pool.request().query(text)).recordset as T[];
  } finally {
    await pool.close();
  }
}

let dbCounter = 0;
async function freshDb(): Promise<string> {
  const db = `portal_test_${++dbCounter}`;
  await query("master", `CREATE DATABASE ${db}`);
  return db;
}

function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  tmpDirs.push(dir);
  cpSync(realMigrations, dir, { recursive: true });
  return dir;
}

const cs = (db: string) => connectionString(db);

describe.skipIf(!enabled)("migration runner on SQL Server 2022 (RUN_SQL_TESTS=1)", () => {
  beforeAll(async () => {
    expect(spawnSync("docker", ["info"]).status, "docker daemon must be running").toBe(0);
    docker("run", "-d", "--rm", "--platform", "linux/amd64", "--name", name, "-p", "127.0.0.1::1433", "-e", "ACCEPT_EULA=Y", "-e", `MSSQL_SA_PASSWORD=${sa}`, "mcr.microsoft.com/mssql/server:2022-latest");
    port = Number(docker("port", name, "1433/tcp").trim().split("\n")[0]?.split(":").pop());
    for (let i = 0; i < 90; i++) {
      try { await query("master", "SELECT 1 AS ok"); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    await query("master", "SELECT 1 AS ok");
  }, 240_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", name]);
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("applies every migration once and records name and a 32-character md5 in portal.schema_version", async () => {
    const db = await freshDb();
    const result = await migrate({ connectionString: cs(db) });
    expect(result.applied).toHaveLength(realFiles.length);
    const rows = await query<{ version: number; name: string; md5: string; run_at: Date }>(db, "SELECT version, name, md5, run_at FROM portal.schema_version ORDER BY version");
    expect(rows).toHaveLength(realFiles.length);
    for (const r of rows) {
      expect(r.md5).toMatch(/^[0-9a-f]{32}$/);
      expect(r.run_at).toBeInstanceOf(Date);
    }
    expect(rows[0]?.name).toBe("portal-schema-and-history");
  }, 240_000);

  it("is a no-op the second time", async () => {
    const db = await freshDb();
    await migrate({ connectionString: cs(db) });
    const again = await migrate({ connectionString: cs(db) });
    expect(again.applied).toEqual([]);
    const [count] = await query<{ n: number }>(db, "SELECT COUNT(*) AS n FROM portal.schema_version");
    expect(count?.n).toBe(realFiles.length);
  }, 240_000);

  it("re-executes every script safely when history is lost after the scripts succeeded", async () => {
    const db = await freshDb();
    await migrate({ connectionString: cs(db) });
    await query(db, "DELETE FROM portal.schema_version");
    const again = await migrate({ connectionString: cs(db) });
    expect(again.applied).toHaveLength(realFiles.length);
    const [count] = await query<{ n: number }>(db, "SELECT COUNT(*) AS n FROM portal.schema_version");
    expect(count?.n).toBe(realFiles.length);
  }, 240_000);

  it("creates only portal objects: nothing in dbo and no dbo.schemaversion", async () => {
    const db = await freshDb();
    await migrate({ connectionString: cs(db) });
    const [dbo] = await query<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo')");
    expect(dbo?.n).toBe(0);
  }, 240_000);

  it("refuses when an applied migration's checksum changed and applies nothing new", async () => {
    const db = await freshDb();
    const dir = copyMigrations();
    await migrate({ connectionString: cs(db), dir });
    const first = join(dir, realFiles[1] as string);
    writeFileSync(first, `${readFileSync(first, "utf8")}\n-- edited after it was applied\n`);
    writeFileSync(join(dir, "20991231235959.do.must-not-run.sql"), "CREATE TABLE portal.must_not_exist (id INT);\n");
    await expect(migrate({ connectionString: cs(db), dir })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    const tables = await query(db, "SELECT name FROM sys.tables WHERE name = 'must_not_exist'");
    expect(tables).toHaveLength(0);
  }, 240_000);

  it("computes the same checksum for CRLF checkouts", async () => {
    const db = await freshDb();
    const dir = copyMigrations();
    await migrate({ connectionString: cs(db), dir });
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      writeFileSync(p, readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
    }
    const again = await migrate({ connectionString: cs(db), dir });
    expect(again.applied).toEqual([]);
  }, 240_000);

  it("stops at a failing migration, keeps earlier ones, and does not record the failed one", async () => {
    const db = await freshDb();
    const dir = copyMigrations();
    writeFileSync(join(dir, "20991231235958.do.fails.sql"), "SELECT 1/0 AS boom;\nGO\n");
    await expect(migrate({ connectionString: cs(db), dir })).rejects.toThrow();
    const rows = await query<{ n: number }>(db, "SELECT COUNT(*) AS n FROM portal.schema_version");
    expect(rows[0]?.n).toBe(realFiles.length);
    const failed = await query(db, "SELECT version FROM portal.schema_version WHERE version = 20991231235958");
    expect(failed).toHaveLength(0);
  }, 240_000);

  it("rejects a pending migration older than the newest applied one and applies nothing", async () => {
    const db = await freshDb();
    const dir = copyMigrations();
    writeFileSync(join(dir, "20260101000000.do.older-merged-later.sql"), "IF OBJECT_ID(N'portal.older_table', N'U') IS NULL CREATE TABLE portal.older_table (id INT);\n");
    // Seed the history as if the older file did not exist yet.
    const withoutOlder = copyMigrations();
    await migrate({ connectionString: cs(db), dir: withoutOlder });
    await expect(migrate({ connectionString: cs(db), dir })).rejects.toMatchObject({ code: "OUT_OF_ORDER" });
    expect(await query(db, "SELECT name FROM sys.tables WHERE name = 'older_table'")).toHaveLength(0);
    expect(await query(db, "SELECT version FROM portal.schema_version WHERE version = 20260101000000")).toHaveLength(0);
  }, 240_000);

  it("serialises two runners started at once: each migration is applied exactly once", async () => {
    const db = await freshDb();
    const results = await Promise.all([migrate({ connectionString: cs(db) }), migrate({ connectionString: cs(db) })]);
    expect(results.reduce((n, r) => n + r.applied.length, 0)).toBe(realFiles.length);
  }, 240_000);

  it("times out when another session holds portal-migrations, and works once it is released", async () => {
    const db = await freshDb();
    const holder = await new sql.ConnectionPool({ ...sql.ConnectionPool.parseConnectionString(cs(db)), pool: { min: 1, max: 1 } }).connect();
    try {
      const got = await holder.request().query("DECLARE @r INT; EXEC @r = sp_getapplock @Resource = N'portal-migrations', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0; SELECT @r AS r");
      expect(got.recordset[0]?.r).toBeGreaterThanOrEqual(0);
      await expect(migrate({ connectionString: cs(db), lockTimeoutMs: 1000 })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
      const rows = await query(db, "SELECT name FROM sys.tables WHERE name = 'schema_version'");
      expect(rows).toHaveLength(0);
    } finally {
      await holder.close();
    }
    const result = await migrate({ connectionString: cs(db), lockTimeoutMs: 1000 });
    expect(result.applied).toHaveLength(realFiles.length);
  }, 240_000);

  // Access-model and runtime-permission checks (issue #44), run against portal_test migrated through the runner.
  describe("access model and runtime permissions", () => {
    const sqlcmd = (...args: string[]): string =>
      docker("exec", "-e", `SQLCMDPASSWORD=${sa}`, name, "/opt/mssql-tools18/bin/sqlcmd", "-C", "-I", "-b", "-S", "localhost", "-U", "sa", ...args);

    beforeAll(async () => {
      sqlcmd("-Q", "CREATE DATABASE portal_test");
      await migrate({ connectionString: cs("portal_test") });
    }, 240_000);

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
      run(`UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(), unlink_seq = NEXT VALUE FOR portal.seq_access_event, unlink_reason = 'entra_disabled' WHERE entra_object_id = '${L1}'`);
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

    it("orders grants, revocations and unlinks by event_seq, not by timestamp, even when timestamps are equal", () => {
      const TS = "2031-01-01T00:00:00.0000000";
      const O9 = "aaaaaaaa-0000-0000-0000-000000000009";
      const pid = principal(O9, 1009);
      const visible = (): string => run(`SELECT COALESCE(STRING_AGG(role, ','), '') FROM portal.v_active_grant WHERE principal_id = '${pid}'`);
      const g = (role: string, scope: string): string =>
        `INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope, scope_value, granted_at) VALUES ('${pid}', '${O9}', '${role}', '${scope}', N'', '${TS}')`;
      const rev = `INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, revoked_at, reason) VALUES ('${T}', '${O9}', '${TS}', 'entra_disabled')`;
      run(g("user", "self"));
      expect(visible()).toBe("user");
      run(rev);
      expect(visible()).toBe("");
      run(g("manager", "self"));
      expect(visible()).toBe("manager");
      run(rev);
      expect(visible()).toBe("");
      // a grant keeps its position: a later grant cannot be hidden by an earlier revocation, an earlier one cannot come back
      run(g("manager", "team"));
      expect(visible()).toBe("manager");
      expect(run(`SELECT COUNT(*) FROM portal.AccessGrant WHERE principal_id = '${pid}' AND event_seq IS NOT NULL`)).toBe("3");
      expect(run(`SELECT COUNT(DISTINCT event_seq) FROM portal.AccessGrant WHERE principal_id = '${pid}'`)).toBe("3");
      // unlink with an equal timestamp hides earlier grants, a later grant is visible
      run(`INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id, linked_at) VALUES ('${T}', '${O9}', 1009, '${TS}')`);
      run(`UPDATE portal.PrincipalLinkState SET unlinked_at = '${TS}', unlink_seq = NEXT VALUE FOR portal.seq_access_event, unlink_reason = 'entra_disabled' WHERE entra_object_id = '${O9}'`);
      expect(visible()).toBe("");
      run(g("executive", "company"));
      expect(visible()).toBe("executive");
      // incomplete ordering (unlinked without a sequence) is rejected by the database
      fails(`UPDATE portal.PrincipalLinkState SET unlink_seq = NULL WHERE entra_object_id = '${O9}'`, /CK_PrincipalLinkState_pair/);
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
      expect(() => asUser("t_ingest", `UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(), unlink_seq = NEXT VALUE FOR portal.seq_access_event, unlink_reason = 'entra_disabled' WHERE entra_object_id = '${L3}'`)).not.toThrow();
      asUserFails("t_ingest", "UPDATE portal.IngestionAuditEvent SET outcome = 'failure'");
      asUserFails("t_ingest", "DELETE FROM portal.GrantRevocation");
    });
  });
});

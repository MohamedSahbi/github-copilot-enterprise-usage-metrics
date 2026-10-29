// Applies db/migrations through the migration runner on a SQL Server 2022 container. Run with RUN_SQL_TESTS=1 (needs Docker).
// Slow under emulation on Apple Silicon (linux/amd64). Uses a throwaway container, or an explicitly allocator-owned local container.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TABLE_COLUMNS } from "../../shared/src/rows";
import { assertComponentIngestionPermissions } from "./component-ingestion-permissions";
import { migrate } from "../db/migrate";
import { splitBatches } from "../db/split-go";
import { createStagingContext, mapUsersDayLine } from "./reference/staging";

const enabled = process.env.RUN_SQL_TESTS === "1";
function allocatorSqlConfig(env: NodeJS.ProcessEnv) {
  const keys = [
    "SQL_TEST_ALLOCATOR_MODE", "SQL_TEST_ALLOCATOR_HOST", "SQL_TEST_ALLOCATOR_PORT",
    "SQL_TEST_ALLOCATOR_PASSWORD", "SQL_TEST_ALLOCATOR_NAMESPACE", "SQL_TEST_ALLOCATOR_CONTAINER_ID",
  ] as const;
  if (keys.every((key) => env[key] === undefined)) return undefined;
  if (env.SQL_TEST_ALLOCATOR_MODE !== "1"
    || env.SQL_TEST_ALLOCATOR_HOST !== "127.0.0.1"
    || env.SQL_TEST_ALLOCATOR_PORT !== "14339"
    || !env.SQL_TEST_ALLOCATOR_PASSWORD
    || !/^history172_79f3b517_[a-f0-9]{16}$/.test(env.SQL_TEST_ALLOCATOR_NAMESPACE ?? "")
    || !/^[a-f0-9]{64}$/.test(env.SQL_TEST_ALLOCATOR_CONTAINER_ID ?? "")) {
    throw new Error("Allocator SQL mode requires explicit loopback:14339, credentials, a unique history172 namespace and full container ID");
  }
  return {
    password: env.SQL_TEST_ALLOCATOR_PASSWORD,
    namespace: env.SQL_TEST_ALLOCATOR_NAMESPACE!,
    containerId: env.SQL_TEST_ALLOCATOR_CONTAINER_ID!,
  };
}
const allocator = allocatorSqlConfig(process.env);
const realMigrations = join(__dirname, "..", "..", "db", "migrations");
const realFiles = readdirSync(realMigrations).filter((f) => f.endsWith(".sql"));
const name = `portal-sql-test-${randomBytes(4).toString("hex")}`;
const sa = allocator?.password ?? `Aa1!${randomBytes(12).toString("hex")}`;
const containerId = allocator?.containerId ?? name;
const accessDb = allocator ? `${allocator.namespace}_access` : "portal_test";
let port = allocator ? 14339 : 0;
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
  const db = allocator ? `${allocator.namespace}_${++dbCounter}` : `portal_test_${++dbCounter}`;
  await createDb(db);
  return db;
}

async function createDb(db: string): Promise<void> {
  if (allocator) {
    if (!db.startsWith(`${allocator.namespace}_`) || !/^[a-z0-9_]+$/.test(db)) {
      throw new Error("Refusing a database outside the allocator namespace");
    }
    const pool = await new sql.ConnectionPool(connectionString("master")).connect();
    try {
      const existing = await pool.request().input("name", sql.NVarChar(128), db)
        .query<{ id: number | null }>("SELECT DB_ID(@name) AS id");
      if (existing.recordset[0]?.id !== null) throw new Error(`Refusing existing allocator database: ${db}`);
    } finally {
      await pool.close();
    }
  }
  await query("master", `CREATE DATABASE ${db}`);
}

function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  tmpDirs.push(dir);
  cpSync(realMigrations, dir, { recursive: true });
  return dir;
}

const cs = (db: string) => connectionString(db);

describe("allocator SQL configuration guards (no SQL)", () => {
  const valid = {
    SQL_TEST_ALLOCATOR_MODE: "1",
    SQL_TEST_ALLOCATOR_HOST: "127.0.0.1",
    SQL_TEST_ALLOCATOR_PORT: "14339",
    SQL_TEST_ALLOCATOR_PASSWORD: "synthetic-test-password",
    SQL_TEST_ALLOCATOR_NAMESPACE: "history172_79f3b517_0123456789abcdef",
    SQL_TEST_ALLOCATOR_CONTAINER_ID: "a".repeat(64),
  };
  it("preserves self-managed CI mode only when allocator settings are absent", () => {
    expect(allocatorSqlConfig({})).toBeUndefined();
    expect(allocatorSqlConfig(valid)).toEqual({
      password: valid.SQL_TEST_ALLOCATOR_PASSWORD,
      namespace: valid.SQL_TEST_ALLOCATOR_NAMESPACE,
      containerId: valid.SQL_TEST_ALLOCATOR_CONTAINER_ID,
    });
  });
  it.each(Object.keys(valid))("rejects partial allocator configuration without %s", (key) => {
    const partial: NodeJS.ProcessEnv = { ...valid };
    delete partial[key];
    expect(() => allocatorSqlConfig(partial)).toThrow(/Allocator SQL mode requires/);
  });
  it.each([
    ["SQL_TEST_ALLOCATOR_MODE", "0"],
    ["SQL_TEST_ALLOCATOR_HOST", "localhost"],
    ["SQL_TEST_ALLOCATOR_HOST", "192.0.2.1"],
    ["SQL_TEST_ALLOCATOR_PORT", "14330"],
    ["SQL_TEST_ALLOCATOR_PASSWORD", ""],
    ["SQL_TEST_ALLOCATOR_NAMESPACE", "portal_test"],
    ["SQL_TEST_ALLOCATOR_NAMESPACE", "history172_79f3b517_0123456789abcdef;DROP"],
    ["SQL_TEST_ALLOCATOR_CONTAINER_ID", "a".repeat(12)],
  ])("rejects invalid allocator setting %s=%s", (key, value) => {
    expect(() => allocatorSqlConfig({ ...valid, [key]: value })).toThrow(/Allocator SQL mode requires/);
  });
});

describe.skipIf(!enabled)("migration runner on SQL Server 2022 (RUN_SQL_TESTS=1)", () => {
  beforeAll(async () => {
    expect(spawnSync("docker", ["info"]).status, "docker daemon must be running").toBe(0);
    if (allocator) {
      expect(docker("inspect", "--format", '{{.Id}} {{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}', containerId).trim())
        .toBe(`${containerId} true history172-79f3b517`);
      expect(docker("port", containerId, "1433/tcp").trim()).toBe("127.0.0.1:14339");
    } else {
      docker("run", "-d", "--rm", "--platform", "linux/amd64", "--name", name, "-p", "127.0.0.1::1433", "-e", "ACCEPT_EULA=Y", "-e", `MSSQL_SA_PASSWORD=${sa}`, "mcr.microsoft.com/mssql/server:2022-latest");
      port = Number(docker("port", name, "1433/tcp").trim().split("\n")[0]?.split(":").pop());
    }
    for (let i = 0; i < 90; i++) {
      try { await query("master", "SELECT 1 AS ok"); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    await query("master", "SELECT 1 AS ok");
  }, 240_000);

  afterAll(() => {
    if (!allocator) spawnSync("docker", ["rm", "-f", name]);
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

  it("adds only the bounded contract EXECUTE grant and leaves reader/ingestion permissions unchanged", async () => {
    const db = await freshDb();
    const migrationName = "20261028042100.do.revoked-grant-conflict-contract.sql";
    const oldDir = copyMigrations();
    rmSync(join(oldDir, migrationName));
    await migrate({ connectionString: cs(db), dir: oldDir });

    const unchangedRolePermissions = () => query(db, `
      SELECT principal.name, permission.class, permission.major_id, permission.minor_id,
        permission.permission_name, permission.state, permission.state_desc
      FROM sys.database_permissions AS permission
      JOIN sys.database_principals AS principal
        ON principal.principal_id = permission.grantee_principal_id
      WHERE principal.name IN (N'portal_reader', N'portal_ingest')
      ORDER BY principal.name, permission.class, permission.major_id, permission.minor_id,
        permission.permission_name, permission.state`);
    const before = await unchangedRolePermissions();
    const migration = readFileSync(join(realMigrations, migrationName), "utf8");
    const batches = splitBatches(migration);
    for (const batch of batches) await query(db, batch);

    const after = await unchangedRolePermissions();
    expect(after).toEqual(before);
    const contractPermissions = await query<{ principal: string; permission: string; state: string }>(db, `
      SELECT principal.name AS principal, permission.permission_name AS permission, permission.state_desc AS state
      FROM sys.database_permissions AS permission
      JOIN sys.database_principals AS principal
        ON principal.principal_id = permission.grantee_principal_id
      WHERE permission.class = 1
        AND permission.major_id = OBJECT_ID(N'portal.usp_has_revoked_grant_conflict')`);
    expect(contractPermissions).toEqual([{ principal: "portal_writer", permission: "EXECUTE", state: "GRANT" }]);

    for (const batch of batches) await query(db, batch);
    expect(await unchangedRolePermissions()).toEqual(before);
    expect(await query(db, `
      SELECT principal.name AS principal, permission.permission_name AS permission, permission.state_desc AS state
      FROM sys.database_permissions AS permission
      JOIN sys.database_principals AS principal
        ON principal.principal_id = permission.grantee_principal_id
      WHERE permission.class = 1
        AND permission.major_id = OBJECT_ID(N'portal.usp_has_revoked_grant_conflict')`))
      .toEqual(contractPermissions);
  }, 240_000);

  it("fails closed when a component role name is occupied by a non-role principal", async () => {
    const db = await freshDb();
    const migration = "20261027095703.do.component-ingestion-user-write.sql";
    const oldDir = copyMigrations();
    rmSync(join(oldDir, migration));
    await migrate({ connectionString: cs(db), dir: oldDir });
    await query(db, "CREATE USER portal_metrics_ingest WITHOUT LOGIN");
    const batches = splitBatches(readFileSync(join(realMigrations, migration), "utf8"));
    await query(db, batches[0] ?? "");
    await query(db, batches[1] ?? "");
    await expect(query(db, batches[2] ?? "")).rejects.toThrow(/role name is occupied by a non-role principal/i);
  }, 240_000);

  it("upgrades populated restoration tables without fabrication and accepts nullable bounded storage", async () => {
    const db = await freshDb();
    const migration = "20261026010000.do.restoration-nullable-contract.sql";
    const oldDir = copyMigrations();
    const pendingFiles = realFiles.filter((file) => file >= migration);
    for (const file of pendingFiles) rmSync(join(oldDir, file));
    await migrate({ connectionString: cs(db), dir: oldDir });
    await query(db, `
      DECLARE @run UNIQUEIDENTIFIER = '00000000-0000-4000-8000-000000000120';
      INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, transform_version)
        VALUES (@run, 'users_1_day', 'fixture', 'staged', '1');
      INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
        VALUES (@run, 'fixture', 'restoration.ndjson', REPLICATE('0', 64), 1);
      DECLARE @artifact BIGINT = SCOPE_IDENTITY();
      INSERT INTO portal.dim_user (user_id) VALUES (120);
      INSERT INTO portal.dim_organization (organization_id, login) VALUES (120, 'fixture');
      INSERT INTO portal.stg_user_daily
        (run_id, artifact_id, line_number, organization_id, user_id, usage_day,
         interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add,
         loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
         used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent,
         used_code_review_active, used_code_review_passive, ai_credits_used)
        VALUES (@run, @artifact, 1, 120, 120, '2026-03-02', 2, 3, 1, 4, 0, 1, 0,
          0, 0, 1, 0, 0, 0, 0, 0, 0, 123456789.123456789);
      INSERT INTO portal.fact_user_daily_usage
        (organization_id, user_id, usage_day, interaction_count, code_generation_count,
         code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted,
         used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app,
         used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used,
         run_id, source_artifact_id, transform_version)
        SELECT organization_id, user_id, usage_day, interaction_count, code_generation_count,
          code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted,
          used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app,
          used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used,
          run_id, artifact_id, '1' FROM portal.stg_user_daily;
      INSERT INTO portal.stg_user_breakdown
        (run_id, artifact_id, line_number, item_number, breakdown_kind, key_1, key_2,
         interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add,
         loc_suggested_to_delete, loc_added, loc_deleted)
        VALUES (@run, @artifact, 1, 1, 'client', 'copilot_cli', '', 0, 0, 0, 0, 0, 0, 0);
      INSERT INTO portal.fact_usage_breakdown
        (organization_id, user_id, usage_day, breakdown_kind, key_1, key_2,
         interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add,
         loc_suggested_to_delete, loc_added, loc_deleted, run_id, source_artifact_id, transform_version)
        VALUES (120, 120, '2026-03-02', 'client', 'copilot_cli', '', 0, 0, 0, 0, 0, 0, 0, @run, @artifact, '1');
    `);
    expect((await migrate({ connectionString: cs(db) })).applied).toHaveLength(pendingFiles.length);
    expect((await migrate({ connectionString: cs(db) })).applied).toEqual([]);
    for (const batch of splitBatches(readFileSync(join(realMigrations, migration), "utf8"))) await query(db, batch);
    for (const table of ["stg_user_daily", "fact_user_daily_usage"]) {
      expect(await query(db, `SELECT ai_adoption_phase_version, interaction_count,
        CONVERT(VARCHAR(40), ai_credits_used) AS credits FROM portal.${table}`))
        .toEqual([{ ai_adoption_phase_version: null, interaction_count: 2, credits: "123456789.123456789" }]);
      await query(db, `UPDATE portal.${table} SET ai_adoption_phase_version = REPLICATE('v', 64)`);
      expect(await query(db, `SELECT DATALENGTH(ai_adoption_phase_version) AS width FROM portal.${table}`))
        .toEqual([{ width: 64 }]);
      await expect(query(db, `UPDATE portal.${table} SET ai_adoption_phase_version = REPLICATE('v', 65)`)).rejects.toThrow();
      await query(db, `UPDATE portal.${table} SET ai_adoption_phase_version = NULL`);
    }
    for (const table of ["stg_user_breakdown", "fact_usage_breakdown"]) {
      expect(await query(db, `SELECT prompt_count, total_user_messages FROM portal.${table}`))
        .toEqual([{ prompt_count: null, total_user_messages: null }]);
      for (const value of [0, 1, 2147483647, null]) {
        const literal = value === null ? "NULL" : String(value);
        await query(db, `UPDATE portal.${table} SET prompt_count = ${literal}, total_user_messages = ${literal}`);
        expect(await query(db, `SELECT prompt_count, total_user_messages FROM portal.${table}`))
          .toEqual([{ prompt_count: value, total_user_messages: value }]);
      }
      for (const column of ["prompt_count", "total_user_messages"]) {
        await expect(query(db, `UPDATE portal.${table} SET ${column} = -1`)).rejects.toThrow(/CHECK constraint/);
        await expect(query(db, `UPDATE portal.${table} SET ${column} = 2147483648`)).rejects.toThrow(/overflow/i);
      }
    }
    const columns = await query(db, `
      SELECT OBJECT_NAME(c.object_id) AS table_name, c.name, TYPE_NAME(c.user_type_id) AS type_name,
        c.max_length, c.is_nullable, c.default_object_id
      FROM sys.columns c WHERE c.object_id IN (OBJECT_ID('portal.stg_user_daily'),
        OBJECT_ID('portal.fact_user_daily_usage'), OBJECT_ID('portal.stg_user_breakdown'),
        OBJECT_ID('portal.fact_usage_breakdown'))
        AND c.name IN ('ai_adoption_phase_version', 'prompt_count', 'total_user_messages')`);
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column).toMatchObject({
        type_name: column.name === "ai_adoption_phase_version" ? "varchar" : "int",
        max_length: column.name === "ai_adoption_phase_version" ? 64 : 4,
        is_nullable: true, default_object_id: 0,
      });
    }
  }, 240_000);

  it("adds unresolved manager defaults to populated users and preserves evidence on rerun", async () => {
    const db = await freshDb();
    const migration = "20261027092500.do.user-manager-resolution-contract.sql";
    const oldDir = copyMigrations();
    const pendingFiles = realFiles.filter((file) => file >= migration);
    for (const file of pendingFiles) rmSync(join(oldDir, file));
    await migrate({ connectionString: cs(db), dir: oldDir });
    await query(db, `
      INSERT INTO portal.dim_user (user_id, login, entra_object_id, manager_entra_object_id,
        manager_email, department, business_area)
      VALUES (7101, N'directory-fixture', 'aaaaaaaa-0000-0000-0000-000000007101',
        'aaaaaaaa-0000-0000-0000-000000007102', N'manager@example.test', N'department', N'area');
      INSERT INTO portal.dim_user (user_id) VALUES (7102);
    `);
    const before = await query(db, "SELECT * FROM portal.dim_user ORDER BY user_id");
    expect((await migrate({ connectionString: cs(db) })).applied).toHaveLength(pendingFiles.length);
    expect(await query(db, "SELECT * FROM portal.dim_user ORDER BY user_id"))
      .toEqual(before.map((row) => ({ ...row, manager_resolved: false, manager_checked_at: null })));

    await query(db, `
      INSERT INTO portal.dim_user (user_id) VALUES (7103);
      UPDATE portal.dim_user SET manager_resolved = 1, manager_checked_at = '2026-10-27T09:00:00'
        WHERE user_id IN (7101, 7102);
      UPDATE portal.dim_user SET manager_checked_at = '2026-10-27T09:01:00' WHERE user_id = 7103;
    `);
    expect(await query(db, `SELECT user_id, manager_resolved, manager_checked_at
      FROM portal.dim_user ORDER BY user_id`)).toEqual([
      { user_id: "7101", manager_resolved: true, manager_checked_at: new Date("2026-10-27T09:00:00Z") },
      { user_id: "7102", manager_resolved: true, manager_checked_at: new Date("2026-10-27T09:00:00Z") },
      { user_id: "7103", manager_resolved: false, manager_checked_at: new Date("2026-10-27T09:01:00Z") },
    ]);
    await query(db, "INSERT INTO portal.dim_user (user_id) VALUES (7104)");
    expect(await query(db, `SELECT manager_resolved, manager_checked_at
      FROM portal.dim_user WHERE user_id = 7104`))
      .toEqual([{ manager_resolved: false, manager_checked_at: null }]);
    await expect(query(db, "UPDATE portal.dim_user SET manager_resolved = NULL WHERE user_id = 7104"))
      .rejects.toThrow(/NULL/i);
    const populated = await query(db, "SELECT * FROM portal.dim_user ORDER BY user_id");
    expect((await migrate({ connectionString: cs(db) })).applied).toEqual([]);
    for (const batch of splitBatches(readFileSync(join(realMigrations, migration), "utf8"))) await query(db, batch);
    expect(await query(db, "SELECT * FROM portal.dim_user ORDER BY user_id")).toEqual(populated);

    const columns = await query(db, `
      SELECT c.name, TYPE_NAME(c.user_type_id) AS type_name, c.is_nullable, c.scale,
        dc.name AS default_name, dc.definition AS default_definition
      FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
      WHERE c.object_id = OBJECT_ID('portal.dim_user')
        AND c.name IN ('manager_resolved', 'manager_checked_at') ORDER BY c.column_id`);
    expect(columns).toEqual([
      { name: "manager_resolved", type_name: "bit", is_nullable: false, scale: 0,
        default_name: "DF_dim_user_manager_resolved", default_definition: "((0))" },
      { name: "manager_checked_at", type_name: "datetime2", is_nullable: true, scale: 0,
        default_name: null, default_definition: null },
    ]);
  }, 240_000);

  it("keeps delimiter-containing billing keys distinct across staging, facts and aggregates", async () => {
    const db = await freshDb();
    const migration = "20261026001200.do.billing-key-framing.sql";
    const oldDir = copyMigrations();
    const pendingFiles = realFiles.filter((file) => file >= migration);
    for (const file of pendingFiles) rmSync(join(oldDir, file));
    await migrate({ connectionString: cs(db), dir: oldDir });
    await query(db, `
      DECLARE @run UNIQUEIDENTIFIER = '00000000-0000-4000-8000-000000000045';
      INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, transform_version)
        VALUES (@run, 'ai_credit', 'fixture', 'staged', '1');
      INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
        VALUES (@run, 'fixture', 'keys.csv', REPLICATE('0', 64), 1);
      DECLARE @artifact BIGINT = SCOPE_IDENTITY();
      INSERT INTO portal.stg_ai_credit_line
        (run_id, artifact_id, line_number, usage_date, username, model, organization)
        VALUES (@run, @artifact, 100, '2026-03-02', N'existing', N'model', N'org');
      INSERT INTO portal.fact_ai_credit_line
        (usage_date, organization_login, username, model, cost_center_name, repository, app_client_id,
         run_id, source_artifact_id, transform_version)
        VALUES ('2026-03-02', N'org', N'existing', N'model', N'', N'', N'', @run, @artifact, '1');
      INSERT INTO portal.agg_ai_credit_daily
        (usage_date, organization_login, model, cost_center_name, metric_version, user_count,
         aic_quantity, aic_gross_amount, net_amount, run_id, transform_version)
        VALUES ('2026-03-02', N'org', N'model', N'', 1, 5, 1, 1, 1, @run, '1');
    `);
    const oldHashes = await query<{ natural_key: Buffer }>(db, "SELECT natural_key FROM portal.stg_ai_credit_line");
    expect((await migrate({ connectionString: cs(db) })).applied).toHaveLength(pendingFiles.length);
    const newHashes = await query<{ natural_key: Buffer }>(db, "SELECT natural_key FROM portal.stg_ai_credit_line");
    expect(newHashes[0]!.natural_key.equals(oldHashes[0]!.natural_key)).toBe(false);
    await query(db, readFileSync(join(realMigrations, migration), "utf8"));
    expect(await query(db, "SELECT natural_key FROM portal.stg_ai_credit_line")).toEqual(newHashes);
    await query(db, `
      DECLARE @run UNIQUEIDENTIFIER = '00000000-0000-4000-8000-000000000045';
      DECLARE @artifact BIGINT = (SELECT artifact_id FROM portal.SourceArtifact WHERE run_id = @run);
      INSERT INTO portal.stg_ai_credit_line
        (run_id, artifact_id, line_number, usage_date, username, model, organization, cost_center_name, repository, app_client_id, sku)
      SELECT @run, @artifact, n, '2026-03-02', username, model, organization, cc, repository, app, sku
      FROM (VALUES
        (1, N'a|b', N'c', N'org', N'', N'', N'', N''),
        (2, N'a', N'b|c', N'org', N'', N'', N'', N''),
        (3, NCHAR(937), N'c', N'org', N'12:|', N'repo', N'app', NULL),
        (4, NCHAR(937), N'c', N'org', N'12:', N'|repo', N'app', NULL)
      ) AS k(n, username, model, organization, cc, repository, app, sku);
      INSERT INTO portal.fact_ai_credit_line
        (usage_date, organization_login, username, model, cost_center_name, repository, app_client_id, sku,
         run_id, source_artifact_id, transform_version)
      SELECT usage_date, organization, username, model, cost_center_name, repository, app_client_id, sku,
        run_id, artifact_id, '1' FROM portal.stg_ai_credit_line WHERE line_number < 100;
      INSERT INTO portal.agg_ai_credit_daily
        (usage_date, organization_login, model, cost_center_name, metric_version, user_count,
         aic_quantity, aic_gross_amount, net_amount, run_id, transform_version)
      VALUES
        ('2026-03-02', N'a|b', N'c', N'', 1, 5, 1, 1, 1, @run, '1'),
        ('2026-03-02', N'a', N'b|c', N'', 1, 5, 1, 1, 1, @run, '1');
    `);
    const [counts] = await query<{ staging: number; facts: number; aggregates: number }>(db, `
      SELECT
        (SELECT COUNT(DISTINCT natural_key) FROM portal.stg_ai_credit_line) AS staging,
        (SELECT COUNT(DISTINCT natural_key) FROM portal.fact_ai_credit_line) AS facts,
        (SELECT COUNT(DISTINCT natural_key) FROM portal.agg_ai_credit_daily) AS aggregates`);
    expect(counts).toEqual({ staging: 5, facts: 5, aggregates: 3 });
    const [parity] = await query<{ n: number }>(db, `
      SELECT COUNT(*) AS n FROM portal.stg_ai_credit_line s JOIN portal.fact_ai_credit_line f
        ON s.usage_date = f.usage_date AND s.natural_key = f.natural_key`);
    expect(parity?.n).toBe(5);
    await expect(query(db, `
      INSERT INTO portal.stg_ai_credit_line
        (run_id, artifact_id, line_number, usage_date, username, model, organization, cost_center_name, repository, app_client_id, sku)
      SELECT TOP (1) run_id, artifact_id, 200, usage_date, username, model, organization, cost_center_name, repository, app_client_id, sku
        FROM portal.stg_ai_credit_line
    `)).rejects.toThrow(/UX_stg_ai_credit_key/);
    await expect(query(db, `
      INSERT INTO portal.fact_ai_credit_line
        (usage_date, organization_login, username, model, cost_center_name, repository, app_client_id, sku,
         run_id, source_artifact_id, transform_version)
      SELECT TOP (1) usage_date, organization_login, username, model, cost_center_name, repository, app_client_id, sku,
        run_id, source_artifact_id, transform_version FROM portal.fact_ai_credit_line
    `)).rejects.toThrow(/PK_fact_ai_credit_line/);
    await expect(query(db, `
      INSERT INTO portal.agg_ai_credit_daily
        (usage_date, organization_login, model, cost_center_name, metric_version, user_count,
         aic_quantity, aic_gross_amount, net_amount, run_id, transform_version)
      SELECT usage_date, organization_login, model, cost_center_name, metric_version, user_count,
        aic_quantity, aic_gross_amount, net_amount, run_id, transform_version FROM portal.agg_ai_credit_daily
    `)).rejects.toThrow(/PK_agg_ai_credit_daily/);
  }, 240_000);

  it("stores the original NDJSON credit token as an exact SQL decimal", async () => {
    const db = await freshDb();
    await migrate({ connectionString: cs(db) });
    const run = "00000000-0000-4000-8000-000000000046";
    const [artifact] = await query<{ artifact_id: number }>(db, `
      INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, transform_version)
        VALUES ('${run}', 'users_1_day', 'fixture', 'staged', '1');
      INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
        OUTPUT INSERTED.artifact_id
        VALUES ('${run}', 'fixture', 'credits.ndjson', REPLICATE('0', 64), 1);
    `);
    const mapped = mapUsersDayLine(
      '{"day":"2026-03-02","user_id":1,"organization_id":1,"loc_added_sum":0,"loc_deleted_sum":0,"loc_suggested_to_add_sum":0,"loc_suggested_to_delete_sum":0,"ai_credits_used":999999999.999999999}',
      1, createStagingContext(run, { start: "2026-03-02", end: "2026-03-02" }), artifact!.artifact_id,
    );
    expect(mapped.issues).toEqual([]);
    expect(mapped.daily!.ai_credits_used).toBe("999999999.999999999");
    const pool = await new sql.ConnectionPool(cs(db)).connect();
    try {
      const entries = Object.entries(mapped.daily!);
      const request = pool.request();
      entries.forEach(([, value], i) => request.input(`p${i}`, value));
      await request.query(`INSERT INTO portal.stg_user_daily (${entries.map(([key]) => `[${key}]`).join(",")})
        VALUES (${entries.map((_, i) => `@p${i}`).join(",")})`);
    } finally {
      await pool.close();
    }
    const [stored] = await query<{ credits: string }>(db,
      "SELECT CONVERT(NVARCHAR(40), ai_credits_used) AS credits FROM portal.stg_user_daily");
    expect(stored?.credits).toBe("999999999.999999999");
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

  it("reuses the directory contract tables after two applies and isolates ingestion writes from portal ownership", async () => {
    const db = await freshDb();
    await migrate({ connectionString: cs(db) });
    expect((await migrate({ connectionString: cs(db) })).applied).toEqual([]);
    const tables = [
      "portal.dim_user", "portal.dim_user_login_history", "portal.DirectorySyncState",
      "portal.PrincipalLinkState", "portal.GrantRevocation", "portal.IngestionAuditEvent",
    ] as const;
    const columns = await query<{ table_name: string; column_name: string; type_name: string; max_length: number }>(db, `
      SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS table_name, c.name AS column_name,
        TYPE_NAME(c.user_type_id) AS type_name, c.max_length
      FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
      WHERE t.schema_id = SCHEMA_ID('portal') ORDER BY c.column_id`);
    for (const table of tables) {
      expect(columns.filter((c) => c.table_name === table).map((c) => c.column_name)).toEqual([...TABLE_COLUMNS[table]]);
    }
    for (const [column, type, length] of [
      ["user_id", "bigint", 8], ["entra_object_id", "uniqueidentifier", 16],
      ["login", "nvarchar", 510], ["email", "nvarchar", 640], ["display_name", "nvarchar", 510],
      ["manager_entra_object_id", "uniqueidentifier", 16], ["manager_email", "nvarchar", 640],
      ["department", "nvarchar", 200], ["business_area", "nvarchar", 100],
    ] as const) {
      expect(columns.find((c) => c.table_name === "portal.dim_user" && c.column_name === column))
        .toMatchObject({ type_name: type, max_length: length });
    }
    await query(db, "CREATE USER directory_inventory_ingest WITHOUT LOGIN; ALTER ROLE portal_ingest ADD MEMBER directory_inventory_ingest");
    await query(db, `
      EXECUTE AS USER = 'directory_inventory_ingest';
      INSERT INTO portal.dim_user (user_id, login, entra_object_id, manager_entra_object_id, manager_email, department, business_area)
        VALUES (7001, N'directory-fixture', 'aaaaaaaa-0000-0000-0000-000000007001',
          'aaaaaaaa-0000-0000-0000-000000007002', N'manager@example.test', N'department', N'area');
      INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day)
        VALUES (7001, N'directory-fixture', '2026-03-02', '2026-03-02');
      INSERT INTO portal.DirectorySyncState (source, last_attempt_at, last_error_code)
        VALUES ('csv', SYSUTCDATETIME(), 'invalid_row');
      INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id)
        VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000007001', 7001);
      UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(),
        unlink_seq = NEXT VALUE FOR portal.seq_access_event, unlink_reason = 'entra_disabled' WHERE github_user_id = 7001;
      INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, reason)
        VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000007001', 'entra_disabled');
      INSERT INTO portal.IngestionAuditEvent (action, outcome)
        VALUES ('principal.unlinked_by_directory_sync', 'success');
      REVERT`);
    const [state] = await query<{ last_success_at: Date | null; last_error_code: string }>(db,
      "SELECT last_success_at, last_error_code FROM portal.DirectorySyncState WHERE source = 'csv'");
    expect(state).toEqual({ last_success_at: null, last_error_code: "invalid_row" });
    for (const statement of [
      "INSERT INTO portal.AccessGrant DEFAULT VALUES",
      "UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE 1 = 0",
      "DELETE FROM portal.AccessGrant WHERE 1 = 0",
      "INSERT INTO portal.Principal DEFAULT VALUES",
      "UPDATE portal.Principal SET entra_object_id = NULL WHERE 1 = 0",
      "DELETE FROM portal.Principal WHERE 1 = 0",
      "INSERT INTO portal.PrincipalIdentity DEFAULT VALUES",
      "UPDATE portal.PrincipalIdentity SET subject_id = N'not-allowed' WHERE 1 = 0",
      "DELETE FROM portal.PrincipalIdentity WHERE 1 = 0",
      "INSERT INTO portal.AuditLog DEFAULT VALUES",
    ]) {
      await expect(query(db, `EXECUTE AS USER = 'directory_inventory_ingest'; ${statement}; REVERT`))
        .rejects.toThrow(/permission was denied|permission denied/i);
    }
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
    let diagnosticQuery = 0;
    const sqlcmd = (...args: string[]): string => {
      const started = performance.now();
      const ordinal = ++diagnosticQuery;
      let completed = false;
      try {
        const result = execFileSync("docker", [
          "exec", "-e", "SQLCMDPASSWORD", containerId, "/opt/mssql-tools18/bin/sqlcmd",
          "-C", "-I", "-b", "-S", "localhost", "-U", "sa", ...args,
        ], { encoding: "utf8", env: { ...process.env, SQLCMDPASSWORD: sa } });
        completed = true;
        return result;
      } finally {
        if (allocator && process.env.SQL_TEST_ALLOCATOR_DIAGNOSTIC === "1") {
          console.error(JSON.stringify({
            event: "sqlcmd-duration", ordinal,
            durationMs: performance.now() - started, completed,
          }));
        }
      }
    };

    beforeAll(async () => {
      await createDb(accessDb);
      await migrate({ connectionString: cs(accessDb) });
    }, 240_000);

    const run = (q: string): string => sqlcmd("-d", accessDb, "-h", "-1", "-W", "-Q", `SET NOCOUNT ON; ${q}`).trim();
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

    const ensureWriter = (): void => {
      run("IF DATABASE_PRINCIPAL_ID('t_writer') IS NULL BEGIN CREATE USER t_writer WITHOUT LOGIN; ALTER ROLE portal_writer ADD MEMBER t_writer; END");
    };
    const acquireDirectoryLock = async (transaction: sql.Transaction, timeout = 0): Promise<number> => {
      const result = await transaction.request()
        .input("timeout", sql.Int, timeout)
        .query<{ result: number }>(`
          DECLARE @result INT;
          EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
            @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @timeout;
          SELECT @result AS result`);
      return result.recordset[0]!.result;
    };
    const conflictAsWriter = async (
      transaction: sql.Transaction,
      tenant: string,
      objectId: string,
      role: string,
      scope: string,
      scopeValue: string,
    ) => transaction.request()
      .input("tenant", sql.UniqueIdentifier, tenant)
      .input("objectId", sql.UniqueIdentifier, objectId)
      .input("role", sql.VarChar(sql.MAX), role)
      .input("scope", sql.VarChar(sql.MAX), scope)
      .input("scopeValue", sql.NVarChar(sql.MAX), scopeValue)
      .query<{ has_conflict: boolean | null }>(`
        DECLARE @has_conflict BIT = NULL;
        EXECUTE AS USER = N't_writer';
        BEGIN TRY
          EXEC portal.usp_has_revoked_grant_conflict
            @entra_tenant_id = @tenant,
            @entra_object_id = @objectId,
            @role = @role,
            @scope = @scope,
            @scope_value = @scopeValue,
            @has_conflict = @has_conflict OUTPUT;
          REVERT;
        END TRY
        BEGIN CATCH
          REVERT;
          THROW;
        END CATCH;
        SELECT @has_conflict AS has_conflict`);

    it("reports only exact revoked grant conflicts in the caller's locked transaction", async () => {
      ensureWriter();
      const O10 = "aaaaaaaa-0000-0000-0000-000000000010";
      const pid = principal(O10, 1010);
      run(grant(pid, O10, "executive", "department", "dept-10"));
      run(`UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = '${pid}'`);

      const pool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        expect(await acquireDirectoryLock(transaction)).toBeGreaterThanOrEqual(0);

        const exact = await conflictAsWriter(transaction, T, O10, "executive", "department", "dept-10");
        expect(exact.recordsets).toHaveLength(1);
        expect(exact.recordset).toEqual([{ has_conflict: true }]);
        expect(Object.keys(exact.recordset[0]!)).toEqual(["has_conflict"]);

        expect((await conflictAsWriter(transaction, "22222222-2222-2222-2222-222222222222", O10, "executive", "department", "dept-10")).recordset[0]?.has_conflict).toBe(false);
        expect((await conflictAsWriter(transaction, T, "aaaaaaaa-0000-0000-0000-000000000011", "executive", "department", "dept-10")).recordset[0]?.has_conflict).toBe(false);
        expect((await conflictAsWriter(transaction, T, O10, "admin", "department", "dept-10")).recordset[0]?.has_conflict).toBe(false);
        expect((await conflictAsWriter(transaction, T, O10, "executive", "business_area", "dept-10")).recordset[0]?.has_conflict).toBe(false);
        expect((await conflictAsWriter(transaction, T, O10, "executive", "department", "dept-11")).recordset[0]?.has_conflict).toBe(false);
        const textMismatches: [string, string, string][] = [
          ["EXECUTIVE", "department", "dept-10"],
          ["executive ", "department", "dept-10"],
          ["executive", "DEPARTMENT", "dept-10"],
          ["executive", "department ", "dept-10"],
          ["executive", "department", "DEPT-10"],
          ["executive", "department", "dept-10 "],
        ];
        for (const [role, scope, scopeValue] of textMismatches) {
          expect((await conflictAsWriter(transaction, T, O10, role, scope, scopeValue)).recordset[0]?.has_conflict).toBe(false);
        }

        const transactionState = await transaction.request().query<{ count: number; lock_mode: string }>(`
          SELECT @@TRANCOUNT AS count, APPLOCK_MODE(N'public', N'ingest:directory', N'Transaction') AS lock_mode`);
        expect(transactionState.recordset[0]).toEqual({ count: 1, lock_mode: "Exclusive" });
      } finally {
        await transaction.rollback();
        await pool.close();
      }
    });

    it("rejects overlength inputs instead of truncating into a max-width revoked match", async () => {
      ensureWriter();
      const objectId = "aaaaaaaa-0000-0000-0000-000000000017";
      const pid = principal(objectId, 1017);
      const maxValue = "v".repeat(128);
      run(grant(pid, objectId, "executive", "department", maxValue));
      run(`UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = '${pid}'`);

      const pool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        expect(await acquireDirectoryLock(transaction)).toBeGreaterThanOrEqual(0);
        expect((await conflictAsWriter(transaction, T, objectId, "executive", "department", maxValue)).recordset)
          .toEqual([{ has_conflict: true }]);
        for (const suffix of ["x", " "]) {
          await expect(conflictAsWriter(transaction, T, objectId, "executive", "department", maxValue + suffix))
            .rejects.toThrow(/inputs exceed.*bounds/i);
        }
        await expect(conflictAsWriter(transaction, T, objectId, "executive".padEnd(13), "department", maxValue))
          .rejects.toThrow(/inputs exceed.*bounds/i);
        await expect(conflictAsWriter(transaction, T, objectId, "executive", "department".padEnd(17), maxValue))
          .rejects.toThrow(/inputs exceed.*bounds/i);
        const state = await transaction.request().query<{ count: number; lock_mode: string }>(`
          SELECT @@TRANCOUNT AS count, APPLOCK_MODE(N'public', N'ingest:directory', N'Transaction') AS lock_mode`);
        expect(state.recordset[0]).toEqual({ count: 1, lock_mode: "Exclusive" });
      } finally {
        await transaction.rollback();
        await pool.close();
      }
    });

    it("distinguishes effective, revoked, and never-seen grants without exposing authorization", async () => {
      ensureWriter();
      const activeOid = "aaaaaaaa-0000-0000-0000-000000000012";
      const revokedOid = "aaaaaaaa-0000-0000-0000-000000000013";
      const unseenOid = "aaaaaaaa-0000-0000-0000-000000000014";
      const activePid = principal(activeOid, 1012);
      const revokedPid = principal(revokedOid, 1013);
      const unseenPid = principal(unseenOid, 1014);
      run(grant(activePid, activeOid, "user", "self"));
      run(grant(revokedPid, revokedOid, "manager", "team"));
      run(`UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = '${revokedPid}'`);

      const pool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        expect(await acquireDirectoryLock(transaction)).toBeGreaterThanOrEqual(0);
        const outcome = async (principalId: string, objectId: string, role: string, scope: string): Promise<string> => {
          const visible = run(`SELECT COUNT(*) FROM portal.v_active_grant WHERE principal_id = '${principalId}'`);
          if (visible !== "0") return "idempotent_noop";
          const conflict = await conflictAsWriter(transaction, T, objectId, role, scope, "");
          return conflict.recordset[0]?.has_conflict ? "denied" : "eligible_for_create";
        };

        expect(await outcome(activePid, activeOid, "user", "self")).toBe("idempotent_noop");
        expect(await outcome(revokedPid, revokedOid, "manager", "team")).toBe("denied");
        expect(await outcome(unseenPid, unseenOid, "user", "self")).toBe("eligible_for_create");
      } finally {
        await transaction.rollback();
        await pool.close();
      }
    });

    it("fails closed without the caller transaction or directory lock", async () => {
      ensureWriter();
      const O15 = "aaaaaaaa-0000-0000-0000-000000000015";
      const values = `@entra_tenant_id = '${T}', @entra_object_id = '${O15}', @role = 'user', @scope = 'self', @scope_value = N'', @has_conflict = @has_conflict OUTPUT`;
      fails(`DECLARE @has_conflict BIT; EXEC portal.usp_has_revoked_grant_conflict ${values}`, /caller transaction/i);

      const pool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        await expect(conflictAsWriter(transaction, T, O15, "user", "self", "")).rejects.toThrow(/ingest:directory/i);
        expect(await acquireDirectoryLock(transaction)).toBeGreaterThanOrEqual(0);
        expect((await conflictAsWriter(transaction, T, O15, "user", "self", "")).recordset[0]?.has_conflict).toBe(false);
        const state = await transaction.request().query<{ count: number }>("SELECT @@TRANCOUNT AS count");
        expect(state.recordset[0]?.count).toBe(1);
      } finally {
        await transaction.rollback();
        await pool.close();
      }
    });

    it.each([
      ["READ UNCOMMITTED", sql.ISOLATION_LEVEL.READ_UNCOMMITTED],
      ["READ COMMITTED", sql.ISOLATION_LEVEL.READ_COMMITTED],
      ["REPEATABLE READ", sql.ISOLATION_LEVEL.REPEATABLE_READ],
    ] as const)("rejects caller %s isolation even with the directory lock", async (_label, isolation) => {
      ensureWriter();
      const pool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const transaction = new sql.Transaction(pool);
      await transaction.begin(isolation);
      try {
        expect(await acquireDirectoryLock(transaction)).toBeGreaterThanOrEqual(0);
        await expect(conflictAsWriter(transaction, T, O1, "user", "self", "")).rejects.toThrow(/SERIALIZABLE isolation/i);
        const state = await transaction.request().query<{ count: number; isolation: number; lock_mode: string }>(`
          SELECT @@TRANCOUNT AS count, transaction_isolation_level AS isolation,
            APPLOCK_MODE(N'public', N'ingest:directory', N'Transaction') AS lock_mode
          FROM sys.dm_exec_sessions WHERE session_id = @@SPID`);
        expect(state.recordset[0]).toEqual({ count: 1, isolation, lock_mode: "Exclusive" });
      } finally {
        await transaction.rollback();
        await pool.close();
      }
    });

    it("serializes the bounded contract with a directory lifecycle transaction", async () => {
      ensureWriter();
      const O16 = "aaaaaaaa-0000-0000-0000-000000000016";
      const pid = principal(O16, 1016);
      run(grant(pid, O16, "manager", "team"));
      run(`UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = '${pid}'`);

      const firstPool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const secondPool = await new sql.ConnectionPool(cs(accessDb)).connect();
      const caller = new sql.Transaction(firstPool);
      const directory = new sql.Transaction(secondPool);
      let callerActive = false;
      let directoryActive = false;
      try {
        await caller.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        callerActive = true;
        await directory.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        directoryActive = true;
        expect(await acquireDirectoryLock(caller)).toBeGreaterThanOrEqual(0);
        expect((await conflictAsWriter(caller, T, O16, "manager", "team", "")).recordset[0]?.has_conflict).toBe(true);
        expect(await acquireDirectoryLock(directory)).toBeLessThan(0);

        await caller.commit();
        callerActive = false;
        expect(await acquireDirectoryLock(directory)).toBeGreaterThanOrEqual(0);
        await directory.request()
          .input("tenant", sql.UniqueIdentifier, T)
          .input("objectId", sql.UniqueIdentifier, O16)
          .query(`
            INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id)
            VALUES (@tenant, @objectId, 1016);
            UPDATE portal.PrincipalLinkState
            SET unlinked_at = SYSUTCDATETIME(), unlink_seq = NEXT VALUE FOR portal.seq_access_event,
                unlink_reason = 'entra_disabled'
            WHERE entra_tenant_id = @tenant AND entra_object_id = @objectId`);
        await directory.commit();
        directoryActive = false;
        expect(run(`SELECT COUNT(*) FROM portal.PrincipalLinkState WHERE entra_tenant_id = '${T}' AND entra_object_id = '${O16}' AND unlinked_at IS NOT NULL`)).toBe("1");
      } finally {
        try {
          if (callerActive) await caller.rollback();
        } finally {
          try {
            if (directoryActive) await directory.rollback();
          } finally {
            await Promise.all([firstPool.close(), secondPool.close()]);
          }
        }
      }
    });

    it("grants only the bounded contract's EXECUTE permission to portal_writer", () => {
      ensureWriter();
      run("IF DATABASE_PRINCIPAL_ID('t_reader') IS NULL BEGIN CREATE USER t_reader WITHOUT LOGIN; ALTER ROLE portal_reader ADD MEMBER t_reader; END");
      run("IF DATABASE_PRINCIPAL_ID('t_ingest') IS NULL BEGIN CREATE USER t_ingest WITHOUT LOGIN; ALTER ROLE portal_ingest ADD MEMBER t_ingest; END");
      const canExecute = (user: string): string =>
        run(`EXECUTE AS USER = '${user}'; SELECT HAS_PERMS_BY_NAME(N'portal.usp_has_revoked_grant_conflict', N'OBJECT', N'EXECUTE'); REVERT`);

      expect(canExecute("t_writer")).toBe("1");
      expect(canExecute("t_reader")).toBe("0");
      expect(canExecute("t_ingest")).toBe("0");
      const call = `DECLARE @result BIT; EXEC portal.usp_has_revoked_grant_conflict
        @entra_tenant_id = '${T}', @entra_object_id = '${O1}', @role = 'user', @scope = 'self',
        @scope_value = N'', @has_conflict = @result OUTPUT`;
      asUserFails("t_reader", call);
      asUserFails("t_ingest", call);
      expect(() => asUser("t_reader", "SELECT COUNT(*) FROM portal.v_active_grant")).not.toThrow();
      asUserFails("t_ingest", "SELECT COUNT(*) FROM portal.AccessGrant");
    });

    it("enforces runtime permissions: ingestion cannot read grants, writer cannot rewrite a grant", () => {
      run("IF DATABASE_PRINCIPAL_ID('t_ingest') IS NULL BEGIN CREATE USER t_ingest WITHOUT LOGIN; ALTER ROLE portal_ingest ADD MEMBER t_ingest; END");
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

    it("preserves legacy ingestion user writes until the procedure consumer merges", () => {
      expect(() => asUser("t_ingest", `
        BEGIN TRANSACTION;
        INSERT INTO portal.dim_user (user_id, login) VALUES (3005, N'legacy-observation');
        UPDATE portal.dim_user SET login = N'legacy-updated' WHERE user_id = 3005;
        IF NOT EXISTS (SELECT 1 FROM portal.dim_user WHERE user_id = 3005 AND login = N'legacy-updated')
          THROW 50146, N'The contract broke the legacy metrics user writer', 1;
        ROLLBACK TRANSACTION;
      `)).not.toThrow();
    });

    it("reapplies the component ingestion migration without changing its permission catalog", () => {
      const migration = "20261027095703.do.component-ingestion-user-write.sql";
      const batches = splitBatches(readFileSync(join(realMigrations, migration), "utf8"));
      const permissions = (): string => run(`
        SELECT COUNT(*) FROM sys.database_permissions
        WHERE grantee_principal_id IN (
          DATABASE_PRINCIPAL_ID(N'portal_metrics_ingest'),
          DATABASE_PRINCIPAL_ID(N'portal_directory_ingest'),
          DATABASE_PRINCIPAL_ID(N'portal_ingest')
        )
      `);
      const before = permissions();
      for (const batch of batches) sqlcmd("-d", accessDb, "-Q", batch);
      expect(permissions()).toBe(before);
    });

    it("enforces the component-scoped metrics and directory ingestion contract", async () => {
      await assertComponentIngestionPermissions({
        execute: async (statement) => { run(statement); },
        expectDenied: async (statement) => {
          fails(statement, /permission (?:was )?denied|do not have permission|permission denied/i);
        },
        expectError: async (statement, message) => { fails(statement, message); },
      });
    }, 60_000);

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

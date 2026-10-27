// Applies db/migrations through the migration runner on a SQL Server 2022 container. Run with RUN_SQL_TESTS=1 (needs Docker).
// Slow under emulation on Apple Silicon (linux/amd64). Uses a throwaway container with a random password and never a real server.
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
      for (const batch of batches) run(batch);
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

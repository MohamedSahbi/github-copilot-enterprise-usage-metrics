import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContainerClient, newPipeline } from "@azure/storage-blob";
import sql from "mssql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryUserSchema } from "../../shared/src/directory-input";
import { createDirectorySqlWriter } from "../../functions/src/directory/sql-writer";
import type { DirectoryCommit } from "../../functions/src/directory/sync";
import { dailyTable, loadMetricsDay } from "../../functions/src/metrics/day-loader";
import { parseMetricsDay } from "../../functions/src/metrics/day-parser";
import { createMetricsRunStore } from "../../functions/src/metrics/run-store";
import { migrate } from "../db/migrate";
import { splitBatches } from "../db/split-go";

const image = "mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718";
const owner = process.env.COMPONENT_GRANTS_OWNER ?? randomBytes(8).toString("hex");
const containerName = `portal-component-grants-${process.pid}-${owner}`;
const database = "portal_component_grants";
const password = `Aa1!${randomBytes(24).toString("hex")}`;
const migrationFile = join(__dirname, "../../db/migrations/20261026003000.do.component-ingestion-roles.sql");
let containerId: string | undefined;
let port = 0;
const poolTargets = new WeakMap<sql.ConnectionPool, sql.config>();

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

function guard(config: sql.config): void {
  if (!containerId || config.server !== "127.0.0.1" || config.port !== port ||
      port < 1024 || port > 65535 || [10000, 10001, 10002, 14330, 14501, 14504].includes(port) ||
      !["master", database].includes(config.database ?? "")) {
    throw new Error("component_grants_connection_not_isolated");
  }
  const identity = docker("inspect", "--format",
    '{{.Id}} {{index .Config.Labels "portal.component-grants-owner"}} {{index .Config.Labels "portal.component-grants-pid"}}',
    containerId).trim();
  if (identity !== `${containerId} ${owner} ${process.pid}`) throw new Error("component_grants_container_owner_mismatch");
}

function config(user = "sa", db = database): sql.config {
  const result: sql.config = {
    server: "127.0.0.1", port, database: db, user, password,
    options: { encrypt: true, trustServerCertificate: true },
    pool: { min: 0, max: 1 }, requestTimeout: 30_000,
  };
  guard(result);
  return result;
}

async function query(text: string, user = "sa", db = database) {
  const pool = await connect(config(user, db));
  try {
    guardPool(pool);
    return await pool.request().query(text);
  } finally {
    await pool.close();
  }
}

async function connect(target: sql.config): Promise<sql.ConnectionPool> {
  guard(target);
  const pool = await new sql.ConnectionPool(target).connect();
  poolTargets.set(pool, target);
  return pool;
}

function guardPool(pool: sql.ConnectionPool): void {
  const target = poolTargets.get(pool);
  if (!target) throw new Error("unowned_component_grants_pool");
  guard(target);
}

async function rolePool(user: "directory_fixture" | "metrics_fixture" | "reader_fixture"): Promise<sql.ConnectionPool> {
  return connect(config(user));
}

function directoryCommand(userId: number, startedAt: string): DirectoryCommit {
  return {
    run: {
      run_id: randomUUID(), source_kind: "directory", scope_key: "fixture-enterprise",
      report_day: null, range_start: null, range_end: null, status: "published", is_current: false,
      transform_version: "1", attempt: 1, rows_read: 1, rows_loaded: 1, rows_quarantined: 0,
      error_code: null, correlation_id: randomUUID(), started_at: startedAt, completed_at: startedAt,
    },
    users: [{ user: DirectoryUserSchema.parse({
      user_id: userId, login: "fixture-user", entra_object_id: "00000000-0000-4000-8000-000000000072",
      entra_account_enabled: true, state: "active", department: "fixture-department",
    }), managerResolved: true, errorCode: null }],
    managerCheckUserIds: [userId],
    sync: [{ source: "graph", last_success_at: startedAt, last_attempt_at: startedAt, last_error_code: null }],
  };
}

function metricsContent(ids: number[]): Uint8Array {
  return Buffer.from(ids.map((user_id) => JSON.stringify({
    day: "2026-03-02", organization_id: 72, user_id, user_login: `fixture-${user_id}`,
    user_initiated_interaction_count: 2, code_generation_activity_count: 1,
    code_acceptance_activity_count: 0, loc_suggested_to_add_sum: 3,
    loc_suggested_to_delete_sum: 0, loc_added_sum: 1, loc_deleted_sum: 0,
    totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 1 }],
    totals_by_cli: { session_count: 1, request_count: 1, token_usage: { prompt_tokens_sum: 1, output_tokens_sum: 1 } },
    totals_by_skill: [{ skill: "fixture-skill", interaction_count: 1 }],
  })).join("\n") + "\n");
}

describe.skipIf(process.env.RUN_SQL_TESTS !== "1")("component runtime grants (isolated SQL Server)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    console.info(`component_test_node_exec_path=${process.execPath} component_test_node_version=${process.version} component_test_argv=${JSON.stringify(process.argv)}`);
    expect(spawnSync("docker", ["info"], { stdio: "ignore" }).status).toBe(0);
    if (!/^[a-f0-9]{16}$/.test(owner)) throw new Error("invalid_component_grants_owner");
    if (docker("ps", "-aq", "--filter", `name=^/${containerName}$`).trim() !== "") {
      throw new Error("refusing_existing_component_container");
    }
    if (process.env.COMPONENT_GRANTS_MANIFEST) {
      writeFileSync(process.env.COMPONENT_GRANTS_MANIFEST, JSON.stringify({ owner, containerName, testPid: process.pid }), { flag: "wx", mode: 0o600 });
    }
    // Password is inherited by Docker, never placed in command arguments or printed.
    containerId = execFileSync("docker", [
      "run", "-d", "--rm", "--platform", "linux/amd64", "--name", containerName,
      "--label", `portal.component-grants-owner=${owner}`, "--label", `portal.component-grants-pid=${process.pid}`,
      "-p", "127.0.0.1::1433", "-e", "ACCEPT_EULA=Y", "-e", "MSSQL_SA_PASSWORD", image,
    ], { encoding: "utf8", env: { ...process.env, MSSQL_SA_PASSWORD: password } }).trim();
    const binding = docker("port", containerId, "1433/tcp").trim();
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!portMatch) throw new Error("component_grants_container_not_loopback_bound");
    port = Number(portMatch[1]);
    guard({ server: "127.0.0.1", port, database });
    if (process.env.COMPONENT_GRANTS_MANIFEST) {
      writeFileSync(process.env.COMPONENT_GRANTS_MANIFEST, JSON.stringify({ owner, containerName, testPid: process.pid, containerId, port }), { mode: 0o600 });
    }
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        await query("SELECT 1 AS ready", "sa", "master");
        ready = true;
        break;
      } catch (error) {
        if (!(error instanceof sql.ConnectionError)) throw error;
        if (attempt === 89) throw error;
        await delay(2_000);
      }
    }
    expect(ready).toBe(true);
    for (const user of ["directory_fixture", "metrics_fixture", "reader_fixture"]) {
      await query(`CREATE LOGIN [${user}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`, "sa", "master");
    }
  }, 240_000);

  beforeEach(async () => {
    await query(`IF DB_ID('${database}') IS NOT NULL
      BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END;
      CREATE DATABASE [${database}]`, "sa", "master");
    // The migration runner is pinned to this guarded local container/database.
    const local = config();
    const connectionString = `Server=${local.server},${local.port};Database=${database};User Id=sa;Password=${password};Encrypt=true;TrustServerCertificate=true`;
    await migrate({ connectionString });
    expect((await migrate({ connectionString })).applied).toEqual([]);
    for (const [user, role] of [
      ["directory_fixture", "portal_directory_ingest"], ["metrics_fixture", "portal_metrics_ingest"],
      ["reader_fixture", "portal_reader"],
    ] as const) {
      await query(`CREATE USER [${user}] FOR LOGIN [${user}]; ALTER ROLE [${role}] ADD MEMBER [${user}]`);
    }
    await query("INSERT INTO portal.dim_user (user_id, login) VALUES (7299, 'fixture-shared')");
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (containerId) {
      const identity = spawnSync("docker", ["inspect", "--format",
        '{{.Id}} {{index .Config.Labels "portal.component-grants-owner"}} {{index .Config.Labels "portal.component-grants-pid"}}',
        containerId], { encoding: "utf8" });
      if (identity.status === 0) {
        if (identity.stdout.trim() !== `${containerId} ${owner} ${process.pid}`) throw new Error("refusing_unowned_container_cleanup");
        const removed = spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
        if (removed.status !== 0) throw new Error("component_grants_container_cleanup_failed");
      } else if (docker("ps", "-aq", "--filter", `name=^/${containerName}$`).trim() !== "") {
        throw new Error("component_grants_container_inspection_failed");
      }
      const remaining = spawnSync("docker", ["ps", "-aq", "--no-trunc", "--filter", `id=${containerId}`], { encoding: "utf8" });
      if (remaining.status !== 0 || remaining.stdout.trim() !== "") {
        throw new Error("component_grants_container_still_present");
      }
    }
    if (port > 0) {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
      });
    }
  });

  it("reruns the actual forward grant migration without permission changes or broad role inheritance", async () => {
    const permissions = async () => (await query(`
      SELECT r.name, p.class, p.major_id, p.minor_id, p.permission_name, p.state
      FROM sys.database_permissions p JOIN sys.database_principals r ON r.principal_id = p.grantee_principal_id
      WHERE r.name IN ('portal_directory_ingest', 'portal_metrics_ingest')
      ORDER BY r.name, p.class, p.major_id, p.minor_id, p.permission_name`)).recordset;
    const before = await permissions();
    expect(before.length).toBeGreaterThan(0);
    for (const batch of splitBatches(readFileSync(migrationFile, "utf8"))) await query(batch);
    expect(await permissions()).toEqual(before);
    expect((await query(`
      SELECT parent.name FROM sys.database_role_members m
      JOIN sys.database_principals child ON child.principal_id = m.member_principal_id
      JOIN sys.database_principals parent ON parent.principal_id = m.role_principal_id
      WHERE child.name IN ('portal_directory_ingest', 'portal_metrics_ingest')`)).recordset).toEqual([]);
    for (const user of ["directory_fixture", "metrics_fixture"]) {
      expect((await query("SELECT IS_ROLEMEMBER('portal_ingest') AS broad, IS_ROLEMEMBER('db_owner') AS owner", user)).recordset)
        .toEqual([{ broad: 0, owner: 0 }]);
    }
  });

  it("fails closed if an existing non-role principal occupies a component role name", async () => {
    await query(`
      ALTER ROLE portal_directory_ingest DROP MEMBER directory_fixture;
      DROP ROLE portal_directory_ingest;
      CREATE USER portal_directory_ingest WITHOUT LOGIN`);
    const permissions = async () => (await query(`
      SELECT class, major_id, minor_id, permission_name, state FROM sys.database_permissions
      WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID('portal_directory_ingest')
      ORDER BY class, major_id, minor_id, permission_name`)).recordset;
    const baseline = await permissions();
    expect(baseline).toEqual([{ class: 0, major_id: 0, minor_id: 0, permission_name: "CONNECT", state: "G" }]);
    const createRoles = splitBatches(readFileSync(migrationFile, "utf8"))[0];
    if (!createRoles) throw new Error("missing_component_role_batch");
    await expect(query(createRoles)).rejects.toThrow("COMPONENT_INGESTION_ROLE_NAME_CONFLICT");
    expect(await permissions()).toEqual(baseline);
    expect((await query(`
      SELECT role_principal_id FROM sys.database_role_members
      WHERE member_principal_id = DATABASE_PRINCIPAL_ID('portal_directory_ingest')`)).recordset).toEqual([]);
  });

  it("runs the real directory transaction and updates while rejecting stale snapshots atomically", async () => {
    const pool = await rolePool("directory_fixture");
    try {
      guardPool(pool);
      const writer = createDirectorySqlWriter(() => new sql.Transaction(pool));
      const first = directoryCommand(7201, "2026-10-26T10:00:00.000Z");
      await writer.commit(first);
      await writer.commit(directoryCommand(7201, "2026-10-26T10:00:01.000Z"));
      const stale = directoryCommand(7201, "2026-10-26T10:00:01.000Z");
      await expect(writer.commit(stale)).rejects.toThrow("directory_write_failed");
      expect((await query(`SELECT run_id FROM portal.IngestionRun WHERE run_id = '${stale.run.run_id}'`)).recordset).toEqual([]);
      expect((await query("SELECT department FROM portal.dim_user WHERE user_id = 7201", "directory_fixture")).recordset)
        .toEqual([{ department: "fixture-department" }]);
      expect((await query("SELECT source FROM portal.DirectorySyncState", "directory_fixture")).recordset)
        .toEqual([{ source: "graph" }]);
    } finally {
      await pool.close();
    }
  });

  it("permits public-principal locks, rejects concurrent directory writes, and releases session locks", async () => {
    const firstPool = await rolePool("directory_fixture");
    const secondPool = await rolePool("directory_fixture");
    const transaction = new sql.Transaction(firstPool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      guardPool(firstPool);
      const held = await transaction.request().query<{ result: number }>(`
        DECLARE @result int;
        EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
          @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
        SELECT @result AS result`);
      expect(held.recordset[0]?.result).toBeGreaterThanOrEqual(0);
      const command = directoryCommand(7201, "2026-10-26T11:00:00.000Z");
      guardPool(secondPool);
      await expect(createDirectorySqlWriter(() => new sql.Transaction(secondPool)).commit(command))
        .rejects.toThrow("directory_write_failed");
      expect((await query(`SELECT run_id FROM portal.IngestionRun WHERE run_id = '${command.run.run_id}'`)).recordset).toEqual([]);
    } finally {
      await transaction.rollback();
      await firstPool.close();
      await secondPool.close();
    }
    const metricsPool = await rolePool("metrics_fixture");
    try {
      guardPool(metricsPool);
      const held = await metricsPool.request().query<{ mode: string }>(`
        DECLARE @result int;
        EXEC @result = sys.sp_getapplock @Resource = N'ingest:users_1_day:72:2026-03-02',
          @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
        SELECT APPLOCK_MODE('public', N'ingest:users_1_day:72:2026-03-02', 'Session') AS mode`);
      expect(held.recordset).toEqual([{ mode: "Exclusive" }]);
      guardPool(metricsPool);
      const released = await metricsPool.request().query<{ mode: string }>(`
        EXEC sys.sp_releaseapplock @Resource = N'ingest:users_1_day:72:2026-03-02', @LockOwner = 'Session';
        SELECT APPLOCK_MODE('public', N'ingest:users_1_day:72:2026-03-02', 'Session') AS mode`);
      expect(released.recordset).toEqual([{ mode: "NoLock" }]);
    } finally {
      await metricsPool.close();
    }
  });

  it("permits the actual metrics loader and scoped run-store API operations", async () => {
    const transportRequests: string[] = [];
    const container = new ContainerClient("https://fixture.invalid/raw", newPipeline(undefined, {
      httpClient: {
        async sendRequest(request) {
          const endpoint = new URL(request.url);
          if (endpoint.origin !== "https://fixture.invalid" || request.method !== "PUT" ||
              !endpoint.pathname.startsWith("/raw/raw/users_1_day/fixture-org/2026/03/02/")) {
            throw new Error("unexpected_component_blob_transport_request");
          }
          transportRequests.push(request.url);
          const headers = request.headers.clone();
          headers.set("etag", "fixture");
          return { request, status: 201, headers };
        },
      },
    }));
    const block = container.getBlockBlobClient("raw/users_1_day/fixture-org/2026/03/02/fixture.ndjson");
    const upload = vi.spyOn(block, "uploadData");
    const getBlob = vi.spyOn(container, "getBlockBlobClient").mockReturnValue(block);
    const logger = { info: vi.fn(), error: vi.fn() };
    const runs: string[] = [];
    const metricsRunStore = createMetricsRunStore(config("metrics_fixture"));
    try {
      expect(await metricsRunStore.isComplete(72, "2026-03-02")).toBe(false);
      const load = async (ids: number[]) => {
        const runId = randomUUID();
        runs.push(runId);
        const sqlConfig = config("metrics_fixture");
        guard(sqlConfig);
        return loadMetricsDay({
          reportDay: "2026-03-02", organizationId: 72, organizationLogin: "fixture-org",
          content: metricsContent(ids), runId, correlationId: randomUUID(),
        }, { sqlConfig, blobContainer: container, logger });
      };
      const first = await load([7202, 7203]);
      expect(first.status).toBe("published");
      expect(await metricsRunStore.isComplete(72, "2026-03-02")).toBe(true);
      expect((await load([7202, 7203])).status).toBe("published");
      expect((await load([7202])).status).toBe("quarantined");
      expect(await metricsRunStore.isComplete(72, "2026-03-02")).toBe(true);
      expect(upload).toHaveBeenCalledTimes(3);
      expect(transportRequests).toHaveLength(3);
      expect(getBlob.mock.calls).toEqual(runs.map((id) => [`raw/users_1_day/fixture-org/2026/03/02/${id}.ndjson`]));
      const failureRunId = randomUUID();
      const failureCorrelationId = randomUUID();
      expect(await metricsRunStore.isComplete(72, "2026-03-03")).toBe(false);
      await metricsRunStore.recordFailure({
        runId: failureRunId,
        correlationId: failureCorrelationId,
        organizationId: 72,
        organizationLogin: "fixture-org",
        reportDay: "2026-03-03",
        errorCode: "request_failed",
      });
      const persistedFailurePool = await connect(config());
      try {
        guardPool(persistedFailurePool);
        const persistedFailure = await persistedFailurePool.request()
          .input("runId", sql.UniqueIdentifier, failureRunId)
          .query<{
            source_kind: string;
            scope_key: string;
            report_day: string;
            status: string;
            is_current: boolean;
            error_code: string;
            correlation_id: string;
            rows_read: number | null;
            rows_loaded: number | null;
            rows_quarantined: number | null;
          }>(`
        SELECT source_kind, scope_key, CONVERT(varchar(10), report_day, 23) AS report_day,
          status, is_current, error_code, correlation_id, rows_read, rows_loaded, rows_quarantined
        FROM portal.IngestionRun WHERE run_id = @runId`);
        expect(persistedFailure.recordset).toEqual([{
          source_kind: "users_1_day", scope_key: "72", report_day: "2026-03-03",
          status: "failed", is_current: false, error_code: "request_failed",
          correlation_id: failureCorrelationId, rows_read: null, rows_loaded: null, rows_quarantined: null,
        }]);
      } finally {
        await persistedFailurePool.close();
      }
      expect(await metricsRunStore.isComplete(72, "2026-03-03")).toBe(false);

      const deniedFailureRunId = randomUUID();
      const readerRunStore = createMetricsRunStore(config("reader_fixture"));
      await expect(readerRunStore.recordFailure({
        runId: deniedFailureRunId,
        correlationId: randomUUID(),
        organizationId: 72,
        organizationLogin: "fixture-org",
        reportDay: "2026-03-03",
        errorCode: "request_failed",
      })).rejects.toMatchObject({ number: 229 });
      const deniedFailurePool = await connect(config());
      try {
        guardPool(deniedFailurePool);
        const deniedFailure = await deniedFailurePool.request()
          .input("runId", sql.UniqueIdentifier, deniedFailureRunId)
          .query("SELECT run_id FROM portal.IngestionRun WHERE run_id = @runId");
        expect(deniedFailure.recordset).toEqual([]);
      } finally {
        await deniedFailurePool.close();
      }
      for (const table of ["fact_usage_breakdown", "fact_usage_family_count"]) {
        expect((await query(`SELECT COUNT(*) AS count FROM portal.${table} WHERE run_id = '${runs[0]}'`)).recordset)
          .toEqual([{ count: 0 }]);
        expect(Number((await query(`SELECT COUNT(*) AS count FROM portal.${table} WHERE run_id = '${runs[1]}'`)).recordset[0]?.count))
          .toBeGreaterThan(0);
      }
      expect((await query("SELECT login FROM portal.dim_organization WHERE organization_id = 72", "metrics_fixture")).recordset)
        .toEqual([{ login: "fixture-org" }]);
      expect(Number((await query("SELECT COUNT(*) AS count FROM portal.dim_user_login_history", "metrics_fixture")).recordset[0]?.count))
        .toBeGreaterThan(0);
      const invalid = parseMetricsDay(Buffer.from(metricsContent([7204])).toString("utf8"), {
        runId: first.runId, artifactId: first.artifactId, reportDay: "2026-03-02", organizationId: 72,
      }).rows[0]?.daily;
      if (!invalid) throw new Error("invalid_component_bulk_fixture");
      invalid.line_number = 999;
      invalid.interaction_count = -1;
      const pool = await rolePool("metrics_fixture");
      try {
        guardPool(pool);
        await expect(pool.request().bulk(dailyTable([invalid]), { checkConstraints: true, fireTriggers: true }))
          .rejects.toThrow(/CHECK constraint/i);
        expect((await query("SELECT user_id FROM portal.stg_user_daily WHERE user_id = 7204", "metrics_fixture")).recordset)
          .toEqual([]);
      } finally {
        await pool.close();
      }
    } finally {
      getBlob.mockRestore();
      upload.mockRestore();
    }
  }, 60_000);

  it.each(["directory_fixture", "metrics_fixture"] as const)("denies %s access data, append-only mutation, run deletion and DDL", async (user) => {
    for (const table of ["Principal", "PrincipalIdentity", "AccessGrant", "PrincipalLinkState",
      "FeedbackItem", "FeedbackVote", "FeedbackComment", "AuditLog", "IngestionAuditEvent", "GrantRevocation", "IssueAction"]) {
      await expect(query(`SELECT * FROM portal.${table}`, user)).rejects.toMatchObject({ number: 229 });
    }
    for (const table of ["IngestionAuditEvent", "GrantRevocation", "IssueAction", "IngestionRun"]) {
      await expect(query(`DELETE FROM portal.${table} WHERE 1 = 0`, user)).rejects.toMatchObject({ number: 229 });
    }
    for (const [table, column] of [["IngestionAuditEvent", "action"], ["GrantRevocation", "reason"], ["IssueAction", "action"]]) {
      await expect(query(`UPDATE portal.${table} SET ${column} = ${column} WHERE 1 = 0`, user))
        .rejects.toMatchObject({ number: 229 });
    }
    await expect(query("CREATE TABLE portal.forbidden_runtime_table (id int)", user)).rejects.toThrow(/permission/i);
    await expect(query("ALTER TABLE portal.dim_user ADD forbidden_runtime_column int", user)).rejects.toThrow(/permission/i);
    await expect(query("EXEC portal.usp_purge_login_history @max_age_months = 24", user)).rejects.toMatchObject({ number: 229 });
  });

  it("denies directory metrics/history access and first/last-seen changes, while keeping run INSERT-only", async () => {
    for (const table of ["stg_user_daily", "fact_user_daily_usage", "dim_user_login_history", "dim_organization", "SourceArtifact"]) {
      await expect(query(`SELECT * FROM portal.${table}`, "directory_fixture")).rejects.toMatchObject({ number: 229 });
    }
    for (const column of ["first_seen_day", "last_seen_day", "pii_purged_at"]) {
      await expect(query(`UPDATE portal.dim_user SET ${column} = NULL WHERE user_id = 7201`, "directory_fixture"))
        .rejects.toMatchObject({ number: 230 });
    }
    await expect(query("UPDATE portal.IngestionRun SET status = 'failed' WHERE 1 = 0", "directory_fixture"))
      .rejects.toMatchObject({ number: 229 });
    await expect(query("SELECT * FROM portal.IngestionRun", "directory_fixture")).rejects.toMatchObject({ number: 229 });
    await expect(createMetricsRunStore(config("directory_fixture")).isComplete(72, "2026-03-02"))
      .rejects.toMatchObject({ number: 229 });
    await expect(query("DELETE FROM portal.dim_user WHERE user_id = 7201", "directory_fixture")).rejects.toMatchObject({ number: 229 });
  });

  it("denies metrics directory attributes/state and artifact mutation, preserving only the approved UPDATE overlap", async () => {
    for (const column of ["email", "display_name", "entra_object_id", "manager_entra_object_id", "manager_email",
      "state", "department", "business_area", "deleted_at", "pii_purged_at"]) {
      const value = column === "state" ? "'active'" : "NULL";
      await expect(query(`UPDATE portal.dim_user SET ${column} = ${value} WHERE user_id = 7201`, "metrics_fixture"))
        .rejects.toMatchObject({ number: 230 });
    }
    await expect(query("SELECT * FROM portal.DirectorySyncState", "metrics_fixture")).rejects.toMatchObject({ number: 229 });
    await expect(query("UPDATE portal.DirectorySyncState SET last_error_code = NULL WHERE 1 = 0", "metrics_fixture"))
      .rejects.toMatchObject({ number: 229 });
    await expect(query("UPDATE portal.SourceArtifact SET row_count = 0 WHERE 1 = 0", "metrics_fixture"))
      .rejects.toMatchObject({ number: 229 });
    await expect(query("DELETE FROM portal.SourceArtifact WHERE 1 = 0", "metrics_fixture"))
      .rejects.toMatchObject({ number: 229 });
    await expect(query("SELECT blob_path FROM portal.SourceArtifact", "metrics_fixture")).rejects.toThrow(/permission/i);
    await expect(query("SELECT user_count FROM portal.agg_daily_usage", "metrics_fixture")).rejects.toThrow(/permission/i);
    await expect(query("DELETE FROM portal.dim_user_login_history WHERE 1 = 0", "metrics_fixture")).rejects.toMatchObject({ number: 229 });
    for (const user of ["directory_fixture", "metrics_fixture"]) {
      await query("UPDATE portal.dim_user SET login = 'fixture-shared', updated_at = SYSUTCDATETIME() WHERE user_id = 7299", user);
      expect((await query("SELECT login FROM portal.dim_user WHERE user_id = 7299", user)).recordset)
        .toEqual([{ login: "fixture-shared" }]);
    }
  });
});

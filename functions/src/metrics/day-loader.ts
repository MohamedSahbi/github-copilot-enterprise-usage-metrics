import { createHash, randomUUID } from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";
import sql from "mssql";
import { computeAdoption, type AdoptionRow } from "../../../shared/src/metrics.js";
import { FEATURE_TAXONOMY } from "../../../shared/src/features.js";
import type { StgUserBreakdownRow, StgUserDailyRow, StgUserFamilyCountRow } from "../../../shared/src/rows.js";
import { parseMetricsDay, type MetricsValidationIssue } from "./day-parser.js";

const TRANSFORM_VERSION = "1";
const BLOB_PREFIX = "raw/users_1_day";
const MAX_SQL_TEXT = 400;

export interface MetricsDayLoadInput {
  reportDay: string;
  organizationId: number;
  organizationLogin: string;
  content: Uint8Array;
  runId?: string;
  correlationId?: string;
}

export interface MetricsDayLoadResult {
  runId: string;
  status: "published" | "quarantined";
  rowsRead: number;
  rowsLoaded: number;
  rowsQuarantined: number;
  issues: number;
  artifactId: number;
  blobPath: string;
}

export interface StructuredLogger {
  info(event: Readonly<Record<string, string | number>>): void;
  error(event: Readonly<Record<string, string | number>>): void;
}

export interface MetricsDayLoaderDependencies {
  sqlConfig: sql.config;
  blobContainer: ContainerClient;
  logger?: StructuredLogger;
}

// Hosted access is pinned to the managed identity (clientId = user-assigned identity); no wider credential chain.
export function createMetricsSqlConfig(server: string, database: string, managedIdentityClientId: string): sql.config {
  return {
    server,
    database,
    authentication: { type: "token-credential", options: { credential: new ManagedIdentityCredential({ clientId: managedIdentityClientId }) } },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { min: 1, max: 1 },
  };
}

export function createMetricsBlobContainerClient(accountUrl: string, containerName: string, managedIdentityClientId: string): ContainerClient {
  const endpoint = new URL(accountUrl);
  if (endpoint.protocol !== "https:") throw new Error("Metrics blob storage endpoint must use HTTPS");
  return new ContainerClient(`${endpoint.origin}/${containerName}`, new ManagedIdentityCredential({ clientId: managedIdentityClientId }));
}

const defaultLogger: StructuredLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event)),
};

function validSegment(value: string, maxLength = 255): boolean {
  return value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function safeFieldPath(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[^A-Za-z0-9_.[\]-]/g, "_").slice(0, 200);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function countNonEmptyLines(bytes: Uint8Array): number {
  let count = 0;
  let hasContent = false;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      if (hasContent) count++;
      hasContent = false;
    } else if (byte !== 0x0d) {
      hasContent = true;
    }
  }
  if (hasContent) count++;
  return count;
}

function blobPath(input: MetricsDayLoadInput, runId: string): string {
  const [year, month, day] = input.reportDay.split("-");
  return `${BLOB_PREFIX}/${input.organizationLogin}/${year}/${month}/${day}/${runId}.ndjson`;
}

async function ensureImmutableBlob(container: ContainerClient, path: string, bytes: Uint8Array, digest: string): Promise<void> {
  const blob = container.getBlockBlobClient(path);
  try {
    await blob.uploadData(bytes, {
      conditions: { ifNoneMatch: "*" },
      metadata: { sha256: digest },
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== 412) throw error;
    const existing = await blob.downloadToBuffer();
    if (hash(existing) !== digest) throw new Error("Immutable raw archive path already contains different content", { cause: error });
  }
}

function addColumn(table: sql.Table, name: string, type: sql.ISqlType | (() => sql.ISqlType), nullable = false): void {
  table.columns.add(name, type, { nullable });
}

// portal_ingest has no ALTER TABLE; these hints keep bulk copy permitted on tables with constraints.
const BULK_OPTIONS = { checkConstraints: true, fireTriggers: true };

function dailyTable(rows: readonly StgUserDailyRow[]): sql.Table {
  const table = new sql.Table("portal.stg_user_daily");
  table.create = false;
  addColumn(table, "run_id", sql.UniqueIdentifier);
  addColumn(table, "artifact_id", sql.BigInt);
  addColumn(table, "line_number", sql.Int);
  addColumn(table, "organization_id", sql.BigInt);
  addColumn(table, "enterprise_id", sql.BigInt, true);
  addColumn(table, "user_id", sql.BigInt);
  addColumn(table, "user_login", sql.NVarChar(255), true);
  addColumn(table, "usage_day", sql.Date);
  addColumn(table, "interaction_count", sql.Int);
  addColumn(table, "code_generation_count", sql.Int);
  addColumn(table, "code_acceptance_count", sql.Int);
  addColumn(table, "loc_suggested_to_add", sql.BigInt);
  addColumn(table, "loc_suggested_to_delete", sql.BigInt);
  addColumn(table, "loc_added", sql.BigInt);
  addColumn(table, "loc_deleted", sql.BigInt);
  for (const name of [
    "used_agent", "used_chat", "used_cli", "used_coding_agent", "used_cloud_agent", "used_copilot_app",
    "used_vscode_agent", "used_code_review_active", "used_code_review_passive",
  ]) addColumn(table, name, sql.Bit);
  addColumn(table, "ai_credits_used", sql.VarChar(40));
  addColumn(table, "ai_adoption_phase_number", sql.TinyInt, true);
  addColumn(table, "ai_adoption_phase", sql.VarChar(64), true);
  addColumn(table, "extra_json", sql.NVarChar(sql.MAX), true);
  for (const row of rows) table.rows.add(...Object.values(row));
  return table;
}

function breakdownTable(rows: readonly StgUserBreakdownRow[]): sql.Table {
  const table = new sql.Table("portal.stg_user_breakdown");
  table.create = false;
  addColumn(table, "run_id", sql.UniqueIdentifier);
  addColumn(table, "artifact_id", sql.BigInt);
  addColumn(table, "line_number", sql.Int);
  addColumn(table, "item_number", sql.Int);
  addColumn(table, "breakdown_kind", sql.VarChar(24));
  addColumn(table, "key_1", sql.NVarChar(128));
  addColumn(table, "key_2", sql.NVarChar(128));
  addColumn(table, "interaction_count", sql.Int);
  addColumn(table, "code_generation_count", sql.Int);
  addColumn(table, "code_acceptance_count", sql.Int);
  addColumn(table, "loc_suggested_to_add", sql.BigInt);
  addColumn(table, "loc_suggested_to_delete", sql.BigInt);
  addColumn(table, "loc_added", sql.BigInt);
  addColumn(table, "loc_deleted", sql.BigInt);
  addColumn(table, "session_count", sql.Int, true);
  addColumn(table, "request_count", sql.Int, true);
  addColumn(table, "prompt_tokens", sql.BigInt, true);
  addColumn(table, "output_tokens", sql.BigInt, true);
  addColumn(table, "version_info", sql.NVarChar(1000), true);
  for (const row of rows) table.rows.add(...Object.values(row));
  return table;
}

function familyTable(rows: readonly StgUserFamilyCountRow[]): sql.Table {
  const table = new sql.Table("portal.stg_user_family_count");
  table.create = false;
  addColumn(table, "run_id", sql.UniqueIdentifier);
  addColumn(table, "artifact_id", sql.BigInt);
  addColumn(table, "line_number", sql.Int);
  addColumn(table, "item_number", sql.Int);
  addColumn(table, "family", sql.VarChar(16));
  addColumn(table, "item_name", sql.NVarChar(256));
  addColumn(table, "interaction_count", sql.Int);
  for (const row of rows) table.rows.add(...Object.values(row));
  return table;
}

function issuesTable(runId: string, artifactId: number, issues: readonly MetricsValidationIssue[], reportDay: string): sql.Table {
  const table = new sql.Table("portal.ValidationIssue");
  table.create = false;
  addColumn(table, "run_id", sql.UniqueIdentifier);
  addColumn(table, "artifact_id", sql.BigInt, true);
  addColumn(table, "line_number", sql.Int, true);
  addColumn(table, "raw_row_sha256", sql.Char(64), true);
  addColumn(table, "severity", sql.VarChar(8));
  addColumn(table, "error_code", sql.VarChar(64));
  addColumn(table, "field_path", sql.NVarChar(200), true);
  addColumn(table, "message", sql.NVarChar(MAX_SQL_TEXT), true);
  addColumn(table, "issue_type", sql.VarChar(16), true);
  addColumn(table, "report_day", sql.Date, true);
  for (const issue of issues) {
    const inboxIssue = issue.error_code === "duplicate_file" || issue.error_code === "duplicate_nested_name";
    table.rows.add(
      runId, artifactId, issue.line_number, issue.raw_row_sha256, issue.severity, issue.error_code,
      safeFieldPath(issue.field_path), issue.message.slice(0, MAX_SQL_TEXT),
      inboxIssue ? "duplicate_file" : null, inboxIssue ? reportDay : null,
    );
  }
  return table;
}

async function writeIssues(
  request: sql.Request,
  runId: string,
  artifactId: number,
  issues: readonly MetricsValidationIssue[],
  reportDay: string,
): Promise<void> {
  if (issues.length === 0) return;
  await request.bulk(issuesTable(runId, artifactId, issues, reportDay), BULK_OPTIONS);
}

async function quarantineInvalidUtf8(
  pool: sql.ConnectionPool,
  runId: string,
  artifactId: number,
  bytes: Uint8Array,
  reportDay: string,
): Promise<number> {
  const rowsRead = countNonEmptyLines(bytes);
  const issue: MetricsValidationIssue = {
    line_number: null,
    raw_row_sha256: null,
    severity: "fatal",
    error_code: "malformed_json",
    field_path: null,
    message: "raw metrics input is not valid UTF-8",
  };
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await writeIssues(transaction.request(), runId, artifactId, [issue], reportDay);
    await transaction.request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("rowsRead", sql.Int, rowsRead)
      .input("rowsQuarantined", sql.Int, rowsRead)
      .query(`
        UPDATE portal.IngestionRun
        SET status = 'quarantined', rows_read = @rowsRead, rows_loaded = 0,
            rows_quarantined = @rowsQuarantined, error_code = 'malformed_json',
            completed_at = SYSUTCDATETIME()
        WHERE run_id = @runId`);
    await transaction.commit();
    return rowsRead;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

async function writeStaging(
  transaction: sql.Transaction,
  runId: string,
  artifactId: number,
  parsed: ReturnType<typeof parseMetricsDay>,
  reportDay: string,
): Promise<void> {
  const rows = parsed.fatal ? [] : parsed.rows;
  const daily = rows.map((row) => row.daily);
  const breakdown = rows.flatMap((row) => row.breakdown);
  const families = rows.flatMap((row) => row.families);
  if (daily.length) await transaction.request().bulk(dailyTable(daily), BULK_OPTIONS);
  if (breakdown.length) await transaction.request().bulk(breakdownTable(breakdown), BULK_OPTIONS);
  if (families.length) await transaction.request().bulk(familyTable(families), BULK_OPTIONS);
  await writeIssues(transaction.request(), runId, artifactId, parsed.issues, reportDay);
}

async function updateRun(
  pool: sql.ConnectionPool,
  runId: string,
  values: { status: string; rowsRead?: number; rowsLoaded?: number; rowsQuarantined?: number; errorCode?: string },
): Promise<void> {
  const request = pool.request().input("runId", sql.UniqueIdentifier, runId).input("status", sql.VarChar(16), values.status);
  request.input("rowsRead", sql.Int, values.rowsRead ?? null);
  request.input("rowsLoaded", sql.Int, values.rowsLoaded ?? null);
  request.input("rowsQuarantined", sql.Int, values.rowsQuarantined ?? null);
  request.input("errorCode", sql.VarChar(64), values.errorCode ?? null);
  await request.query(`
    UPDATE portal.IngestionRun
    SET status = @status,
        rows_read = COALESCE(@rowsRead, rows_read),
        rows_loaded = COALESCE(@rowsLoaded, rows_loaded),
        rows_quarantined = COALESCE(@rowsQuarantined, rows_quarantined),
        error_code = @errorCode,
        completed_at = CASE WHEN @status IN ('published', 'quarantined', 'failed') THEN SYSUTCDATETIME() ELSE completed_at END
    WHERE run_id = @runId`);
}

function dayLockResource(input: MetricsDayLoadInput): string {
  return `ingest:users_1_day:${input.organizationId}:${input.reportDay}`;
}

function scopeKeyForOrganization(organizationId: number): string {
  return String(organizationId);
}

async function acquireDayLock(pool: sql.ConnectionPool, input: MetricsDayLoadInput): Promise<void> {
  const result = await pool.request()
    .input("resource", sql.NVarChar(255), dayLockResource(input))
    .query<{ result: number }>(`
    DECLARE @result INT;
    EXEC @result = sys.sp_getapplock
      @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
    SELECT @result AS result`);
  if (Number(result.recordset[0]?.result) < 0) throw new Error("DAY_LOCK_TIMEOUT");
}

async function releaseDayLock(pool: sql.ConnectionPool, input: MetricsDayLoadInput): Promise<void> {
  await pool.request()
    .input("resource", sql.NVarChar(255), dayLockResource(input))
    .query("EXEC sys.sp_releaseapplock @Resource = @resource, @LockOwner = 'Session'");
}

async function publish(
  pool: sql.ConnectionPool,
  input: MetricsDayLoadInput,
  runId: string,
  artifactId: number,
  rowsRead: number,
  rowsLoaded: number,
): Promise<"published" | "quarantined"> {
  let transaction: sql.Transaction | undefined;
  try {
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const countResult = await transaction.request()
      .input("organizationId", sql.BigInt, input.organizationId)
      .input("reportDay", sql.Date, input.reportDay)
      .query<{ row_count: number }>(`
        SELECT COUNT_BIG(*) AS row_count
        FROM portal.fact_user_daily_usage WITH (UPDLOCK, HOLDLOCK)
        WHERE organization_id = @organizationId AND usage_day = @reportDay`);
    const existingRows = Number(countResult.recordset[0]?.row_count ?? 0);
    if (rowsLoaded < existingRows) {
      await transaction.request()
        .input("runId", sql.UniqueIdentifier, runId)
        .input("artifactId", sql.BigInt, artifactId)
        .input("reportDay", sql.Date, input.reportDay)
        .query(`
          INSERT INTO portal.ValidationIssue
            (run_id, artifact_id, severity, error_code, field_path, message, issue_type, report_day)
          VALUES
            (@runId, @artifactId, 'fatal', 'smaller_day_blocked', NULL,
             N'Incoming report has fewer rows than the published day.', 'smaller_day', @reportDay)`);
      await transaction.request()
        .input("runId", sql.UniqueIdentifier, runId)
        .input("rowsRead", sql.Int, rowsRead)
        .input("rowsLoaded", sql.Int, rowsLoaded)
        .input("rowsQuarantined", sql.Int, rowsRead)
        .query(`
          UPDATE portal.IngestionRun
          SET status = 'quarantined', rows_read = @rowsRead, rows_loaded = @rowsLoaded,
              rows_quarantined = @rowsQuarantined, error_code = 'smaller_day_blocked',
              completed_at = SYSUTCDATETIME()
          WHERE run_id = @runId`);
      await transaction.commit();
      return "quarantined";
    }

    const request = () => transaction!.request();
    await request()
      .input("organizationId", sql.BigInt, input.organizationId)
      .input("organizationLogin", sql.NVarChar(255), input.organizationLogin)
      .query(`
        UPDATE portal.dim_organization WITH (UPDLOCK, HOLDLOCK)
        SET login = @organizationLogin, updated_at = SYSUTCDATETIME()
        WHERE organization_id = @organizationId;
        IF @@ROWCOUNT = 0
          INSERT INTO portal.dim_organization (organization_id, login) VALUES (@organizationId, @organizationLogin)`);

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .query(`
        UPDATE u WITH (UPDLOCK, HOLDLOCK)
        SET login = COALESCE(s.user_login, u.login),
            first_seen_day = CASE WHEN u.first_seen_day IS NULL OR s.usage_day < u.first_seen_day THEN s.usage_day ELSE u.first_seen_day END,
            last_seen_day = CASE WHEN u.last_seen_day IS NULL OR s.usage_day > u.last_seen_day THEN s.usage_day ELSE u.last_seen_day END,
            updated_at = SYSUTCDATETIME()
        FROM portal.dim_user AS u
        JOIN (SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily WHERE run_id = @runId GROUP BY user_id) AS s
          ON s.user_id = u.user_id;
        INSERT INTO portal.dim_user (user_id, login, first_seen_day, last_seen_day)
        SELECT s.user_id, s.user_login, s.usage_day, s.usage_day
        FROM (SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily WHERE run_id = @runId GROUP BY user_id) AS s
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_user AS u WITH (UPDLOCK, HOLDLOCK) WHERE u.user_id = s.user_id)`);

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .query(`
        UPDATE h WITH (UPDLOCK, HOLDLOCK)
        SET first_seen_day = CASE WHEN s.usage_day < h.first_seen_day THEN s.usage_day ELSE h.first_seen_day END,
            last_seen_day = CASE WHEN s.usage_day > h.last_seen_day THEN s.usage_day ELSE h.last_seen_day END
        FROM portal.dim_user_login_history AS h
        JOIN (SELECT user_id, user_login AS login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily
              WHERE run_id = @runId AND user_login IS NOT NULL GROUP BY user_id, user_login) AS s
          ON s.user_id = h.user_id AND s.login = h.login;
        INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day, is_hashed_login)
        SELECT s.user_id, s.login, s.usage_day, s.usage_day,
               CASE WHEN s.login LIKE REPLICATE('[0-9a-f]', 20) + '%' THEN 1 ELSE 0 END
        FROM (SELECT user_id, user_login AS login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily
              WHERE run_id = @runId AND user_login IS NOT NULL GROUP BY user_id, user_login) AS s
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_user_login_history AS h WITH (UPDLOCK, HOLDLOCK)
                          WHERE h.user_id = s.user_id AND h.login = s.login)`);

    await seedDimensions(transaction, runId);
    await request()
      .input("organizationId", sql.BigInt, input.organizationId)
      .input("reportDay", sql.Date, input.reportDay)
      .query("DELETE FROM portal.agg_daily_usage WHERE organization_id = @organizationId AND usage_day = @reportDay");
    await request()
      .input("organizationId", sql.BigInt, input.organizationId)
      .input("reportDay", sql.Date, input.reportDay)
      .query("DELETE FROM portal.fact_user_daily_usage WHERE organization_id = @organizationId AND usage_day = @reportDay");

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("artifactId", sql.BigInt, artifactId)
      .query(`
        INSERT INTO portal.fact_user_daily_usage (
          organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
          loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
          used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active,
          used_code_review_passive, ai_credits_used, ai_adoption_phase_number, ai_adoption_phase, extra_json,
          run_id, source_artifact_id, transform_version)
        SELECT organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
          loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
          used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active,
          used_code_review_passive, ai_credits_used, ai_adoption_phase_number, ai_adoption_phase, extra_json,
          run_id, artifact_id, '${TRANSFORM_VERSION}'
        FROM portal.stg_user_daily WHERE run_id = @runId`);

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("artifactId", sql.BigInt, artifactId)
      .query(`
        INSERT INTO portal.fact_usage_breakdown (
          organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
          code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
          loc_added, loc_deleted, session_count, request_count, prompt_tokens, output_tokens, version_info,
          run_id, source_artifact_id, transform_version)
        SELECT d.organization_id, d.user_id, d.usage_day, b.breakdown_kind, b.key_1, b.key_2, b.interaction_count,
          b.code_generation_count, b.code_acceptance_count, b.loc_suggested_to_add, b.loc_suggested_to_delete,
          b.loc_added, b.loc_deleted, b.session_count, b.request_count, b.prompt_tokens, b.output_tokens, b.version_info,
          b.run_id, b.artifact_id, '${TRANSFORM_VERSION}'
        FROM portal.stg_user_breakdown AS b
        JOIN portal.stg_user_daily AS d
          ON d.run_id = b.run_id AND d.artifact_id = b.artifact_id AND d.line_number = b.line_number
        WHERE b.run_id = @runId AND b.artifact_id = @artifactId`);

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .query(`
        INSERT INTO portal.fact_usage_family_count (
          organization_id, user_id, usage_day, family, item_name, interaction_count, run_id, source_artifact_id, transform_version)
        SELECT d.organization_id, d.user_id, d.usage_day, f.family, f.item_name, f.interaction_count,
          f.run_id, f.artifact_id, '${TRANSFORM_VERSION}'
        FROM portal.stg_user_family_count AS f
        JOIN portal.stg_user_daily AS d
          ON d.run_id = f.run_id AND d.artifact_id = f.artifact_id AND d.line_number = f.line_number
        WHERE f.run_id = @runId`);

    await writeOrganizationAggregate(transaction, input, runId);

    await request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("scopeKey", sql.NVarChar(100), scopeKeyForOrganization(input.organizationId))
      .input("reportDay", sql.Date, input.reportDay)
      .input("rowsRead", sql.Int, rowsRead)
      .input("rowsLoaded", sql.Int, rowsLoaded)
      .input("rowsQuarantined", sql.Int, rowsRead - rowsLoaded)
      .query(`
        UPDATE portal.IngestionRun
        SET is_current = 0
        WHERE source_kind = 'users_1_day' AND scope_key = @scopeKey AND report_day = @reportDay AND is_current = 1;
        UPDATE portal.IngestionRun
        SET status = 'published', is_current = 1, rows_read = @rowsRead, rows_loaded = @rowsLoaded,
            rows_quarantined = @rowsQuarantined, error_code = NULL, completed_at = SYSUTCDATETIME()
        WHERE run_id = @runId`);
    if (rowsRead === rowsLoaded) {
      await request()
        .input("sourceKind", sql.VarChar(40), "users_1_day")
        .input("scopeKey", sql.NVarChar(100), scopeKeyForOrganization(input.organizationId))
        .input("reportDay", sql.Date, input.reportDay)
        .input("runId", sql.UniqueIdentifier, runId)
        .query(`
          UPDATE portal.SourceCheckpoint WITH (UPDLOCK, HOLDLOCK)
          SET last_complete_day = CASE WHEN last_complete_day IS NULL OR last_complete_day < @reportDay THEN @reportDay ELSE last_complete_day END,
              last_run_id = CASE WHEN last_complete_day IS NULL OR last_complete_day <= @reportDay THEN @runId ELSE last_run_id END,
              updated_at = SYSUTCDATETIME()
          WHERE source_kind = @sourceKind AND scope_key = @scopeKey;
          IF @@ROWCOUNT = 0
            INSERT INTO portal.SourceCheckpoint (source_kind, scope_key, last_complete_day, last_run_id)
            VALUES (@sourceKind, @scopeKey, @reportDay, @runId)`);
    }
    await transaction.commit();
    return "published";
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

async function seedDimensions(transaction: sql.Transaction, runId: string): Promise<void> {
  const features = Object.entries(FEATURE_TAXONOMY);
  for (const [feature, metadata] of features) {
    await transaction.request()
      .input("feature", sql.NVarChar(128), feature)
      .input("isChat", sql.Bit, metadata.isChat)
      .input("isAgent", sql.Bit, metadata.isAgent)
      .input("isCli", sql.Bit, metadata.isCli)
      .input("chatMode", sql.VarChar(8), metadata.chatModeBucket ?? null)
      .query(`
        UPDATE portal.dim_feature WITH (UPDLOCK, HOLDLOCK)
        SET is_chat = @isChat, is_agent = @isAgent, is_cli = @isCli, chat_mode_bucket = @chatMode, is_known = 1
        WHERE feature_key = @feature;
        IF @@ROWCOUNT = 0
          INSERT INTO portal.dim_feature (feature_key, is_chat, is_agent, is_cli, chat_mode_bucket, is_known)
          VALUES (@feature, @isChat, @isAgent, @isCli, @chatMode, 1)`);
  }
  await transaction.request().input("runId", sql.UniqueIdentifier, runId).query(`
    INSERT INTO portal.dim_feature (feature_key)
    SELECT DISTINCT b.key_1 FROM portal.stg_user_breakdown AS b
    WHERE b.run_id = @runId AND b.breakdown_kind = 'feature'
      AND NOT EXISTS (SELECT 1 FROM portal.dim_feature AS d WHERE d.feature_key = b.key_1)`);
  await transaction.request().input("runId", sql.UniqueIdentifier, runId).query(`
    INSERT INTO portal.dim_model (model_key, is_known)
    SELECT DISTINCT CASE WHEN b.breakdown_kind = 'language_model' THEN b.key_2 ELSE b.key_1 END, 0
    FROM portal.stg_user_breakdown AS b
    WHERE b.run_id = @runId AND b.breakdown_kind IN ('model_feature', 'language_model')
      AND NOT EXISTS (
        SELECT 1 FROM portal.dim_model AS d
        WHERE d.model_key = CASE WHEN b.breakdown_kind = 'language_model' THEN b.key_2 ELSE b.key_1 END
      )`);
  await transaction.request().input("runId", sql.UniqueIdentifier, runId).query(`
    INSERT INTO portal.dim_client (client_key, is_known)
    SELECT DISTINCT b.key_1, CASE WHEN b.key_1 IN ('copilot_cli', 'copilot_app', 'vscode_agent') THEN 1 ELSE 0 END
    FROM portal.stg_user_breakdown AS b
    WHERE b.run_id = @runId AND b.breakdown_kind = 'client'
      AND NOT EXISTS (SELECT 1 FROM portal.dim_client AS d WHERE d.client_key = b.key_1)`);
  await transaction.request().input("runId", sql.UniqueIdentifier, runId).query(`
    INSERT INTO portal.dim_language (language_key)
    SELECT DISTINCT b.key_1 FROM portal.stg_user_breakdown AS b
    WHERE b.run_id = @runId AND b.breakdown_kind IN ('language_feature', 'language_model')
      AND NOT EXISTS (SELECT 1 FROM portal.dim_language AS d WHERE d.language_key = b.key_1)`);
}

async function writeOrganizationAggregate(
  transaction: sql.Transaction,
  input: MetricsDayLoadInput,
  runId: string,
): Promise<void> {
  const request = transaction.request().input("runId", sql.UniqueIdentifier, runId);
  const staged = await request.query<{
    user_id: number; usage_day: string; used_cli: boolean; used_copilot_app: boolean; used_vscode_agent: boolean;
    used_cloud_agent: boolean; used_code_review_active: boolean; used_code_review_passive: boolean;
    interaction_count: number; code_generation_count: number; code_acceptance_count: number; loc_added: number; loc_deleted: number;
    ai_credits_used: string;
  }>(`
    SELECT d.user_id, CONVERT(CHAR(10), d.usage_day, 23) AS usage_day,
      d.used_cli, d.used_copilot_app, d.used_vscode_agent, d.used_cloud_agent,
      d.used_code_review_active, d.used_code_review_passive, d.interaction_count, d.code_generation_count,
      d.code_acceptance_count, d.loc_added, d.loc_deleted, CONVERT(VARCHAR(40), d.ai_credits_used) AS ai_credits_used
    FROM portal.stg_user_daily AS d WHERE d.run_id = @runId`);
  const featureRows = await transaction.request().input("runId", sql.UniqueIdentifier, runId).query<{ user_id: number; feature: string; interactions: number; generations: number }>(`
    SELECT d.user_id, b.key_1 AS feature, b.interaction_count AS interactions, b.code_generation_count AS generations
    FROM portal.stg_user_daily AS d
    JOIN portal.stg_user_breakdown AS b
      ON b.run_id = d.run_id AND b.artifact_id = d.artifact_id AND b.line_number = d.line_number
    WHERE d.run_id = @runId AND b.breakdown_kind = 'feature'`);
  const featuresByUser = new Map<number, { feature: string; interactions: number; generations: number }[]>();
  for (const row of featureRows.recordset) {
    const values = featuresByUser.get(row.user_id) ?? [];
    values.push({ feature: row.feature, interactions: row.interactions, generations: row.generations });
    featuresByUser.set(row.user_id, values);
  }
  const adoptionRows: AdoptionRow[] = staged.recordset.map((row) => ({
    user_id: row.user_id, usage_day: String(row.usage_day).slice(0, 10), used_cli: row.used_cli,
    used_copilot_app: row.used_copilot_app, used_vscode_agent: row.used_vscode_agent, used_cloud_agent: row.used_cloud_agent,
    used_code_review_active: row.used_code_review_active, used_code_review_passive: row.used_code_review_passive,
    ai_credits_used: Number(row.ai_credits_used), features: featuresByUser.get(row.user_id) ?? [],
  }));
  const adoption = computeAdoption(adoptionRows);
  const summary = await transaction.request().input("runId", sql.UniqueIdentifier, runId).query<{
    user_count: number; interaction_count: number; code_generation_count: number; code_acceptance_count: number;
    loc_added: number; loc_deleted: number; ai_credits_used: string;
  }>(`
    SELECT COUNT_BIG(*) AS user_count, SUM(CONVERT(BIGINT, interaction_count)) AS interaction_count,
      SUM(CONVERT(BIGINT, code_generation_count)) AS code_generation_count,
      SUM(CONVERT(BIGINT, code_acceptance_count)) AS code_acceptance_count,
      SUM(loc_added) AS loc_added, SUM(loc_deleted) AS loc_deleted,
      CONVERT(VARCHAR(40), SUM(ai_credits_used)) AS ai_credits_used
    FROM portal.stg_user_daily WHERE run_id = @runId`);
  const totals = summary.recordset[0];
  if (!totals || Number(totals.user_count) === 0) return;
  await transaction.request()
    .input("organizationId", sql.BigInt, input.organizationId)
    .input("reportDay", sql.Date, input.reportDay)
    .input("userCount", sql.Int, Number(totals.user_count))
    .input("interactionCount", sql.BigInt, totals.interaction_count)
    .input("codeGenerationCount", sql.BigInt, totals.code_generation_count)
    .input("codeAcceptanceCount", sql.BigInt, totals.code_acceptance_count)
    .input("locAdded", sql.BigInt, totals.loc_added)
    .input("locDeleted", sql.BigInt, totals.loc_deleted)
    .input("chatUsers", sql.Int, adoption.chatUsers)
    .input("agentUsers", sql.Int, adoption.agentModeUsers)
    .input("cliUsers", sql.Int, adoption.cliUsers)
    .input("cloudAgentUsers", sql.Int, adoption.codingAgentUsers)
    .input("vscodeAgentUsers", sql.Int, adoption.vscodeAgentUsers)
    .input("appUsers", sql.Int, adoption.appUsers)
    .input("codeReviewUsers", sql.Int, adoption.codeReviewUsers)
    .input("advancedUsers", sql.Int, adoption.advancedUsers)
    .input("completionOnlyUsers", sql.Int, adoption.completionOnlyUsers)
    .input("credits", sql.VarChar(40), totals.ai_credits_used ?? "0")
    .input("runId", sql.UniqueIdentifier, runId)
    .query(`
      INSERT INTO portal.agg_daily_usage (
        organization_id, usage_day, group_kind, group_key, metric_version, user_count, interaction_count,
        code_generation_count, code_acceptance_count, loc_added, loc_deleted, chat_users, agent_users,
        cli_users, cloud_agent_users, vscode_agent_users, app_users, code_review_users, advanced_users,
        completion_only_users, ai_credits_used, run_id, transform_version)
      VALUES (@organizationId, @reportDay, 'organization', N'', 1, @userCount, @interactionCount,
        @codeGenerationCount, @codeAcceptanceCount, @locAdded, @locDeleted, @chatUsers, @agentUsers,
        @cliUsers, @cloudAgentUsers, @vscodeAgentUsers, @appUsers, @codeReviewUsers, @advancedUsers,
        @completionOnlyUsers, CONVERT(DECIMAL(18, 9), @credits), @runId, '${TRANSFORM_VERSION}')`);
}

function classifiedError(error: unknown): string {
  if (error instanceof Error && error.message === "DAY_LOCK_TIMEOUT") return "day_lock_timeout";
  if (typeof error === "object" && error !== null && "statusCode" in error) return "archive_write_failed";
  return "load_failed";
}

export async function loadMetricsDay(
  input: MetricsDayLoadInput,
  dependencies: MetricsDayLoaderDependencies,
): Promise<MetricsDayLoadResult> {
  if (!validDate(input.reportDay)) throw new TypeError("reportDay must be a real ISO calendar date");
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0) throw new TypeError("organizationId must be a positive safe integer");
  if (!validSegment(input.organizationLogin)) throw new TypeError("organizationLogin must be a single safe path segment");
  const runId = input.runId ?? randomUUID();
  const correlationId = input.correlationId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f-]{36}$/i.test(correlationId)) throw new TypeError("runId and correlationId must be UUIDs");

  const logger = dependencies.logger ?? defaultLogger;
  const startedAt = Date.now();
  const bytes = Uint8Array.from(input.content);
  const digest = hash(bytes);
  const path = blobPath(input, runId);
  const poolConfig: sql.config = { ...dependencies.sqlConfig, pool: { min: 1, max: 1 } };
  const pool = await new sql.ConnectionPool(poolConfig).connect();
  let runCreated = false;
  let dayLockAcquired = false;
  let artifactId: number;
  logger.info({ event: "metrics_day_started", runId, correlationId, reportDay: input.reportDay, source: "users_1_day" });
  try {
    await pool.request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("scopeKey", sql.NVarChar(100), scopeKeyForOrganization(input.organizationId))
      .input("reportDay", sql.Date, input.reportDay)
      .input("correlationId", sql.VarChar(64), correlationId)
      .query(`
        INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, transform_version, correlation_id)
        VALUES (@runId, 'users_1_day', @scopeKey, @reportDay, 'started', '${TRANSFORM_VERSION}', @correlationId)`);
    runCreated = true;

    await acquireDayLock(pool, input);
    dayLockAcquired = true;
    await ensureImmutableBlob(dependencies.blobContainer, path, bytes, digest);
    let content: string | null = null;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      content = null;
    }
    // portal_ingest may only INSERT SourceArtifact, so the line count is known before the row is written.
    const artifactRowCount = content === null
      ? countNonEmptyLines(bytes)
      : content.split(/\r?\n/).filter((line) => line.trim() !== "").length;
    const artifact = await pool.request()
      .input("runId", sql.UniqueIdentifier, runId)
      .input("container", sql.NVarChar(63), dependencies.blobContainer.containerName)
      .input("path", sql.NVarChar(600), path)
      .input("sha256", sql.Char(64), digest)
      .input("sizeBytes", sql.BigInt, bytes.byteLength)
      .input("rowCount", sql.Int, artifactRowCount)
      .query<{ artifact_id: number }>(`
        INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes, row_count)
        OUTPUT INSERTED.artifact_id
        VALUES (@runId, @container, @path, @sha256, @sizeBytes, @rowCount)`);
    artifactId = Number(artifact.recordset[0]?.artifact_id);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("SourceArtifact insert returned no artifact id");

    if (content === null) {
      const rowsRead = await quarantineInvalidUtf8(pool, runId, artifactId, bytes, input.reportDay);
      logger.error({
        event: "metrics_day_quarantined", runId, correlationId, reportDay: input.reportDay, source: "users_1_day",
        rowsRead, rowsLoaded: 0, rowsQuarantined: rowsRead, issues: 1,
      });
      return {
        runId, status: "quarantined", rowsRead, rowsLoaded: 0,
        rowsQuarantined: rowsRead, issues: 1, artifactId, blobPath: path,
      };
    }
    const parsed = parseMetricsDay(content, { runId, artifactId, reportDay: input.reportDay, organizationId: input.organizationId });
    const rowsQuarantined = parsed.fatal ? parsed.linesRead : parsed.linesRead - parsed.rows.length;
    const stageTx = new sql.Transaction(pool);
    await stageTx.begin();
    try {
      await writeStaging(stageTx, runId, artifactId, parsed, input.reportDay);
      await stageTx.request()
        .input("runId", sql.UniqueIdentifier, runId)
        .input("rowsRead", sql.Int, parsed.linesRead)
        .input("rowsLoaded", sql.Int, parsed.fatal ? 0 : parsed.rows.length)
        .input("rowsQuarantined", sql.Int, rowsQuarantined)
        .query(`
          UPDATE portal.IngestionRun
          SET status = 'staged', rows_read = @rowsRead, rows_loaded = @rowsLoaded, rows_quarantined = @rowsQuarantined
          WHERE run_id = @runId`);
      await stageTx.commit();
    } catch (error) {
      await stageTx.rollback().catch(() => undefined);
      throw error;
    }

    if (parsed.fatal || parsed.rows.length === 0) {
      const fatalCode = parsed.issues.find((issue) => issue.severity === "fatal")?.error_code ??
        parsed.issues[0]?.error_code ?? "unsupported_schema";
      const rowsLoaded = parsed.fatal ? 0 : parsed.rows.length;
      await updateRun(pool, runId, { status: "quarantined", rowsRead: parsed.linesRead, rowsLoaded, rowsQuarantined, errorCode: fatalCode });
      logger.error({
        event: "metrics_day_quarantined", runId, correlationId, reportDay: input.reportDay, source: "users_1_day",
        rowsRead: parsed.linesRead, rowsLoaded, rowsQuarantined, issues: parsed.issues.length,
      });
      return {
        runId, status: "quarantined", rowsRead: parsed.linesRead, rowsLoaded,
        rowsQuarantined, issues: parsed.issues.length, artifactId, blobPath: path,
      };
    }

    await updateRun(pool, runId, { status: "validated" });
    const status = await publish(pool, input, runId, artifactId, parsed.linesRead, parsed.rows.length);
    logger.info({
      event: status === "published" ? "metrics_day_published" : "metrics_day_quarantined",
      runId, correlationId, reportDay: input.reportDay, source: "users_1_day",
      rowsRead: parsed.linesRead, rowsLoaded: parsed.rows.length, rowsQuarantined: status === "published" ? rowsQuarantined : parsed.linesRead,
      issues: parsed.issues.length, durationMs: Date.now() - startedAt,
    });
    return {
      runId, status, rowsRead: parsed.linesRead, rowsLoaded: parsed.rows.length,
      rowsQuarantined: status === "published" ? rowsQuarantined : parsed.linesRead,
      issues: parsed.issues.length, artifactId, blobPath: path,
    };
  } catch (error) {
    const errorCode = classifiedError(error);
    if (runCreated) await updateRun(pool, runId, { status: "failed", errorCode });
    logger.error({
      event: "metrics_day_failed", runId, correlationId, reportDay: input.reportDay,
      source: "users_1_day", errorCode, durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    try {
      if (dayLockAcquired) await releaseDayLock(pool, input);
    } finally {
      await pool.close();
    }
  }
}

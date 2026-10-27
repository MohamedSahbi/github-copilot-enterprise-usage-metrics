import sql from "mssql";
import { z } from "zod";
import type { ContainerClient } from "@azure/storage-blob";
import { exactDecimal18_9 } from "../../../shared/src/decimal.js";
import { emptyObserved, ReconciliationReadError, sumMetrics, type MetricsSnapshot } from "./report.js";

const count = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = count.refine((value) => value > 0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const runSchema = z.object({
  run_id: z.uuid(), status: z.enum(["published"]), is_current: z.literal(true),
  rows_read: count.nullable(), rows_loaded: count.nullable(), rows_quarantined: count.nullable(),
  error_code: z.string().nullable(),
});
const artifactSchema = z.object({
  artifact_id: id, sha256, size_bytes: count, row_count: count.nullable(),
  blob_container: z.string(),
  blob_path: z.string().regex(/^raw\/users_1_day\/[A-Za-z0-9][A-Za-z0-9-]*\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.ndjson$/i),
});
const issueSchema = z.object({
  artifact_id: id.nullable(),
  severity: z.enum(["reject", "warn", "fatal"]), line_number: count.nullable(), raw_row_sha256: sha256.nullable(),
});
const factSchema = z.object({
  user_id: id, run_id: z.uuid(), source_artifact_id: id,
  interaction_count: count, code_generation_count: count, code_acceptance_count: count,
  loc_suggested_to_add: count, loc_suggested_to_delete: count, loc_added: count, loc_deleted: count,
  ai_credits_used: z.string().transform((value, context) => {
    const decimal = exactDecimal18_9(value);
    if (decimal === null || decimal.startsWith("-")) {
      context.addIssue({ code: "custom", message: "invalid decimal" });
      return z.NEVER;
    }
    return decimal;
  }),
});

function readError(error: unknown): ReconciliationReadError {
  if (error instanceof ReconciliationReadError) return error;
  const parsed = z.object({ statusCode: z.number().optional(), number: z.number().optional() }).safeParse(error);
  return new ReconciliationReadError(parsed.success &&
    (parsed.data.statusCode === 401 || parsed.data.statusCode === 403 || parsed.data.number === 229) ? "unauthorized" : "unavailable");
}

// Each read uses one consistent SQL transaction. No data, checkpoint, grants or source-system writes.
export function createMetricsReconciliationReader(config: sql.config, archiveContainer: ContainerClient) {
  return async (organizationId: number, reportDay: string, perUser: boolean): Promise<MetricsSnapshot> => {
    const observed = emptyObserved(organizationId, reportDay);
    let pool: sql.ConnectionPool | undefined;
    let transaction: sql.Transaction | undefined;
    let inTransaction = false;
    let blobPath: string | null = null;
    const rejects: Array<{ lineNumber: number; sha256: string }> = [];
    try {
      pool = await new sql.ConnectionPool(config).connect();
      transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      inTransaction = true;
      const runs = await transaction.request()
        .input("scope", sql.NVarChar(100), String(organizationId)).input("day", sql.Date, reportDay)
        .query(`SELECT run_id, status, is_current, rows_read, rows_loaded, rows_quarantined, error_code
          FROM portal.IngestionRun
          WHERE source_kind = 'users_1_day' AND scope_key = @scope AND report_day = @day AND is_current = 1`);
      if (runs.recordset.length > 1) throw new ReconciliationReadError("incomplete");
      if (runs.recordset.length === 1) {
        const parsedRun = runSchema.safeParse(runs.recordset[0]);
        if (!parsedRun.success) throw new ReconciliationReadError("incomplete");
        const run = parsedRun.data;
        observed.run = { runId: run.run_id, status: run.status, isCurrent: run.is_current,
          rowsRead: run.rows_read, rowsLoaded: run.rows_loaded, rowsQuarantined: run.rows_quarantined, errorCode: run.error_code };
        const artifacts = await transaction.request().input("run", sql.UniqueIdentifier, run.run_id)
          .query(`SELECT artifact_id, sha256, size_bytes, row_count, blob_container, blob_path
            FROM portal.SourceArtifact WHERE run_id = @run`);
        if (artifacts.recordset.length === 1) {
          const parsedArtifact = artifactSchema.safeParse(artifacts.recordset[0]);
          if (!parsedArtifact.success) throw new ReconciliationReadError("incomplete");
          const artifact = parsedArtifact.data;
          if (artifact.blob_container !== archiveContainer.containerName) throw new ReconciliationReadError("incomplete");
          observed.artifact = { artifactId: artifact.artifact_id, sha256: artifact.sha256, sizeBytes: artifact.size_bytes, rowCount: artifact.row_count };
          blobPath = artifact.blob_path;
        }
        const issues = await transaction.request().input("run", sql.UniqueIdentifier, run.run_id)
          .query("SELECT artifact_id, severity, line_number, raw_row_sha256 FROM portal.ValidationIssue WHERE run_id = @run");
        for (const value of issues.recordset) {
          const parsedIssue = issueSchema.safeParse(value);
          if (!parsedIssue.success) throw new ReconciliationReadError("incomplete");
          const issue = parsedIssue.data;
          observed.issueCounts[issue.severity]++;
          if (issue.severity === "reject") {
            if (issue.artifact_id !== observed.artifact?.artifactId || issue.line_number === null || issue.raw_row_sha256 === null) {
              throw new ReconciliationReadError("incomplete");
            }
            rejects.push({ lineNumber: issue.line_number, sha256: issue.raw_row_sha256 });
          }
        }
        const result = await transaction.request()
          .input("organization", sql.BigInt, organizationId).input("day", sql.Date, reportDay)
          .query(`SELECT CONVERT(VARCHAR(20), user_id) AS user_id, run_id, source_artifact_id,
            interaction_count, code_generation_count, code_acceptance_count,
            CONVERT(VARCHAR(20), loc_suggested_to_add) AS loc_suggested_to_add,
            CONVERT(VARCHAR(20), loc_suggested_to_delete) AS loc_suggested_to_delete,
            CONVERT(VARCHAR(20), loc_added) AS loc_added, CONVERT(VARCHAR(20), loc_deleted) AS loc_deleted,
            CONVERT(VARCHAR(40), ai_credits_used) AS ai_credits_used
            FROM portal.fact_user_daily_usage WHERE organization_id = @organization AND usage_day = @day`);
        const parsedFacts = z.array(factSchema).safeParse(result.recordset);
        if (!parsedFacts.success || parsedFacts.data.some((row) =>
          row.run_id.toLowerCase() !== run.run_id.toLowerCase() || row.source_artifact_id !== observed.artifact?.artifactId)) {
          throw new ReconciliationReadError("incomplete");
        }
        const facts = parsedFacts.data.map((row) => ({
          user_id: row.user_id, ai_credits_used: row.ai_credits_used,
          interaction_count: row.interaction_count, code_generation_count: row.code_generation_count,
          code_acceptance_count: row.code_acceptance_count, loc_suggested_to_add: row.loc_suggested_to_add,
          loc_suggested_to_delete: row.loc_suggested_to_delete, loc_added: row.loc_added, loc_deleted: row.loc_deleted,
        }));
        observed.publishedFacts = { rowCount: facts.length, totals: sumMetrics(facts) };
        if (perUser) observed.perUser = facts;
      }
      await transaction.commit();
      inTransaction = false;
      const archive = blobPath === null ? null : await archiveContainer.getBlobClient(blobPath).downloadToBuffer();
      return { observed, archive, rejects };
    } catch (error) {
      throw readError(error);
    } finally {
      try {
        if (inTransaction && transaction) await transaction.rollback();
      } finally {
        if (pool) await pool.close();
      }
    }
  };
}

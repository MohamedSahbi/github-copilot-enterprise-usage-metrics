import sql from "mssql";
import type { AcquisitionFailure } from "./backfill.js";

export function createMetricsRunStore(sqlConfig: sql.config) {
  return {
    async isComplete(organizationId: number, reportDay: string): Promise<boolean> {
      const pool = await new sql.ConnectionPool(sqlConfig).connect();
      try {
        const result = await pool.request()
          .input("scopeKey", sql.NVarChar(100), String(organizationId))
          .input("reportDay", sql.Date, reportDay)
          .query<{ complete: number }>(`
            SELECT 1 AS complete FROM portal.IngestionRun
            WHERE source_kind = 'users_1_day' AND scope_key = @scopeKey AND report_day = @reportDay
              AND is_current = 1 AND status = 'published'
              AND rows_read > 0 AND rows_read = rows_loaded AND rows_quarantined = 0`);
        return result.recordset.length === 1;
      } finally {
        await pool.close();
      }
    },
    async recordFailure(failure: AcquisitionFailure): Promise<void> {
      const pool = await new sql.ConnectionPool(sqlConfig).connect();
      try {
        await pool.request()
          .input("runId", sql.UniqueIdentifier, failure.runId)
          .input("scopeKey", sql.NVarChar(100), failure.organizationId === undefined
            ? `org:${failure.organizationLogin.toLowerCase()}` : String(failure.organizationId))
          .input("reportDay", sql.Date, failure.reportDay)
          .input("errorCode", sql.VarChar(64), failure.errorCode)
          .input("correlationId", sql.VarChar(64), failure.correlationId)
          .query(`
            INSERT INTO portal.IngestionRun
              (run_id, source_kind, scope_key, report_day, status, transform_version,
               error_code, correlation_id, completed_at)
            VALUES (@runId, 'users_1_day', @scopeKey, @reportDay, 'failed', '1',
              @errorCode, @correlationId, SYSUTCDATETIME())`);
      } finally {
        await pool.close();
      }
    },
  };
}

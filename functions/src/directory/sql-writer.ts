import sql from "mssql";
import { writeDirectoryUsers } from "../ingestion/user-writer.js";
import type { DirectoryWriter } from "./sync.js";

export class DirectoryWriteError extends Error {
  constructor(code: "directory_write_failed" | "directory_rollback_failed") {
    super(code);
    this.name = "DirectoryWriteError";
  }
}

// The caller supplies a transaction on its already connected, explicitly configured new-database pool.
export function createDirectorySqlWriter(createTransaction: () => sql.Transaction): DirectoryWriter {
  return {
    async commit({ run, users, sync, managerCheckUserIds }) {
      const transaction = createTransaction();
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        const lock = await transaction.request().query<{ result: number }>(`
          DECLARE @result INT;
          EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
            @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
          SELECT @result AS result`);
        const lockResult = lock.recordset[0]?.result;
        if (lockResult === undefined || lockResult < 0) throw new DirectoryWriteError("directory_write_failed");
        await transaction.request()
          .input("runId", sql.UniqueIdentifier, run.run_id)
          .input("scope", sql.NVarChar(100), run.scope_key)
          .input("status", sql.VarChar(16), run.status)
          .input("version", sql.VarChar(32), run.transform_version)
          .input("rowsRead", sql.Int, run.rows_read)
          .input("rowsLoaded", sql.Int, run.rows_loaded)
          .input("rowsQuarantined", sql.Int, run.rows_quarantined)
          .input("errorCode", sql.VarChar(64), run.error_code)
          .input("correlationId", sql.VarChar(64), run.correlation_id)
          .input("startedAt", sql.DateTime2, run.started_at)
          .input("completedAt", sql.DateTime2, run.completed_at)
          .query(`
            INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current,
              transform_version, rows_read, rows_loaded, rows_quarantined, error_code, correlation_id, started_at, completed_at)
            VALUES (@runId, 'directory', @scope, NULL, @status, 0, @version,
              @rowsRead, @rowsLoaded, @rowsQuarantined, @errorCode, @correlationId, @startedAt, @completedAt)`);
        if (managerCheckUserIds.length > 0) {
          await transaction.request()
            .input("managerCheckUserIds", sql.NVarChar(sql.MAX), JSON.stringify(managerCheckUserIds))
            .query(`
              UPDATE portal.dim_user WITH (UPDLOCK, HOLDLOCK)
              SET manager_resolved = 0, manager_checked_at = SYSUTCDATETIME()
              WHERE user_id IN (
                SELECT user_id FROM OPENJSON(@managerCheckUserIds) WITH (user_id BIGINT '$')
              )`);
        }
        await writeDirectoryUsers(transaction, users);
        for (const state of sync) {
          await transaction.request()
            .input("source", sql.VarChar(16), state.source)
            .input("lastSuccess", sql.DateTime2, state.last_success_at)
            .input("lastAttempt", sql.DateTime2, state.last_attempt_at)
            .input("errorCode", sql.VarChar(64), state.last_error_code)
            .input("startedAt", sql.DateTime2, run.started_at)
            .query(`
              UPDATE portal.DirectorySyncState WITH (UPDLOCK, HOLDLOCK)
              SET last_success_at = COALESCE(@lastSuccess, last_success_at),
                  last_attempt_at = @lastAttempt, last_error_code = @errorCode
              WHERE source = @source
                AND (last_attempt_at IS NULL OR last_attempt_at < CONVERT(datetime2(0), @startedAt));
              IF @@ROWCOUNT = 0
              BEGIN
                IF EXISTS (SELECT 1 FROM portal.DirectorySyncState WITH (UPDLOCK, HOLDLOCK) WHERE source = @source)
                  THROW 51000, 'DIRECTORY_STALE_SNAPSHOT', 1;
                INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at, last_error_code)
                VALUES (@source, @lastSuccess, @lastAttempt, @errorCode);
              END`);
        }
        await transaction.commit();
      } catch {
        try {
          await transaction.rollback();
        } catch {
          throw new DirectoryWriteError("directory_rollback_failed");
        }
        throw new DirectoryWriteError("directory_write_failed");
      }
    },
  };
}

import sql from "mssql";
import { directoryIdentityConflict, writeDirectoryUsers } from "../ingestion/user-writer.js";
import { applyDirectoryRevocations, readPreviousStates, revocationCandidates } from "./revocation.js";
import type { DirectoryWriter } from "./sync.js";

export class DirectoryWriteError extends Error {
  constructor(code: "directory_write_failed" | "directory_rollback_failed") {
    super(code);
    this.name = "DirectoryWriteError";
  }
}

// Each phase uses the same connected new-database pool and global directory lock.
// Soft revocation (#76) needs the Entra tenant that grants and links are keyed on; without it, none is written.
export function createDirectorySqlWriter(
  createTransaction: () => sql.Transaction,
  options: { entraTenantId?: string | null } = {},
): DirectoryWriter {
  async function transact(write: (transaction: sql.Transaction) => Promise<void>): Promise<void> {
    const transaction = createTransaction();
    let active = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      active = true;
      const lock = await transaction.request().query<{ result: number }>(`
        DECLARE @result INT;
        EXEC @result = sys.sp_getapplock @Resource = N'ingest:directory',
          @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
        SELECT @result AS result`);
      const lockResult = lock.recordset[0]?.result;
      if (lockResult === undefined || lockResult < 0) throw new DirectoryWriteError("directory_write_failed");
      await write(transaction);
      await transaction.commit();
    } catch {
      if (active) {
        try {
          await transaction.rollback();
        } catch {
          throw new DirectoryWriteError("directory_rollback_failed");
        }
      }
      throw new DirectoryWriteError("directory_write_failed");
    }
  }

  return {
    async commit({ run, users, sync, managerCheckUserIds }) {
      if (run.completed_at === null || sync.length === 0) throw new DirectoryWriteError("directory_write_failed");
      let hasIdentityConflict = false;
      await transact(async (transaction) => {
        // Strict second-precision ordering also prevents two reservations sharing a rounded start.
        await transaction.request().input("startedAt", sql.DateTime2, run.started_at).query(`
          IF EXISTS (SELECT 1 FROM portal.IngestionRun WITH (UPDLOCK, HOLDLOCK)
                     WHERE source_kind = 'directory' AND started_at >= CONVERT(datetime2(0), @startedAt))
            THROW 51000, 'DIRECTORY_STALE_SNAPSHOT', 1`);
        const conflicts = (await transaction.request()
          .input("candidates", sql.NVarChar(sql.MAX), JSON.stringify(users.map(({ user }) => ({
            user_id: user.user_id, entra_object_id: user.entra_object_id,
          }))))
          .query<{ user_id: number | string }>(`
            SELECT candidate.user_id
            FROM OPENJSON(@candidates) WITH (user_id BIGINT '$.user_id', entra_object_id UNIQUEIDENTIFIER '$.entra_object_id') AS candidate
            WHERE ${directoryIdentityConflict("row")}`)).recordset;
        const conflictingIds = new Set(conflicts.map(({ user_id }) => String(user_id)));
        hasIdentityConflict = conflictingIds.size > 0;
        const resolvedIds = new Set(users.filter(({ user, managerResolved }) =>
          managerResolved && !conflictingIds.has(String(user.user_id))).map(({ user }) => user.user_id));
        const unresolvedIds = new Set(managerCheckUserIds.filter((id) => !resolvedIds.has(id)));
        for (const { user, managerResolved } of users) {
          if (!managerResolved || conflictingIds.has(String(user.user_id))) unresolvedIds.add(user.user_id);
        }
        const incomplete = run.status === "failed" || hasIdentityConflict || unresolvedIds.size > 0;
        const errorCode = incomplete ? run.error_code ?? "directory_write_failed" : null;
        await transaction.request()
          .input("runId", sql.UniqueIdentifier, run.run_id)
          .input("scope", sql.NVarChar(100), run.scope_key)
          .input("status", sql.VarChar(16), incomplete ? "failed" : "started")
          .input("version", sql.VarChar(32), run.transform_version)
          .input("rowsRead", sql.Int, run.rows_read)
          .input("rowsQuarantined", sql.Int, run.rows_quarantined)
          .input("errorCode", sql.VarChar(64), errorCode)
          .input("correlationId", sql.VarChar(64), run.correlation_id)
          .input("startedAt", sql.DateTime2, run.started_at)
          .input("completedAt", sql.DateTime2, incomplete ? run.completed_at : null)
          .query(`
            INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current,
              transform_version, rows_read, rows_loaded, rows_quarantined, error_code, correlation_id, started_at, completed_at)
            VALUES (@runId, 'directory', @scope, NULL, @status, 0, @version,
              @rowsRead, 0, @rowsQuarantined, @errorCode, @correlationId, @startedAt, @completedAt)`);
        for (const state of sync) {
          await transaction.request()
            .input("source", sql.VarChar(16), state.source)
            .input("lastAttempt", sql.DateTime2, state.last_attempt_at)
            .input("errorCode", sql.VarChar(64), errorCode)
            .input("startedAt", sql.DateTime2, run.started_at)
            .query(`
              UPDATE portal.DirectorySyncState WITH (UPDLOCK, HOLDLOCK)
              SET last_attempt_at = @lastAttempt, last_error_code = @errorCode
              WHERE source = @source
                AND (last_attempt_at IS NULL OR last_attempt_at < CONVERT(datetime2(0), @startedAt));
              IF @@ROWCOUNT = 0
              BEGIN
                IF EXISTS (SELECT 1 FROM portal.DirectorySyncState WITH (UPDLOCK, HOLDLOCK) WHERE source = @source)
                  THROW 51000, 'DIRECTORY_STALE_SNAPSHOT', 1;
                INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at, last_error_code)
                VALUES (@source, NULL, @lastAttempt, @errorCode);
              END`);
        }
        if (unresolvedIds.size > 0) {
          await transaction.request()
            .input("unresolvedIds", sql.NVarChar(sql.MAX), JSON.stringify([...unresolvedIds]))
            .query(`
              UPDATE portal.dim_user WITH (UPDLOCK, HOLDLOCK)
              SET manager_resolved = 0, manager_checked_at = SYSUTCDATETIME()
              WHERE user_id IN (SELECT user_id FROM OPENJSON(@unresolvedIds) WITH (user_id BIGINT '$'))`);
        }
      });
      if (hasIdentityConflict) throw new DirectoryWriteError("directory_write_failed");

      // Negative evidence survives publication rollback; success still publishes atomically.
      await transact(async (transaction) => {
        await transaction.request()
          .input("runId", sql.UniqueIdentifier, run.run_id)
          .input("sources", sql.NVarChar(sql.MAX), JSON.stringify(sync.map(({ source }) => source)))
          .input("lastAttempt", sql.DateTime2, run.completed_at)
          .query(`
            DECLARE @owner UNIQUEIDENTIFIER = (
              SELECT TOP (1) run_id FROM portal.IngestionRun WITH (UPDLOCK, HOLDLOCK)
              WHERE source_kind = 'directory' ORDER BY started_at DESC, run_id DESC);
            IF @owner IS NULL OR @owner <> @runId
              OR NOT EXISTS (SELECT 1 FROM portal.IngestionRun WHERE run_id = @runId AND status IN ('started', 'failed'))
              OR EXISTS (
                SELECT 1 FROM OPENJSON(@sources) WITH (source VARCHAR(16) '$') AS required
                LEFT JOIN portal.DirectorySyncState AS state WITH (UPDLOCK, HOLDLOCK)
                  ON state.source = required.source AND state.last_attempt_at = CONVERT(datetime2(0), @lastAttempt)
                WHERE state.source IS NULL)
              THROW 51000, 'DIRECTORY_STALE_SNAPSHOT', 1`);
        const previousStates = await readPreviousStates(transaction, users);
        await writeDirectoryUsers(transaction, users);
        if (run.status === "published" && options.entraTenantId) {
          await applyDirectoryRevocations(transaction, {
            candidates: revocationCandidates(users, previousStates),
            tenantId: options.entraTenantId, runId: run.run_id, correlationId: run.correlation_id,
          });
        }
        for (const state of sync) {
          await transaction.request()
            .input("source", sql.VarChar(16), state.source)
            .input("lastSuccess", sql.DateTime2, state.last_success_at)
            .input("errorCode", sql.VarChar(64), state.last_error_code)
            .query(`
              UPDATE portal.DirectorySyncState
              SET last_success_at = COALESCE(@lastSuccess, last_success_at), last_error_code = @errorCode
              WHERE source = @source`);
        }
        await transaction.request()
          .input("runId", sql.UniqueIdentifier, run.run_id)
          .input("status", sql.VarChar(16), run.status)
          .input("rowsLoaded", sql.Int, run.rows_loaded)
          .input("errorCode", sql.VarChar(64), run.error_code)
          .input("completedAt", sql.DateTime2, run.completed_at)
          .query(`
            UPDATE portal.IngestionRun SET status = @status, rows_loaded = @rowsLoaded,
              error_code = @errorCode, completed_at = @completedAt WHERE run_id = @runId`);
      });
    },
  };
}

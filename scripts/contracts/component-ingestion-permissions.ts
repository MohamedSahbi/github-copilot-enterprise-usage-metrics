import { randomBytes, randomUUID } from "node:crypto";

export interface ComponentIngestionPermissionHarness {
  execute(statement: string): Promise<void>;
  expectDenied(statement: string): Promise<void>;
  expectError(statement: string, message: RegExp): Promise<void>;
}

function testSuffix(): string {
  return randomBytes(5).toString("hex");
}

function dailyRow(
  runId: string,
  artifactId: string,
  line: number,
  organizationId: number,
  userId: number,
  login: string | null,
  day: string,
): string {
  const escapedLogin = login === null ? "NULL" : `N'${login}'`;
  const metricValues = Array.from({ length: 17 }, () => "0").join(", ");
  return `('${runId}', ${artifactId}, ${line}, ${organizationId}, NULL, ${userId}, ${escapedLogin}, '${day}',
    ${metricValues}, NULL, NULL, NULL, NULL)`;
}

function expectFailureAs(user: string, statement: string): string {
  return `
    EXECUTE AS USER = '${user}';
    BEGIN TRY
      ${statement};
      REVERT;
      THROW 50128, N'Expected the impersonated operation to fail', 1;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
      IF USER_NAME() = N'${user}' REVERT;
      IF ERROR_NUMBER() = 50128 THROW;
      THROW;
    END CATCH;
  `;
}

export async function assertComponentIngestionPermissions(
  harness: ComponentIngestionPermissionHarness,
): Promise<void> {
  const suffix = testSuffix();
  const metricsUser = `contract_metrics_${suffix}`;
  const directoryUser = `contract_directory_${suffix}`;
  const runId = randomUUID();
  const emptyRunId = randomUUID();
  const directoryRunId = randomUUID();
  const nullObservationRunId = randomUUID();
  const wrongSourceRunId = randomUUID();
  const rollbackRunId = randomUUID();
  const conflictEntraId = randomUUID();
  const organizationId = 9_000_000_000 + randomBytes(3).readUIntBE(0, 3);
  const directoryUserId = 8_000_000_000_000 + randomBytes(3).readUIntBE(0, 3);
  const newUserId = directoryUserId + 1;
  const nullableLoginUserId = directoryUserId + 2;
  const rolledBackUserId = directoryUserId + 3;
  const entraId = randomUUID();
  const managerId = randomUUID();

  await harness.execute(`
    CREATE USER [${metricsUser}] WITHOUT LOGIN;
    ALTER ROLE portal_metrics_ingest ADD MEMBER [${metricsUser}];
    CREATE USER [${directoryUser}] WITHOUT LOGIN;
    ALTER ROLE portal_directory_ingest ADD MEMBER [${directoryUser}];

    EXECUTE AS USER = '${metricsUser}';
    IF HAS_PERMS_BY_NAME(N'portal.IngestionRun', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.IngestionRun', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.IngestionRun', N'OBJECT', N'UPDATE') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.SourceArtifact', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.SourceArtifact', N'OBJECT', N'SELECT', N'artifact_id', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.SourceCheckpoint', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.SourceCheckpoint', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.SourceCheckpoint', N'OBJECT', N'UPDATE') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.ValidationIssue', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_daily', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_daily', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_breakdown', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_breakdown', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_family_count', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.stg_user_family_count', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_organization', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_organization', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_organization', N'OBJECT', N'UPDATE', N'login', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_organization', N'OBJECT', N'UPDATE', N'updated_at', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user_login_history', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user_login_history', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user_login_history', N'OBJECT', N'UPDATE', N'first_seen_day', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user_login_history', N'OBJECT', N'UPDATE', N'last_seen_day', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'UPDATE', N'is_chat', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'UPDATE', N'is_agent', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'UPDATE', N'is_cli', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'UPDATE', N'chat_mode_bucket', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_feature', N'OBJECT', N'UPDATE', N'is_known', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_model', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_model', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_client', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_client', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_language', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_language', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.fact_user_daily_usage', N'OBJECT', N'SELECT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.fact_user_daily_usage', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.fact_user_daily_usage', N'OBJECT', N'DELETE') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.fact_usage_breakdown', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.fact_usage_family_count', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.agg_daily_usage', N'OBJECT', N'INSERT') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.agg_daily_usage', N'OBJECT', N'DELETE') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.agg_daily_usage', N'OBJECT', N'SELECT', N'organization_id', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.agg_daily_usage', N'OBJECT', N'SELECT', N'usage_day', N'COLUMN') <> 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'INSERT') = 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'UPDATE') = 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'DELETE') = 1
      OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'UPDATE', N'email', N'COLUMN') = 1
    BEGIN
      REVERT;
      THROW 50142, N'Metrics role does not have the approved permission boundary', 1;
    END;
    REVERT;

    INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, transform_version)
      VALUES ('${runId}', 'users_1_day', N'${organizationId}', 'staged', '1'),
             ('${emptyRunId}', 'users_1_day', N'${organizationId}', 'staged', '1'),
             ('${nullObservationRunId}', 'users_1_day', N'${organizationId}', 'staged', '1'),
             ('${rollbackRunId}', 'users_1_day', N'${organizationId}', 'staged', '1'),
             ('${wrongSourceRunId}', 'directory', N'fixture', 'staged', '1');
    INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
      VALUES ('${runId}', N'fixture', N'contract/${suffix}.ndjson', REPLICATE('0', 64), 1);
    INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
      VALUES ('${rollbackRunId}', N'fixture', N'contract/${suffix}-rollback.ndjson', REPLICATE('1', 64), 1);
    INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
      VALUES ('${nullObservationRunId}', N'fixture', N'contract/${suffix}-null-login.ndjson', REPLICATE('2', 64), 1);
    DECLARE @artifact_id BIGINT = (SELECT artifact_id FROM portal.SourceArtifact WHERE run_id = '${runId}');
    DECLARE @rollback_artifact_id BIGINT = (SELECT artifact_id FROM portal.SourceArtifact WHERE run_id = '${rollbackRunId}');
    DECLARE @null_observation_artifact_id BIGINT = (
      SELECT artifact_id FROM portal.SourceArtifact WHERE run_id = '${nullObservationRunId}'
    );

    EXECUTE AS USER = '${directoryUser}';
    INSERT INTO portal.dim_user (
      user_id, login, email, display_name, entra_object_id, state, first_seen_day, last_seen_day,
      department, business_area, manager_entra_object_id, manager_email, manager_resolved, manager_checked_at
    ) VALUES (
      ${directoryUserId}, N'directory-login', N'directory@example.invalid', N'Directory Fixture',
      '${entraId}', 'active', NULL, NULL, N'engineering', N'example area',
      '${managerId}', N'manager@example.invalid', 1, '2026-10-27T09:00:00'
    );
    UPDATE portal.dim_user SET manager_resolved = 0, manager_checked_at = '2026-10-27T09:01:00'
      WHERE user_id = ${directoryUserId};
    UPDATE portal.dim_user
      SET login = N'directory-login-updated', email = N'directory-updated@example.invalid',
        display_name = N'Directory Updated', entra_object_id = '${entraId}', state = 'active',
        deleted_at = NULL, department = N'updated department', business_area = N'updated area',
        manager_entra_object_id = '${managerId}', manager_email = N'manager-updated@example.invalid',
        manager_resolved = 1, manager_checked_at = '2026-10-27T09:02:00'
      WHERE user_id = ${directoryUserId} AND entra_object_id = '${entraId}';
    IF NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE user_id = ${directoryUserId} AND manager_resolved = 1
        AND manager_checked_at = '2026-10-27T09:02:00'
    ) THROW 50138, N'Directory role could not record a successful manager resolution', 1;
    UPDATE portal.dim_user SET manager_resolved = 0, manager_checked_at = '2026-10-27T09:03:00'
      WHERE user_id = ${directoryUserId};
    IF NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE user_id = ${directoryUserId} AND manager_resolved = 0
        AND manager_checked_at = '2026-10-27T09:03:00'
        AND manager_entra_object_id = '${managerId}' AND manager_email = N'manager-updated@example.invalid'
    ) THROW 50139, N'Directory negative marker changed cached manager adjacency', 1;
    UPDATE portal.dim_user
      SET entra_object_id = '${conflictEntraId}'
      WHERE user_id = ${directoryUserId}
        AND (entra_object_id IS NULL OR entra_object_id = '${conflictEntraId}')
        AND NOT EXISTS (
          SELECT 1 FROM portal.dim_user
          WHERE entra_object_id = '${conflictEntraId}' AND user_id <> ${directoryUserId}
        );
    IF NOT EXISTS (SELECT 1 FROM portal.dim_user WHERE user_id = ${directoryUserId} AND entra_object_id = '${entraId}')
      THROW 50131, N'The directory identity guard allowed a numeric user to be rebound', 1;
    INSERT INTO portal.dim_user (user_id, entra_object_id)
    SELECT ${directoryUserId + 10}, '${entraId}'
    WHERE NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE entra_object_id = '${entraId}' AND user_id <> ${directoryUserId + 10}
    );
    IF EXISTS (SELECT 1 FROM portal.dim_user WHERE user_id = ${directoryUserId + 10})
      THROW 50133, N'The directory identity guard allowed an Entra ID to be rebound', 1;
    INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, status, transform_version)
      VALUES ('${directoryRunId}', 'directory', N'fixture', 'started', '1');
    UPDATE portal.IngestionRun
      SET status = 'published', rows_loaded = 1, completed_at = '2026-10-27T09:03:00'
      WHERE run_id = '${directoryRunId}' AND source_kind = 'directory';
    INSERT INTO portal.DirectorySyncState (source, last_attempt_at) VALUES ('graph', SYSUTCDATETIME());
    UPDATE portal.DirectorySyncState SET last_error_code = 'fixture_error' WHERE source = 'graph';
    BEGIN TRANSACTION;
    UPDATE portal.dim_user SET manager_resolved = 0, manager_checked_at = '2026-10-27T09:04:00'
      WHERE user_id = ${directoryUserId};
    ROLLBACK TRANSACTION;
    REVERT;

    INSERT INTO portal.stg_user_daily (
      run_id, artifact_id, line_number, organization_id, enterprise_id, user_id, user_login, usage_day,
      interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add,
      loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
      used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent,
      used_code_review_active, used_code_review_passive, ai_credits_used,
      ai_adoption_phase_number, ai_adoption_phase, extra_json, ai_adoption_phase_version
    ) VALUES
      ${dailyRow(runId, "@artifact_id", 1, organizationId, directoryUserId, "a-metric-login", "2026-03-02")},
      ${dailyRow(runId, "@artifact_id", 2, organizationId, directoryUserId, "z-metric-login", "2026-03-09")},
      ${dailyRow(runId, "@artifact_id", 3, organizationId, nullableLoginUserId, null, "2026-03-04")},
      ${dailyRow(runId, "@artifact_id", 4, organizationId, newUserId, "a-metric-login", "2026-03-01")},
      ${dailyRow(runId, "@artifact_id", 5, organizationId, newUserId, "z-metric-login", "2026-03-09")},
      ${dailyRow(nullObservationRunId, "@null_observation_artifact_id", 1, organizationId, directoryUserId, null, "2026-03-01")},
      ${dailyRow(rollbackRunId, "@rollback_artifact_id", 1, organizationId, rolledBackUserId, "rollback-login", "2026-03-05")};
  `);

  await harness.execute(`
    EXECUTE AS USER = '${metricsUser}';
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
    DECLARE @lock_result INT;
    EXEC @lock_result = sys.sp_getapplock @Resource = N'ingest:users_1_day:${organizationId}:2026-03-09',
      @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
    IF @lock_result < 0 THROW 50120, N'Could not acquire the synthetic caller day lock', 1;
    BEGIN TRANSACTION;
    EXEC portal.usp_write_metrics_users @run_id = '${runId}';
    EXEC portal.usp_write_metrics_users @run_id = '${runId}';
    EXEC portal.usp_write_metrics_users @run_id = '${nullObservationRunId}';
    EXEC portal.usp_write_metrics_users @run_id = '${emptyRunId}';
    DELETE FROM portal.agg_daily_usage
      WHERE organization_id = ${organizationId} AND usage_day = '2026-03-09';
    IF APPLOCK_MODE('public', N'ingest:users_1_day:${organizationId}:2026-03-09', 'Session') <> 'Exclusive'
      THROW 50121, N'The metrics procedure changed the caller day lock', 1;
    COMMIT TRANSACTION;
    EXEC sys.sp_releaseapplock @Resource = N'ingest:users_1_day:${organizationId}:2026-03-09', @LockOwner = 'Session';
    REVERT;
  `);

  await harness.execute(`
    IF NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE user_id = ${directoryUserId} AND login = N'z-metric-login'
        AND first_seen_day = '2026-03-01' AND last_seen_day = '2026-03-02'
        AND email = N'directory-updated@example.invalid' AND display_name = N'Directory Updated'
        AND entra_object_id = '${entraId}' AND state = 'active'
        AND department = N'updated department' AND business_area = N'updated area'
        AND manager_entra_object_id = '${managerId}' AND manager_email = N'manager-updated@example.invalid'
        AND manager_resolved = 0 AND manager_checked_at = '2026-10-27T09:03:00'
    ) THROW 50122, N'Metrics changed directory-owned attributes or failed to preserve observed values', 1;
    IF NOT EXISTS (
      SELECT 1 FROM portal.IngestionRun
      WHERE run_id = '${directoryRunId}' AND status = 'published' AND rows_loaded = 1
        AND completed_at = '2026-10-27T09:03:00'
    ) THROW 50134, N'Directory role could not complete its run-store write', 1;
    IF NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE user_id = ${newUserId} AND login = N'z-metric-login'
        AND first_seen_day = '2026-03-01' AND last_seen_day = '2026-03-01'
        AND state = 'active' AND manager_resolved = 0 AND manager_checked_at IS NULL
        AND entra_object_id IS NULL AND email IS NULL AND department IS NULL
    ) THROW 50123, N'Metrics did not create an observation-only user with trusted defaults', 1;
    IF NOT EXISTS (
      SELECT 1 FROM portal.dim_user
      WHERE user_id = ${nullableLoginUserId} AND login IS NULL
        AND first_seen_day = '2026-03-04' AND last_seen_day = '2026-03-04'
    ) THROW 50124, N'Metrics did not preserve nullable login and observed-day semantics', 1;
  `);

  await harness.expectError(expectFailureAs(metricsUser, `
    SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
    BEGIN TRANSACTION;
    EXEC portal.usp_write_metrics_users @run_id = '${runId}';
  `), /requires SERIALIZABLE/i);

  await harness.expectError(expectFailureAs(metricsUser, `
    EXEC portal.usp_write_metrics_users @run_id = '${runId}';
  `), /requires the caller publication transaction/i);

  await harness.expectError(expectFailureAs(metricsUser, `
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
    BEGIN TRANSACTION;
    EXEC portal.usp_write_metrics_users @run_id = '${wrongSourceRunId}';
  `), /users_1_day ingestion run/i);

  await harness.execute(`
    EXECUTE AS USER = '${metricsUser}';
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
    BEGIN TRANSACTION;
    EXEC portal.usp_write_metrics_users @run_id = '${rollbackRunId}';
    ROLLBACK TRANSACTION;
    REVERT;
    IF EXISTS (SELECT 1 FROM portal.dim_user WHERE user_id = ${rolledBackUserId})
      THROW 50127, N'The metrics procedure committed or escaped the caller transaction', 1;
  `);

  const deniedStatements = [
    `INSERT INTO portal.dim_user (user_id) VALUES (${rolledBackUserId})`,
    `INSERT INTO portal.dim_user (user_id, entra_object_id, email, display_name, state, deleted_at, pii_purged_at,
      department, business_area, manager_entra_object_id, manager_email, manager_resolved, manager_checked_at)
      VALUES (${rolledBackUserId}, '${randomUUID()}', N'x', N'x', 'active', NULL, NULL, N'x', N'x',
        '${randomUUID()}', N'x', 1, SYSUTCDATETIME())`,
    `INSERT INTO portal.dim_user (user_id) SELECT ${rolledBackUserId}`,
    "BULK INSERT portal.dim_user FROM '/dev/null' WITH (DATAFILETYPE = 'char')",
    `UPDATE portal.dim_user SET entra_object_id = '${randomUUID()}' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET email = N'changed' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET display_name = N'changed' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET state = 'suspended' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET deleted_at = SYSUTCDATETIME() WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET pii_purged_at = SYSUTCDATETIME() WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET department = N'changed' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET business_area = N'changed' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET manager_entra_object_id = '${randomUUID()}' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET manager_email = N'changed' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET manager_resolved = 1 WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET manager_checked_at = SYSUTCDATETIME() WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET login = N'metrics-direct-write' WHERE user_id = ${directoryUserId}`,
    `UPDATE portal.dim_user SET first_seen_day = '2026-03-01' WHERE user_id = ${directoryUserId}`,
    `DELETE FROM portal.dim_user WHERE user_id = ${directoryUserId}`,
    `MERGE portal.dim_user AS target USING (SELECT ${directoryUserId} AS user_id) AS source
      ON target.user_id = source.user_id WHEN MATCHED THEN UPDATE SET manager_resolved = 1;`,
    `EXEC portal.usp_write_metrics_users @run_id = '${runId}', @directory_fields = N'email'`,
    "ALTER TABLE portal.dim_user ADD contract_forbidden_column INT NULL",
    "EXEC(N'ALTER PROCEDURE portal.usp_write_metrics_users @run_id UNIQUEIDENTIFIER AS SELECT 1')",
    "EXEC portal.usp_purge_login_history @max_age_months = 24",
    "EXEC portal.usp_link_principal_entra @principal_id = '00000000-0000-4000-8000-000000000001', @entra_tenant_id = '00000000-0000-4000-8000-000000000002', @entra_object_id = '00000000-0000-4000-8000-000000000003'",
    "SELECT * FROM portal.DirectorySyncState",
    "UPDATE portal.SourceArtifact SET row_count = 0",
    "DELETE FROM portal.SourceArtifact",
    "SELECT blob_path FROM portal.SourceArtifact",
    "SELECT user_count FROM portal.agg_daily_usage",
    `DELETE FROM portal.dim_user_login_history WHERE user_id = ${directoryUserId}`,
  ];
  for (const statement of deniedStatements) {
    if (statement.startsWith("EXEC portal.usp_write_metrics_users @run_id = '")) {
      await harness.expectError(expectFailureAs(metricsUser, statement), /too many arguments/i);
    } else {
      await harness.expectDenied(expectFailureAs(metricsUser, statement));
    }
  }

  await harness.expectDenied(expectFailureAs(directoryUser,
    `EXEC portal.usp_write_metrics_users @run_id = '${runId}'`));
  await harness.expectDenied(expectFailureAs(directoryUser, "SELECT * FROM portal.dim_user_login_history"));
  for (const table of ["stg_user_daily", "fact_user_daily_usage", "dim_organization", "SourceArtifact"]) {
    await harness.expectDenied(expectFailureAs(directoryUser, `SELECT * FROM portal.${table}`));
  }
  await harness.expectDenied(expectFailureAs(directoryUser,
    `UPDATE portal.dim_user SET first_seen_day = '2026-01-01' WHERE user_id = ${directoryUserId}`));
  await harness.expectDenied(expectFailureAs(directoryUser,
    `UPDATE portal.dim_user SET last_seen_day = '2026-01-01' WHERE user_id = ${directoryUserId}`));
  await harness.expectDenied(expectFailureAs(directoryUser,
    `UPDATE portal.dim_user SET pii_purged_at = SYSUTCDATETIME() WHERE user_id = ${directoryUserId}`));
  await harness.expectError(expectFailureAs(directoryUser,
    `INSERT INTO portal.dim_user (user_id) VALUES (${directoryUserId})`),
  /unique|duplicate/i);

  for (const user of [metricsUser, directoryUser]) {
    for (const table of [
      "Principal", "PrincipalIdentity", "AccessGrant", "PrincipalLinkState", "GrantRevocation",
      "FeedbackItem", "FeedbackVote", "FeedbackComment", "AuditLog", "IngestionAuditEvent", "IssueAction",
    ]) {
      await harness.expectDenied(expectFailureAs(user, `SELECT * FROM portal.${table}`));
    }
    await harness.expectDenied(expectFailureAs(user,
      "CREATE TABLE portal.forbidden_runtime_table (id INT)"));
    await harness.expectDenied(expectFailureAs(user,
      "ALTER TABLE portal.dim_user ADD forbidden_runtime_column INT"));
  }

  const unsafeUser = `contract_unsafe_${suffix}`;
  const columnGrantRole = `contract_column_writer_${suffix}`;
  const nestedRole = `contract_nested_writer_${suffix}`;
  await harness.execute(`
    CREATE USER [${unsafeUser}] WITHOUT LOGIN;
    ALTER ROLE portal_metrics_ingest ADD MEMBER [${unsafeUser}];
    CREATE ROLE [${columnGrantRole}] AUTHORIZATION dbo;
    CREATE ROLE [${nestedRole}] AUTHORIZATION dbo;
    GRANT UPDATE (email) ON OBJECT::portal.dim_user TO [${columnGrantRole}];
    ALTER ROLE [${columnGrantRole}] ADD MEMBER [${unsafeUser}];
    ALTER ROLE [${nestedRole}] ADD MEMBER [${columnGrantRole}];
    GRANT EXECUTE ON OBJECT::portal.usp_purge_login_history TO [${unsafeUser}];
    GRANT IMPERSONATE ON USER::dbo TO [${unsafeUser}];

    IF IS_ROLEMEMBER(N'public', N'${unsafeUser}') <> 1
      THROW 50135, N'Effective-permission preflight failed to account for PUBLIC', 1;
    DECLARE @nested_role_detected BIT = 0;
    ;WITH role_closure AS (
      SELECT rm.role_principal_id
      FROM sys.database_role_members AS rm
      WHERE rm.member_principal_id = DATABASE_PRINCIPAL_ID(N'${unsafeUser}')
      UNION ALL
      SELECT rm.role_principal_id
      FROM sys.database_role_members AS rm
      JOIN role_closure AS parent_role ON parent_role.role_principal_id = rm.member_principal_id
    )
    SELECT @nested_role_detected = 1
    FROM role_closure AS rc
    JOIN sys.database_principals AS r ON r.principal_id = rc.role_principal_id
    WHERE r.name = N'${nestedRole}';
    IF @nested_role_detected <> 1
      THROW 50136, N'Effective-permission preflight failed to detect a recursive role', 1;
    IF NOT EXISTS (
      SELECT 1 FROM sys.database_permissions
      WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(N'${columnGrantRole}')
        AND class = 1 AND major_id = OBJECT_ID(N'portal.dim_user')
        AND minor_id = COLUMNPROPERTY(OBJECT_ID(N'portal.dim_user'), N'email', 'ColumnId')
        AND permission_name = N'UPDATE' AND state = 'G'
    )
      THROW 50137, N'Effective-permission preflight failed to detect a column-level grant', 1;
    IF NOT EXISTS (
      SELECT 1 FROM sys.database_permissions
      WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(N'${unsafeUser}')
        AND class = 1 AND major_id = OBJECT_ID(N'portal.usp_purge_login_history')
        AND permission_name = N'EXECUTE' AND state = 'G'
    )
      THROW 50140, N'Effective-permission preflight failed to detect a direct object grant', 1;
    IF NOT EXISTS (
      SELECT 1 FROM sys.database_permissions
      WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(N'${unsafeUser}')
        AND class = 4 AND major_id = DATABASE_PRINCIPAL_ID(N'dbo')
        AND permission_name = N'IMPERSONATE' AND state = 'G'
    )
      THROW 50143, N'Effective-permission preflight failed to detect a direct impersonation grant', 1;
    EXECUTE AS USER = N'${unsafeUser}';
    EXECUTE AS USER = N'dbo';
    IF USER_NAME() <> N'dbo'
      THROW 50144, N'The synthetic impersonation path was not effective', 1;
    REVERT;
    IF USER_NAME() <> N'${unsafeUser}'
      THROW 50145, N'The synthetic impersonation path did not revert to its caller', 1;
    REVERT;

    EXECUTE AS USER = N'${unsafeUser}';
    IF HAS_PERMS_BY_NAME(N'portal.usp_purge_login_history', N'OBJECT', N'EXECUTE') <> 1
      THROW 50141, N'Effective-permission preflight failed to detect an inherited execute path', 1;
    REVERT;
  `);
  await harness.expectDenied(expectFailureAs(unsafeUser,
    `UPDATE portal.dim_user SET email = N'unsafe' WHERE user_id = ${directoryUserId}`));
}

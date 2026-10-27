-- Migration: component-scoped ingestion access. The logical ingestion component remains the sole writer of
-- portal.dim_user and portal.dim_user_login_history (D-34); metrics uses the fixed procedure for dim_user.
--
-- Writers:
--   portal.dim_user: ingestion (directory attributes directly; metrics observations through usp_write_metrics_users)
--   portal.dim_user_login_history: ingestion
--
-- Component roles are not identity mappings. Operators must remove component identities from portal_ingest and
-- validate their complete effective permissions before mapping either component role.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.schemas
    WHERE name = N'portal' AND principal_id = DATABASE_PRINCIPAL_ID(N'dbo')
)
    THROW 50100, N'The portal schema must exist and be owned by dbo for the ingestion permission contract', 1;
GO

IF EXISTS (
    SELECT 1
    FROM sys.database_principals
    WHERE name IN (N'portal_metrics_ingest', N'portal_directory_ingest')
      AND type <> 'R'
)
    THROW 50101, N'An ingestion component role name is occupied by a non-role principal', 1;
GO

IF DATABASE_PRINCIPAL_ID(N'portal_metrics_ingest') IS NULL
    CREATE ROLE portal_metrics_ingest AUTHORIZATION dbo;
IF DATABASE_PRINCIPAL_ID(N'portal_directory_ingest') IS NULL
    CREATE ROLE portal_directory_ingest AUTHORIZATION dbo;
GO

IF EXISTS (
    SELECT 1 FROM sys.database_principals
    WHERE name IN (N'portal_metrics_ingest', N'portal_directory_ingest')
      AND owning_principal_id <> DATABASE_PRINCIPAL_ID(N'dbo')
)
    THROW 50106, N'Ingestion component roles must be owned by dbo for the permission contract', 1;
GO

-- A user left in the legacy broad role must not retain direct dim_user writes while the mapping is migrated.
REVOKE INSERT, UPDATE, DELETE ON OBJECT::portal.dim_user FROM portal_ingest;
DENY INSERT, UPDATE, DELETE ON OBJECT::portal.dim_user TO portal_ingest;
DENY INSERT, UPDATE, DELETE ON OBJECT::portal.dim_user TO portal_metrics_ingest;
DENY UPDATE (
    entra_object_id, email, display_name, state, deleted_at, pii_purged_at,
    department, business_area, manager_entra_object_id, manager_email,
    manager_resolved, manager_checked_at
) ON OBJECT::portal.dim_user TO portal_metrics_ingest;
GO

-- The metrics writer's full permission closure. No schema-wide permissions or cross-component role membership.
GRANT SELECT, INSERT, UPDATE ON OBJECT::portal.IngestionRun TO portal_metrics_ingest;
GRANT INSERT ON OBJECT::portal.SourceArtifact TO portal_metrics_ingest;
GRANT SELECT (artifact_id) ON OBJECT::portal.SourceArtifact TO portal_metrics_ingest;
GRANT SELECT, INSERT, UPDATE ON OBJECT::portal.SourceCheckpoint TO portal_metrics_ingest;
GRANT INSERT ON OBJECT::portal.ValidationIssue TO portal_metrics_ingest;

GRANT SELECT, INSERT ON OBJECT::portal.stg_user_daily TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.stg_user_breakdown TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.stg_user_family_count TO portal_metrics_ingest;

GRANT SELECT, INSERT ON OBJECT::portal.dim_organization TO portal_metrics_ingest;
GRANT UPDATE (login, updated_at) ON OBJECT::portal.dim_organization TO portal_metrics_ingest;
GRANT SELECT ON OBJECT::portal.dim_user TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_user_login_history TO portal_metrics_ingest;
GRANT UPDATE (first_seen_day, last_seen_day) ON OBJECT::portal.dim_user_login_history TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_feature TO portal_metrics_ingest;
GRANT UPDATE (is_chat, is_agent, is_cli, chat_mode_bucket, is_known) ON OBJECT::portal.dim_feature TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_model TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_client TO portal_metrics_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_language TO portal_metrics_ingest;

GRANT SELECT, INSERT, DELETE ON OBJECT::portal.fact_user_daily_usage TO portal_metrics_ingest;
GRANT INSERT ON OBJECT::portal.fact_usage_breakdown TO portal_metrics_ingest;
GRANT INSERT ON OBJECT::portal.fact_usage_family_count TO portal_metrics_ingest;
GRANT INSERT, DELETE ON OBJECT::portal.agg_daily_usage TO portal_metrics_ingest;
GRANT SELECT (organization_id, usage_day) ON OBJECT::portal.agg_daily_usage TO portal_metrics_ingest;
GO

-- Directory-owned identity, profile, lifecycle, hierarchy and per-user resolution evidence.
GRANT SELECT, INSERT, UPDATE ON OBJECT::portal.IngestionRun TO portal_directory_ingest;
GRANT SELECT, INSERT ON OBJECT::portal.dim_user TO portal_directory_ingest;
GRANT UPDATE (
    login, email, display_name, entra_object_id, state, deleted_at,
    department, business_area, manager_entra_object_id, manager_email,
    manager_resolved, manager_checked_at, updated_at
) ON OBJECT::portal.dim_user TO portal_directory_ingest;
GRANT SELECT, INSERT, UPDATE ON OBJECT::portal.DirectorySyncState TO portal_directory_ingest;
GO

CREATE OR ALTER PROCEDURE portal.usp_write_metrics_users
    @run_id UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF @run_id IS NULL
        THROW 50102, N'run_id is required', 1;
    IF @@TRANCOUNT = 0
        THROW 50103, N'The metrics user writer requires the caller publication transaction', 1;

    DECLARE @isolation_level TINYINT;
    SELECT @isolation_level = transaction_isolation_level
    FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID;
    IF @isolation_level IS NULL OR @isolation_level <> 4
        THROW 50104, N'The metrics user writer requires SERIALIZABLE isolation', 1;

    IF NOT EXISTS (
        SELECT 1 FROM portal.IngestionRun
        WHERE run_id = @run_id AND source_kind = 'users_1_day'
    )
        THROW 50105, N'run_id must identify a users_1_day ingestion run', 1;

    UPDATE u WITH (UPDLOCK, HOLDLOCK)
    SET login = COALESCE(s.user_login, u.login),
        first_seen_day = CASE WHEN u.first_seen_day IS NULL OR s.usage_day < u.first_seen_day THEN s.usage_day ELSE u.first_seen_day END,
        last_seen_day = CASE WHEN u.last_seen_day IS NULL OR s.usage_day > u.last_seen_day THEN s.usage_day ELSE u.last_seen_day END,
        updated_at = SYSUTCDATETIME()
    FROM portal.dim_user AS u
    JOIN (
        SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day
        FROM portal.stg_user_daily
        WHERE run_id = @run_id
        GROUP BY user_id
    ) AS s ON s.user_id = u.user_id;

    INSERT INTO portal.dim_user (user_id, login, first_seen_day, last_seen_day)
    SELECT s.user_id, s.user_login, s.usage_day, s.usage_day
    FROM (
        SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day
        FROM portal.stg_user_daily
        WHERE run_id = @run_id
        GROUP BY user_id
    ) AS s
    WHERE NOT EXISTS (
        SELECT 1 FROM portal.dim_user AS u WITH (UPDLOCK, HOLDLOCK)
        WHERE u.user_id = s.user_id
    );
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.objects AS procedure_object
    JOIN sys.schemas AS procedure_schema ON procedure_schema.schema_id = procedure_object.schema_id
    JOIN sys.objects AS user_object ON user_object.object_id = OBJECT_ID(N'portal.dim_user')
    JOIN sys.schemas AS user_schema ON user_schema.schema_id = user_object.schema_id
    WHERE procedure_object.object_id = OBJECT_ID(N'portal.usp_write_metrics_users')
      AND COALESCE(procedure_object.principal_id, procedure_schema.principal_id)
        = COALESCE(user_object.principal_id, user_schema.principal_id)
)
    THROW 50107, N'The metrics procedure and dim_user must have the same owner for ownership chaining', 1;
GO

GRANT EXECUTE ON OBJECT::portal.usp_write_metrics_users TO portal_metrics_ingest;
DENY EXECUTE ON OBJECT::portal.usp_write_metrics_users TO portal_directory_ingest;
GO

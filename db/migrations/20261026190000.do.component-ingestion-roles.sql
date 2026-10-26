-- Migration: component-scoped ingestion roles (issue #72C, D-34).
-- No new tables or logical writers. Metrics and directory use the existing ingestion user-writer.
-- Shared dim_user INSERT and UPDATE(login, updated_at) are intentional; these are not row-isolation roles.
-- This migration creates roles only. Operators separately verify identity SIDs and remove broad memberships.

IF EXISTS (
    SELECT 1 FROM sys.database_principals
    WHERE name IN (N'portal_directory_ingest', N'portal_metrics_ingest') AND type <> 'R'
)
    THROW 51000, 'COMPONENT_INGESTION_ROLE_NAME_CONFLICT', 1;
IF DATABASE_PRINCIPAL_ID(N'portal_directory_ingest') IS NULL CREATE ROLE portal_directory_ingest AUTHORIZATION dbo;
IF DATABASE_PRINCIPAL_ID(N'portal_metrics_ingest') IS NULL CREATE ROLE portal_metrics_ingest AUTHORIZATION dbo;
GO

GRANT INSERT ON portal.IngestionRun TO portal_directory_ingest;
GRANT SELECT, INSERT ON portal.dim_user TO portal_directory_ingest;
GRANT UPDATE (login, email, display_name, entra_object_id, state, department, business_area,
              deleted_at, manager_entra_object_id, manager_email, updated_at)
    ON portal.dim_user TO portal_directory_ingest;
GRANT SELECT, INSERT ON portal.DirectorySyncState TO portal_directory_ingest;
GRANT UPDATE (last_success_at, last_attempt_at, last_error_code)
    ON portal.DirectorySyncState TO portal_directory_ingest;

GRANT SELECT, INSERT, UPDATE ON portal.IngestionRun TO portal_metrics_ingest;
GRANT INSERT ON portal.SourceArtifact TO portal_metrics_ingest;
GRANT SELECT (artifact_id) ON portal.SourceArtifact TO portal_metrics_ingest;
GRANT SELECT, INSERT, UPDATE ON portal.SourceCheckpoint TO portal_metrics_ingest;
GRANT INSERT ON portal.ValidationIssue TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.stg_user_daily TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.stg_user_breakdown TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.stg_user_family_count TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_organization TO portal_metrics_ingest;
GRANT UPDATE (login, updated_at) ON portal.dim_organization TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_user TO portal_metrics_ingest;
GRANT UPDATE (login, first_seen_day, last_seen_day, updated_at) ON portal.dim_user TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_user_login_history TO portal_metrics_ingest;
GRANT UPDATE (first_seen_day, last_seen_day) ON portal.dim_user_login_history TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_feature TO portal_metrics_ingest;
GRANT UPDATE (is_chat, is_agent, is_cli, chat_mode_bucket, is_known) ON portal.dim_feature TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_model TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_client TO portal_metrics_ingest;
GRANT SELECT, INSERT ON portal.dim_language TO portal_metrics_ingest;
GRANT SELECT, INSERT, DELETE ON portal.fact_user_daily_usage TO portal_metrics_ingest;
GRANT INSERT ON portal.fact_usage_breakdown TO portal_metrics_ingest;
GRANT INSERT ON portal.fact_usage_family_count TO portal_metrics_ingest;
GRANT INSERT, DELETE ON portal.agg_daily_usage TO portal_metrics_ingest;
-- DELETE predicates require SELECT on their referenced organization/day columns.
GRANT SELECT (organization_id, usage_day) ON portal.agg_daily_usage TO portal_metrics_ingest;
GO

-- Do not inherit portal_ingest, schema-wide reads, purge rights, access writers, or DDL rights.
-- Public-principal sp_getapplock/sp_releaseapplock require no additional blanket EXECUTE grant.
DENY UPDATE, DELETE ON portal.IngestionRun TO portal_directory_ingest;
DENY DELETE ON portal.IngestionRun TO portal_metrics_ingest;
DENY UPDATE, DELETE ON portal.SourceArtifact TO portal_metrics_ingest;
DENY UPDATE, DELETE ON portal.IngestionAuditEvent TO portal_directory_ingest, portal_metrics_ingest;
DENY UPDATE, DELETE ON portal.GrantRevocation TO portal_directory_ingest, portal_metrics_ingest;
DENY UPDATE, DELETE ON portal.IssueAction TO portal_directory_ingest, portal_metrics_ingest;
GO

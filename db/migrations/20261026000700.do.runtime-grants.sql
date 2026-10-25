-- Migration: runtime grants (D-34). No tables are created here, so there are no writers to name.
--
-- Identities are created from Entra object IDs with CREATE USER ... WITH SID, TYPE = E so the database never needs
-- the server to read Entra (not FROM EXTERNAL PROVIDER). The SID is the object ID (client ID of the managed
-- identity) converted to binary(16); the deployment pipeline substitutes the placeholders below (no sqlcmd variables are used in this file):
--   <portal-identity-name> <portal-identity-sid>   read on portal
--   <ingest-identity-name> <ingest-identity-sid>   write on staging, curated and control
-- Runtime identities are never db_owner, db_ddladmin or SQL admin. Roles below carry all permissions.
--
-- Single-writer (D-34) is enforced by grants: the portal role may INSERT only into the tables it owns
-- (AuditLog, Principal, PrincipalIdentity, AccessGrant, BreakGlassConfig, Feedback*); the ingestion role writes the rest.

IF DATABASE_PRINCIPAL_ID(N'portal_reader') IS NULL CREATE ROLE portal_reader;
IF DATABASE_PRINCIPAL_ID(N'portal_writer') IS NULL CREATE ROLE portal_writer;
IF DATABASE_PRINCIPAL_ID(N'portal_ingest') IS NULL CREATE ROLE portal_ingest;
GO

GRANT SELECT ON SCHEMA::portal TO portal_reader;
GRANT SELECT ON SCHEMA::portal TO portal_ingest;
GRANT SELECT ON SCHEMA::portal TO portal_writer;

-- Portal-owned tables (writer: portal).
GRANT INSERT, UPDATE ON portal.Principal TO portal_writer;
GRANT INSERT, UPDATE ON portal.PrincipalIdentity TO portal_writer;
GRANT INSERT, UPDATE, DELETE ON portal.AccessGrant TO portal_writer;
GRANT INSERT, UPDATE ON portal.BreakGlassConfig TO portal_writer;
GRANT INSERT, UPDATE ON portal.FeedbackItem TO portal_writer;
GRANT INSERT, DELETE ON portal.FeedbackVote TO portal_writer;
GRANT INSERT ON portal.FeedbackComment TO portal_writer;
-- Append-only audit: INSERT, no UPDATE or DELETE.
GRANT INSERT ON portal.AuditLog TO portal_writer;

-- Ingestion-owned tables.
GRANT INSERT, UPDATE ON portal.IngestionRun TO portal_ingest;
GRANT INSERT ON portal.SourceArtifact TO portal_ingest;
GRANT INSERT, UPDATE ON portal.SourceCheckpoint TO portal_ingest;
GRANT INSERT ON portal.ValidationIssue TO portal_ingest;
GRANT INSERT, UPDATE ON portal.DirectorySyncState TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.stg_user_daily TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.stg_user_breakdown TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.stg_user_family_count TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.stg_ai_credit_line TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.fact_user_daily_usage TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.fact_usage_breakdown TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.fact_usage_family_count TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.fact_ai_credit_line TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.agg_daily_usage TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.agg_ai_credit_daily TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_organization TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_user TO portal_ingest;
GRANT INSERT, UPDATE, DELETE ON portal.dim_user_login_history TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_feature TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_model TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_client TO portal_ingest;
GRANT INSERT, UPDATE ON portal.dim_language TO portal_ingest;
-- Needed for sp_getapplock-guarded publishing; applock requires no extra permission beyond database membership.
GO

-- Seed rows owned by the migration runner.
IF NOT EXISTS (SELECT 1 FROM portal.TransformVersion WHERE transform_version = '1')
INSERT INTO portal.TransformVersion (transform_version, description) VALUES ('1', N'Initial contract version');
GO

-- Users are created by the deployment pipeline, not here, because SIDs are environment specific:
--   CREATE USER [<portal-identity-name>] WITH SID = <portal-identity-sid>, TYPE = E;
--   ALTER ROLE portal_reader ADD MEMBER [<portal-identity-name>];
--   ALTER ROLE portal_writer ADD MEMBER [<portal-identity-name>];
--   CREATE USER [<ingest-identity-name>] WITH SID = <ingest-identity-sid>, TYPE = E;
--   ALTER ROLE portal_ingest ADD MEMBER [<ingest-identity-name>];

-- Audit and access tables: the audit log is append-only and ingestion never reads access data.
DENY UPDATE, DELETE ON portal.AuditLog TO portal_reader, portal_writer, portal_ingest;
DENY SELECT ON portal.AuditLog TO portal_ingest;
DENY SELECT ON portal.Principal TO portal_ingest;
DENY SELECT ON portal.PrincipalIdentity TO portal_ingest;
DENY SELECT ON portal.AccessGrant TO portal_ingest;
DENY SELECT ON portal.BreakGlassConfig TO portal_ingest;
GO

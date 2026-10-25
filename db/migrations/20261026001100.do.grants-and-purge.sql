-- Migration: grants for the access-model tables and the login-history purge (issue #44 items 4, 8; D-34).
--
-- No tables are created here, so there are no new writers to name. Existing writers touched:
--   portal.dim_user_login_history: ingestion (purged by portal.usp_purge_login_history, nobody else deletes)
--
-- Single-writer grants:
--   ingestion: INSERT and UPDATE(unlinked_at, unlink_reason) on PrincipalLinkState; INSERT on GrantRevocation and
--              IngestionAuditEvent; UPDATE(handled_at) on ValidationIssue only.
--   portal:    INSERT on IssueAction. Reads the grant state through portal.v_active_grant.
--   Append-only: UPDATE and DELETE are denied on GrantRevocation, IssueAction and IngestionAuditEvent for every role.
--   portal:    EXECUTE on usp_link_principal_entra (fill a missing Entra ID once; the only way to set Entra columns).
-- Ingestion keeps DENY SELECT on Principal, PrincipalIdentity and AccessGrant; it never reads access data.
--
-- dim_user_login_history is kept for audit and purged only after a maximum age (deployment setting
-- login_history_months, default 24). This is an explicit exception to the 13-month per-user retention rule. Age is
-- measured from last_seen_day. Only admins can read the table through the API.

GRANT INSERT ON portal.PrincipalLinkState TO portal_ingest;
GRANT UPDATE (unlinked_at, unlink_reason) ON portal.PrincipalLinkState TO portal_ingest;
GRANT INSERT ON portal.GrantRevocation TO portal_ingest;
GRANT INSERT ON portal.IngestionAuditEvent TO portal_ingest;
GRANT UPDATE (handled_at) ON portal.ValidationIssue TO portal_ingest;
GRANT INSERT ON portal.IssueAction TO portal_writer;
DENY UPDATE, DELETE ON portal.GrantRevocation TO portal_reader, portal_writer, portal_ingest;
DENY UPDATE, DELETE ON portal.IssueAction TO portal_reader, portal_writer, portal_ingest;
DENY UPDATE, DELETE ON portal.IngestionAuditEvent TO portal_reader, portal_writer, portal_ingest;
DENY DELETE ON portal.PrincipalLinkState TO portal_reader, portal_writer, portal_ingest;
GRANT SELECT ON portal.v_active_grant TO portal_writer, portal_reader;
-- The schema-wide SELECT of the runtime-grants migration would reach the view; ingestion never reads access data.
DENY SELECT ON portal.v_active_grant TO portal_ingest;

-- Grants are immutable except revoked_at, so a revocation cannot be undone by moving granted_at or by an UPDATE of the
-- role, scope or principal; a re-grant is a new row after the old one is revoked (filtered unique index below).
-- Principal identity columns are immutable too: the Entra IDs that grants and revocations key on cannot be re-pointed.
REVOKE UPDATE, DELETE ON portal.AccessGrant FROM portal_writer;
GRANT UPDATE (revoked_at) ON portal.AccessGrant TO portal_writer;
REVOKE UPDATE ON portal.Principal FROM portal_writer;
GRANT UPDATE (github_user_id, status, updated_at, permissions_verified_at) ON portal.Principal TO portal_writer;
-- Only the purge procedure deletes login history (ownership chaining lets it run for the ingestion role).
REVOKE DELETE ON portal.dim_user_login_history FROM portal_ingest;
GO

IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UX_AccessGrant' AND parent_object_id = OBJECT_ID(N'portal.AccessGrant'))
ALTER TABLE portal.AccessGrant DROP CONSTRAINT UX_AccessGrant;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_AccessGrant_active' AND object_id = OBJECT_ID(N'portal.AccessGrant'))
CREATE UNIQUE INDEX UX_AccessGrant_active ON portal.AccessGrant (principal_id, role, scope, scope_value) WHERE revoked_at IS NULL;
GO

CREATE OR ALTER PROCEDURE portal.usp_purge_login_history
    @max_age_months INT,
    @run_id UNIQUEIDENTIFIER = NULL,
    @correlation_id VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @max_age_months IS NULL OR @max_age_months < 1 OR @max_age_months > 60
        THROW 50045, N'max_age_months must be between 1 and 60', 1;

    DECLARE @cutoff DATE = DATEADD(MONTH, -@max_age_months, CAST(SYSUTCDATETIME() AS DATE));
    DECLARE @deleted INT;

    BEGIN TRY
        BEGIN TRANSACTION;
        DELETE FROM portal.dim_user_login_history WHERE last_seen_day < @cutoff;
        SET @deleted = @@ROWCOUNT;
        INSERT INTO portal.IngestionAuditEvent (action, run_id, target_type, outcome, correlation_id, detail_json)
        VALUES ('login_history.purged', @run_id, 'dim_user_login_history', 'success', @correlation_id,
                (SELECT @deleted AS rows_deleted, @max_age_months AS max_age_months, CONVERT(VARCHAR(10), @cutoff, 23) AS cutoff FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        INSERT INTO portal.IngestionAuditEvent (action, run_id, target_type, outcome, correlation_id)
        VALUES ('login_history.purged', @run_id, 'dim_user_login_history', 'failure', @correlation_id);
        THROW;
    END CATCH;
    SELECT @deleted AS rows_deleted;
END;
GO

GRANT EXECUTE ON portal.usp_purge_login_history TO portal_ingest;
GO

-- Dual-provider linking (decision record §13.1): fills the missing Entra ID of a GitHub-only principal exactly once.
-- Entra columns are not directly updatable, so an identity can never be re-pointed or cleared.
CREATE OR ALTER PROCEDURE portal.usp_link_principal_entra
    @principal_id UNIQUEIDENTIFIER,
    @entra_tenant_id UNIQUEIDENTIFIER,
    @entra_object_id UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @principal_id IS NULL OR @entra_tenant_id IS NULL OR @entra_object_id IS NULL
        THROW 50046, N'principal, tenant and Entra object ID are required', 1;
    UPDATE portal.Principal
    SET entra_tenant_id = @entra_tenant_id, entra_object_id = @entra_object_id, updated_at = SYSUTCDATETIME()
    WHERE principal_id = @principal_id AND entra_object_id IS NULL;
    IF @@ROWCOUNT = 0
        THROW 50047, N'principal not found or already linked to an Entra identity', 1;
END;
GO

GRANT EXECUTE ON portal.usp_link_principal_entra TO portal_writer;
GO

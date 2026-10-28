-- Migration: bounded historical grant-conflict contract (#172; D-17, D-34, D-36, D-47).
--
-- No tables are created or changed; no table writer changes. The portal writer receives only EXECUTE on this
-- denial-only contract. Effective authorization continues to use portal.v_active_grant.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

CREATE OR ALTER PROCEDURE portal.usp_has_revoked_grant_conflict
    @entra_tenant_id UNIQUEIDENTIFIER,
    @entra_object_id UNIQUEIDENTIFIER,
    @role           VARCHAR(MAX),
    @scope          VARCHAR(MAX),
    @scope_value    NVARCHAR(MAX),
    @has_conflict   BIT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    IF @entra_tenant_id IS NULL OR @entra_object_id IS NULL OR @role IS NULL OR @scope IS NULL OR @scope_value IS NULL
        THROW 50108, N'All historical grant-conflict inputs are required', 1;

    IF DATALENGTH(@role) > 12 OR DATALENGTH(@scope) > 16 OR DATALENGTH(@scope_value) > 256
        THROW 50112, N'Historical grant-conflict inputs exceed the role, scope or scope value bounds', 1;

    IF @@TRANCOUNT = 0
        THROW 50109, N'The historical grant-conflict contract requires the caller transaction', 1;

    DECLARE @isolation_level TINYINT;
    SELECT @isolation_level = transaction_isolation_level
    FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID;
    IF @isolation_level IS NULL OR @isolation_level <> 4
        THROW 50111, N'The historical grant-conflict contract requires SERIALIZABLE isolation', 1;

    DECLARE @lifecycle_lock_mode NVARCHAR(32) =
        APPLOCK_MODE(N'public', N'ingest:directory', N'Transaction');
    IF @lifecycle_lock_mode IS NULL OR @lifecycle_lock_mode <> N'Exclusive'
        THROW 50110, N'The historical grant-conflict contract requires the caller to hold ingest:directory', 1;

    SET @has_conflict = 0;
    IF EXISTS (
        SELECT 1
        FROM portal.AccessGrant AS g
        JOIN portal.Principal AS p ON p.principal_id = g.principal_id
        WHERE p.entra_tenant_id = @entra_tenant_id
          AND p.entra_object_id = @entra_object_id
          AND g.principal_entra_oid = @entra_object_id
          AND DATALENGTH(g.role) = DATALENGTH(@role)
          AND g.role COLLATE Latin1_General_100_BIN2 = @role COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(g.scope) = DATALENGTH(@scope)
          AND g.scope COLLATE Latin1_General_100_BIN2 = @scope COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(g.scope_value) = DATALENGTH(@scope_value)
          AND g.scope_value COLLATE Latin1_General_100_BIN2 = @scope_value COLLATE Latin1_General_100_BIN2
          AND g.revoked_at IS NOT NULL
    )
        SET @has_conflict = 1;
END;
GO

GRANT EXECUTE ON OBJECT::portal.usp_has_revoked_grant_conflict TO portal_writer;
GO

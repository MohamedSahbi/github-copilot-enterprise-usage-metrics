-- Effective-permission preflight for one ingestion identity (docs/runbooks/database-grants.md).
-- scripts/db/runtime-users.ts fills the three parameters; any THROW is a hard stop.
DECLARE @identity_name sysname = N'{{identity_name}}';
DECLARE @component_role sysname = N'{{component_role}}';
DECLARE @require_component_membership bit = {{require_component_membership}};
DECLARE @identity_id int = DATABASE_PRINCIPAL_ID(@identity_name);

IF @identity_id IS NULL
    THROW 50200, N'Ingestion identity is missing; create the contained user before preflight', 1;
IF NOT EXISTS (
    SELECT 1 FROM sys.database_principals
    WHERE principal_id = @identity_id AND type = 'E'
)
    THROW 50201, N'Ingestion identity is not the expected Entra contained user', 1;
IF IS_ROLEMEMBER(N'public', @identity_name) <> 1
    THROW 50202, N'Preflight could not account for implicit PUBLIC membership', 1;
IF EXISTS (
    SELECT 1 FROM sys.database_permissions
    WHERE grantee_principal_id = @identity_id
      AND NOT (class = 0 AND major_id = 0 AND permission_name = N'CONNECT' AND state = 'G')
)
    THROW 50203, N'Ingestion identity has a direct database permission; use the component role only', 1;
IF EXISTS (
    SELECT 1 FROM sys.schemas WHERE principal_id = @identity_id
) OR EXISTS (
    SELECT 1 FROM sys.objects WHERE principal_id = @identity_id
) OR EXISTS (
    SELECT 1 FROM sys.databases
    WHERE database_id = DB_ID()
      AND owner_sid = (SELECT sid FROM sys.database_principals WHERE principal_id = @identity_id)
)
    THROW 50204, N'Ingestion identity owns the database, a schema, or an object', 1;

DECLARE @role_closure TABLE (role_principal_id int NOT NULL);
;WITH role_closure AS (
    SELECT role_principal_id
    FROM sys.database_role_members
    WHERE member_principal_id = @identity_id
    UNION ALL
    SELECT rm.role_principal_id
    FROM sys.database_role_members AS rm
    JOIN role_closure AS inherited ON inherited.role_principal_id = rm.member_principal_id
)
INSERT INTO @role_closure (role_principal_id)
SELECT DISTINCT role_principal_id FROM role_closure;

IF EXISTS (
    SELECT 1
    FROM @role_closure AS closure
    JOIN sys.database_principals AS role ON role.principal_id = closure.role_principal_id
    WHERE role.name <> @component_role
)
    THROW 50205, N'Ingestion identity inherits a role outside its one component role', 1;
IF EXISTS (
    SELECT 1 FROM sys.schemas
    WHERE principal_id = @identity_id
       OR principal_id IN (SELECT role_principal_id FROM @role_closure)
) OR EXISTS (
    SELECT 1 FROM sys.objects
    WHERE principal_id = @identity_id
       OR principal_id IN (SELECT role_principal_id FROM @role_closure)
)
    THROW 50229, N'Ingestion identity or its component role owns a schema or object', 1;
IF @require_component_membership = 0 AND EXISTS (
    SELECT 1 FROM @role_closure AS closure
    JOIN sys.database_principals AS role ON role.principal_id = closure.role_principal_id
    WHERE role.name = @component_role
)
    THROW 50219, N'Pre-map preflight expects no component-role membership yet', 1;
IF @require_component_membership = 1 AND NOT EXISTS (
    SELECT 1 FROM @role_closure AS closure
    JOIN sys.database_principals AS role ON role.principal_id = closure.role_principal_id
    WHERE role.name = @component_role
)
    THROW 50206, N'Ingestion identity is not mapped to its intended component role', 1;
IF EXISTS (
    SELECT 1
    FROM sys.database_permissions
    WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(N'public')
      AND state IN ('G', 'W')
      AND permission_name IN (N'CONTROL', N'ALTER', N'TAKE OWNERSHIP', N'IMPERSONATE ANY USER')
)
    THROW 50207, N'PUBLIC has a database-level permission that makes component mapping unsafe', 1;
IF EXISTS (
    SELECT 1
    FROM sys.database_permissions AS permission
    WHERE permission.grantee_principal_id IN (
        SELECT role_principal_id FROM @role_closure
        UNION SELECT DATABASE_PRINCIPAL_ID(N'public')
    )
      AND permission.permission_name IN (N'IMPERSONATE', N'ALTER', N'CONTROL', N'TAKE OWNERSHIP')
)
    THROW 50220, N'Component role or PUBLIC has an unsafe object-level security permission', 1;

DECLARE @portal_objects TABLE (
    securable_name nvarchar(517), object_name sysname, object_type char(2), object_id int
);
INSERT INTO @portal_objects
SELECT QUOTENAME(schema_name.name) + N'.' + QUOTENAME(object_name.name),
       object_name.name, object_name.type, object_name.object_id
FROM sys.objects AS object_name
JOIN sys.schemas AS schema_name ON schema_name.schema_id = object_name.schema_id
WHERE schema_name.name = N'portal' AND object_name.is_ms_shipped = 0
  AND object_name.parent_object_id = 0; -- constraints report their parent table's permissions, which are already checked
DECLARE @nonportal_objects TABLE (securable_name nvarchar(517), object_id int);
INSERT INTO @nonportal_objects
SELECT QUOTENAME(schema_name.name) + N'.' + QUOTENAME(object_name.name), object_name.object_id
FROM sys.objects AS object_name
JOIN sys.schemas AS schema_name ON schema_name.schema_id = object_name.schema_id
WHERE schema_name.name NOT IN (N'portal', N'sys', N'INFORMATION_SCHEMA')
  AND object_name.is_ms_shipped = 0
  AND object_name.parent_object_id = 0;
IF NOT EXISTS (
    SELECT 1 FROM sys.schemas
    WHERE name = N'portal' AND principal_id = DATABASE_PRINCIPAL_ID(N'dbo')
)
    THROW 50221, N'The portal schema is not owned by dbo; procedure ownership chaining is not trusted', 1;
DECLARE @metrics_procedure_owner_id int;
DECLARE @dim_user_owner_id int;
SELECT @metrics_procedure_owner_id = COALESCE(procedure_object.principal_id, procedure_schema.principal_id)
FROM sys.objects AS procedure_object
JOIN sys.schemas AS procedure_schema ON procedure_schema.schema_id = procedure_object.schema_id
WHERE procedure_object.object_id = OBJECT_ID(N'portal.usp_write_metrics_users');
SELECT @dim_user_owner_id = COALESCE(user_object.principal_id, user_schema.principal_id)
FROM sys.objects AS user_object
JOIN sys.schemas AS user_schema ON user_schema.schema_id = user_object.schema_id
WHERE user_object.object_id = OBJECT_ID(N'portal.dim_user');
IF @metrics_procedure_owner_id IS NULL OR @dim_user_owner_id IS NULL
   OR @metrics_procedure_owner_id <> @dim_user_owner_id
    THROW 50230, N'The metrics procedure and dim_user do not share an ownership chain', 1;
IF EXISTS (
    SELECT 1
    FROM sys.sql_modules AS module
    JOIN sys.objects AS procedure_name ON procedure_name.object_id = module.object_id
    WHERE procedure_name.object_id = OBJECT_ID(N'portal.usp_write_metrics_users')
      AND module.execute_as_principal_id IS NOT NULL
)
    THROW 50222, N'The metrics procedure has an EXECUTE AS context instead of caller context', 1;
DECLARE @portal_columns TABLE (securable_name nvarchar(517), object_name sysname, column_name sysname);
INSERT INTO @portal_columns
SELECT object.securable_name, object.object_name, column_name.name
FROM @portal_objects AS object
JOIN sys.columns AS column_name ON column_name.object_id = object.object_id;
DECLARE @nonportal_columns TABLE (securable_name nvarchar(517), column_name sysname);
INSERT INTO @nonportal_columns
SELECT object.securable_name, column_name.name
FROM @nonportal_objects AS object
JOIN sys.columns AS column_name ON column_name.object_id = object.object_id;
DECLARE @application_schemas TABLE (schema_name sysname);
INSERT INTO @application_schemas
SELECT name FROM sys.schemas WHERE name NOT IN (N'sys', N'INFORMATION_SCHEMA');
DECLARE @application_procedures TABLE (securable_name nvarchar(517));
INSERT INTO @application_procedures
SELECT QUOTENAME(schema_name.name) + N'.' + QUOTENAME(procedure_name.name)
FROM sys.objects AS procedure_name
JOIN sys.schemas AS schema_name ON schema_name.schema_id = procedure_name.schema_id
WHERE procedure_name.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT', 'AF')
  AND procedure_name.is_ms_shipped = 0
  AND schema_name.name NOT IN (N'sys', N'INFORMATION_SCHEMA');

DECLARE @component_grants TABLE (object_name sysname, permission_name sysname);
IF @component_role = N'portal_metrics_ingest'
BEGIN
    INSERT INTO @component_grants VALUES
      (N'IngestionRun', N'SELECT'), (N'IngestionRun', N'INSERT'), (N'IngestionRun', N'UPDATE'),
      (N'SourceArtifact', N'SELECT'), (N'SourceArtifact', N'INSERT'),
      (N'SourceCheckpoint', N'SELECT'), (N'SourceCheckpoint', N'INSERT'), (N'SourceCheckpoint', N'UPDATE'),
      (N'ValidationIssue', N'INSERT'),
      (N'stg_user_daily', N'SELECT'), (N'stg_user_daily', N'INSERT'),
      (N'stg_user_breakdown', N'SELECT'), (N'stg_user_breakdown', N'INSERT'),
      (N'stg_user_family_count', N'SELECT'), (N'stg_user_family_count', N'INSERT'),
      (N'dim_organization', N'SELECT'), (N'dim_organization', N'INSERT'), (N'dim_organization', N'UPDATE'),
      (N'dim_user', N'SELECT'),
      (N'dim_user_login_history', N'SELECT'), (N'dim_user_login_history', N'INSERT'), (N'dim_user_login_history', N'UPDATE'),
      (N'dim_feature', N'SELECT'), (N'dim_feature', N'INSERT'), (N'dim_feature', N'UPDATE'),
      (N'dim_model', N'SELECT'), (N'dim_model', N'INSERT'),
      (N'dim_client', N'SELECT'), (N'dim_client', N'INSERT'),
      (N'dim_language', N'SELECT'), (N'dim_language', N'INSERT'),
      (N'fact_user_daily_usage', N'SELECT'), (N'fact_user_daily_usage', N'INSERT'), (N'fact_user_daily_usage', N'DELETE'),
      (N'fact_usage_breakdown', N'INSERT'), (N'fact_usage_family_count', N'INSERT'),
      (N'agg_daily_usage', N'SELECT'), (N'agg_daily_usage', N'INSERT'), (N'agg_daily_usage', N'DELETE');
END
ELSE IF @component_role = N'portal_directory_ingest'
BEGIN
    INSERT INTO @component_grants VALUES
      (N'IngestionRun', N'SELECT'), (N'IngestionRun', N'INSERT'), (N'IngestionRun', N'UPDATE'),
      (N'dim_user', N'SELECT'), (N'dim_user', N'INSERT'), (N'dim_user', N'UPDATE'),
      (N'DirectorySyncState', N'SELECT'), (N'DirectorySyncState', N'INSERT'), (N'DirectorySyncState', N'UPDATE');
END
ELSE
    THROW 50208, N'Preflight component role is not an approved ingestion role', 1;

DECLARE @full_select TABLE (object_name sysname NOT NULL);
DECLARE @full_update TABLE (object_name sysname NOT NULL);
DECLARE @column_select TABLE (object_name sysname NOT NULL, column_name sysname NOT NULL);
DECLARE @column_update TABLE (object_name sysname NOT NULL, column_name sysname NOT NULL);
IF @component_role = N'portal_metrics_ingest'
BEGIN
    INSERT INTO @full_select
    SELECT DISTINCT object_name FROM @component_grants
    WHERE permission_name = N'SELECT' AND object_name NOT IN (N'SourceArtifact', N'agg_daily_usage');
    INSERT INTO @column_select VALUES
      (N'SourceArtifact', N'artifact_id'),
      (N'agg_daily_usage', N'organization_id'), (N'agg_daily_usage', N'usage_day');
    INSERT INTO @full_update VALUES (N'IngestionRun'), (N'SourceCheckpoint');
    INSERT INTO @column_update VALUES
      (N'dim_organization', N'login'), (N'dim_organization', N'updated_at'),
      (N'dim_user_login_history', N'first_seen_day'), (N'dim_user_login_history', N'last_seen_day'),
      (N'dim_feature', N'is_chat'), (N'dim_feature', N'is_agent'), (N'dim_feature', N'is_cli'),
      (N'dim_feature', N'chat_mode_bucket'), (N'dim_feature', N'is_known');
END
ELSE
BEGIN
    INSERT INTO @full_select VALUES (N'IngestionRun'), (N'dim_user'), (N'DirectorySyncState');
    INSERT INTO @full_update VALUES (N'IngestionRun'), (N'DirectorySyncState');
    INSERT INTO @column_update VALUES
      (N'dim_user', N'login'), (N'dim_user', N'email'), (N'dim_user', N'display_name'),
      (N'dim_user', N'entra_object_id'), (N'dim_user', N'state'), (N'dim_user', N'deleted_at'),
      (N'dim_user', N'department'), (N'dim_user', N'business_area'),
      (N'dim_user', N'manager_entra_object_id'), (N'dim_user', N'manager_email'),
      (N'dim_user', N'manager_resolved'), (N'dim_user', N'manager_checked_at'),
      (N'dim_user', N'updated_at');
END;

IF @component_role = N'portal_metrics_ingest' AND NOT EXISTS (
    SELECT 1 FROM sys.database_principals WHERE name = @component_role AND type = 'R'
)
    THROW 50209, N'Metrics component role is missing', 1;
IF @component_role = N'portal_directory_ingest' AND NOT EXISTS (
    SELECT 1 FROM sys.database_principals WHERE name = @component_role AND type = 'R'
)
    THROW 50210, N'Directory component role is missing', 1;
IF EXISTS (
    SELECT 1 FROM sys.database_principals
    WHERE name = @component_role AND owning_principal_id <> DATABASE_PRINCIPAL_ID(N'dbo')
)
    THROW 50225, N'Component role is not owned by dbo', 1;

EXECUTE AS USER = @identity_name;

IF EXISTS (
    SELECT 1 FROM sys.fn_my_permissions(NULL, N'DATABASE')
    WHERE permission_name IN (N'CONTROL', N'ALTER', N'TAKE OWNERSHIP', N'IMPERSONATE ANY USER', N'VIEW DEFINITION')
       OR permission_name LIKE N'ALTER ANY %'
       OR permission_name LIKE N'CREATE %'
)
BEGIN
    REVERT;
    THROW 50211, N'Ingestion identity has database-level DDL, control, definition, or impersonation rights', 1;
END;

IF EXISTS (
    SELECT 1 FROM sys.fn_my_permissions(N'portal', N'SCHEMA')
    WHERE permission_name IN (N'SELECT', N'INSERT', N'UPDATE', N'DELETE', N'EXECUTE',
                              N'ALTER', N'CONTROL', N'TAKE OWNERSHIP', N'VIEW DEFINITION')
)
BEGIN
    REVERT;
    THROW 50212, N'Ingestion identity has a schema-wide portal permission', 1;
END;

DECLARE @schema_name sysname;
DECLARE application_schema_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT schema_name FROM @application_schemas;
OPEN application_schema_cursor;
FETCH NEXT FROM application_schema_cursor INTO @schema_name;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF EXISTS (
        SELECT 1 FROM sys.fn_my_permissions(@schema_name, N'SCHEMA')
        WHERE permission_name IN (N'SELECT', N'INSERT', N'UPDATE', N'DELETE', N'EXECUTE',
                                  N'ALTER', N'CONTROL', N'TAKE OWNERSHIP', N'VIEW DEFINITION')
    )
    BEGIN
        CLOSE application_schema_cursor;
        DEALLOCATE application_schema_cursor;
        REVERT;
        THROW 50226, N'Ingestion identity has an unexpected application-schema permission', 1;
    END;
    FETCH NEXT FROM application_schema_cursor INTO @schema_name;
END;
CLOSE application_schema_cursor;
DEALLOCATE application_schema_cursor;

DECLARE @effective_portal TABLE (securable_name nvarchar(517), permission_name sysname);
DECLARE @securable_name nvarchar(517);
DECLARE portal_object_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT securable_name FROM @portal_objects;
OPEN portal_object_cursor;
FETCH NEXT FROM portal_object_cursor INTO @securable_name;
WHILE @@FETCH_STATUS = 0
BEGIN
    INSERT INTO @effective_portal (securable_name, permission_name)
    SELECT @securable_name, permission_name
    FROM sys.fn_my_permissions(@securable_name, N'OBJECT');
    FETCH NEXT FROM portal_object_cursor INTO @securable_name;
END;
CLOSE portal_object_cursor;
DEALLOCATE portal_object_cursor;

IF EXISTS (
    SELECT 1
    FROM @nonportal_objects AS object
    CROSS APPLY sys.fn_my_permissions(object.securable_name, N'OBJECT') AS permission
)
BEGIN
    REVERT;
    THROW 50227, N'Ingestion identity has an unexpected permission on a non-portal object', 1;
END;

IF EXISTS (
    SELECT 1 FROM @nonportal_columns AS column_name
    WHERE HAS_PERMS_BY_NAME(column_name.securable_name, N'OBJECT', N'SELECT',
                            column_name.column_name, N'COLUMN') = 1
       OR HAS_PERMS_BY_NAME(column_name.securable_name, N'OBJECT', N'UPDATE',
                            column_name.column_name, N'COLUMN') = 1
)
BEGIN
    REVERT;
    THROW 50228, N'Ingestion identity has a non-portal column permission', 1;
END;

IF EXISTS (
    SELECT 1 FROM @effective_portal
    WHERE permission_name NOT IN (N'SELECT', N'INSERT', N'UPDATE', N'DELETE', N'EXECUTE')
)
BEGIN
    REVERT;
    THROW 50213, N'Ingestion identity has an unapproved object-level permission', 1;
END;

IF @require_component_membership = 1 AND NOT EXISTS (
    SELECT 1
    FROM @effective_portal AS effective
    JOIN @portal_objects AS object ON object.securable_name = effective.securable_name
    JOIN @component_grants AS allowed
      ON allowed.object_name = object.object_name AND allowed.permission_name = effective.permission_name
    WHERE effective.permission_name IN (N'INSERT', N'UPDATE', N'DELETE')
)
BEGIN
    REVERT;
    THROW 50214, N'Preflight could not verify the component write permission manifest', 1;
END;

IF EXISTS (
    SELECT 1 FROM @effective_portal AS effective
    JOIN @portal_objects AS object ON object.securable_name = effective.securable_name
    WHERE effective.permission_name IN (N'SELECT', N'INSERT', N'UPDATE', N'DELETE')
      AND NOT EXISTS (
          SELECT 1 FROM @component_grants AS allowed
          WHERE allowed.object_name = object.object_name
            AND allowed.permission_name = effective.permission_name
      )
)
BEGIN
    REVERT;
    THROW 50215, N'Ingestion identity has an unapproved read or write path on a portal object', 1;
END;

IF EXISTS (
    SELECT 1 FROM @application_procedures AS procedure_name
    WHERE HAS_PERMS_BY_NAME(procedure_name.securable_name, N'OBJECT', N'EXECUTE') = 1
      AND NOT (@component_role = N'portal_metrics_ingest'
               AND procedure_name.securable_name = N'[portal].[usp_write_metrics_users]')
)
BEGIN
    REVERT;
    THROW 50216, N'Ingestion identity can execute an unapproved application procedure', 1;
END;

IF EXISTS (
    SELECT 1 FROM @portal_columns AS column_name
    WHERE HAS_PERMS_BY_NAME(column_name.securable_name, N'OBJECT', N'SELECT',
                            column_name.column_name, N'COLUMN') = 1
      AND NOT EXISTS (
          SELECT 1 FROM @full_select AS allowed
          WHERE allowed.object_name = column_name.object_name
      )
      AND NOT EXISTS (
          SELECT 1 FROM @column_select AS allowed
          WHERE allowed.object_name = column_name.object_name
            AND allowed.column_name = column_name.column_name
      )
)
BEGIN
    REVERT;
    THROW 50223, N'Ingestion identity can read an unapproved portal column', 1;
END;

IF EXISTS (
    SELECT 1 FROM @portal_columns AS column_name
    WHERE HAS_PERMS_BY_NAME(column_name.securable_name, N'OBJECT', N'UPDATE',
                            column_name.column_name, N'COLUMN') = 1
      AND NOT EXISTS (
          SELECT 1 FROM @full_update AS allowed
          WHERE allowed.object_name = column_name.object_name
      )
      AND NOT EXISTS (
          SELECT 1 FROM @column_update AS allowed
          WHERE allowed.object_name = column_name.object_name
            AND allowed.column_name = column_name.column_name
      )
)
BEGIN
    REVERT;
    THROW 50224, N'Ingestion identity can update an unapproved portal column', 1;
END;

IF @component_role = N'portal_metrics_ingest' AND (
    HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'INSERT') = 1
    OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'UPDATE') = 1
    OR HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'DELETE') = 1
    OR EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'portal.dim_user')
          AND name IN (N'entra_object_id', N'email', N'display_name', N'state', N'deleted_at',
                       N'pii_purged_at', N'department', N'business_area', N'manager_entra_object_id',
                       N'manager_email', N'manager_resolved', N'manager_checked_at')
          AND HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'UPDATE', name, N'COLUMN') = 1
    )
)
BEGIN
    REVERT;
    THROW 50217, N'Metrics identity can directly mutate dim_user or a directory-owned column', 1;
END;

IF @component_role = N'portal_directory_ingest' AND EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'portal.dim_user')
      AND name NOT IN (N'login', N'email', N'display_name', N'entra_object_id', N'state',
                       N'deleted_at', N'department', N'business_area', N'manager_entra_object_id',
                       N'manager_email', N'manager_resolved', N'manager_checked_at', N'updated_at')
      AND HAS_PERMS_BY_NAME(N'portal.dim_user', N'OBJECT', N'UPDATE', name, N'COLUMN') = 1
)
BEGIN
    REVERT;
    THROW 50218, N'Directory identity can update an unapproved dim_user column', 1;
END;

REVERT;

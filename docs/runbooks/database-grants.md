# Runbook: database users and grants

Migration `runtime-grants` creates the roles `portal_reader`, `portal_writer` and `portal_ingest` and grants them their permissions (single writer per table, D-34). It does not create users: SIDs are environment specific, so the pipeline creates them in a separate step after the runner, using managed identities.

## Rules

- Runtime identities (the portal and the ingestion functions) are never `db_owner`, `db_ddladmin`, `db_securityadmin` or SQL admin. They are members of the roles above and nothing else.
- Grant access through roles only; no per-table grants to users.
- The identity that runs migrations is a deploy-time identity, separate from the runtime identities, and is never used by a running app.
- Users are created with `CREATE USER ... WITH SID = <sid>, TYPE = E` so the database does not need to read Entra.

## Step

Run after `npm run db:migrate` as the deploy identity. Values come from the environment's deployment outputs, never from this repository: the identity names and their Entra object (principal) IDs. For `CREATE USER ... WITH SID ..., TYPE = E`, Microsoft's Azure SQL managed identity guidance says to supply the Object ID of the principal and use it as the SID; do not use the client (application) ID. Source: https://learn.microsoft.com/en-us/azure/azure-sql/database/authentication-azure-ad-user-assigned-managed-identity. The database does not validate the ID, so a wrong value only fails at sign-in. Validate on Azure SQL in a non-production environment before the first deployment.

```sql
-- SID: the object (principal) ID as binary(16), e.g. CONVERT(varbinary(16), CAST('<object-id-guid>' AS uniqueidentifier))
DECLARE @portal_sid varbinary(16) = CONVERT(varbinary(16), CAST('<portal-identity-object-id>' AS uniqueidentifier));
DECLARE @ingest_sid varbinary(16) = CONVERT(varbinary(16), CAST('<ingest-identity-object-id>' AS uniqueidentifier));

DECLARE @sql nvarchar(max);
IF DATABASE_PRINCIPAL_ID(N'<portal-identity-name>') IS NULL
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(N'<portal-identity-name>') + N' WITH SID = ' + CONVERT(nvarchar(34), @portal_sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;
IF DATABASE_PRINCIPAL_ID(N'<ingest-identity-name>') IS NULL
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(N'<ingest-identity-name>') + N' WITH SID = ' + CONVERT(nvarchar(34), @ingest_sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;

ALTER ROLE portal_reader ADD MEMBER [<portal-identity-name>];
ALTER ROLE portal_writer ADD MEMBER [<portal-identity-name>];
ALTER ROLE portal_ingest ADD MEMBER [<ingest-identity-name>];
```

**Azure SQL validation is required before the first deployment:** run this step and the verify query against a non-production Azure SQL database and record the result. `TYPE = E` is an Azure SQL feature; the local SQL Server 2022 container rejects it, so this step runs only against Azure SQL and is not part of `stack:up`. The role grants themselves are applied by the migration and covered by the container test.

Replace the `<...>` placeholders in the pipeline, not in a committed file. Re-running is safe: existing users are kept and role membership is idempotent.

## Verify

```sql
SELECT r.name AS role_name, m.name AS member_name
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE m.name IN (N'<portal-identity-name>', N'<ingest-identity-name>');
```

Also check `SELECT IS_ROLEMEMBER('db_owner', N'<name>')` is 0 for both and that `sys.database_permissions` lists no direct grants for them. Expected: the portal identity in `portal_reader` and `portal_writer`; the ingestion identity in `portal_ingest`; no `db_owner`, `db_ddladmin` or `db_securityadmin` rows for either.

Rotating an identity: create the new user the same way, add it to the role, deploy, then `DROP USER` the old one.

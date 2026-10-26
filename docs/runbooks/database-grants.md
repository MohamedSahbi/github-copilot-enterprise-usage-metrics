# Runbook: database users and grants

Migration `runtime-grants` creates the roles `portal_reader`, `portal_writer` and `portal_ingest`. The later `component-ingestion-roles` migration adds `portal_directory_ingest` and `portal_metrics_ingest` for the directory and metrics paths of the same logical ingestion component (D-34). Neither new role inherits `portal_ingest`. Migrations do not create users: SIDs are environment specific, so a separately authorized deployment step creates them after the runner.

## Rules

- Runtime identities (the portal and the ingestion functions) are never `db_owner`, `db_ddladmin`, `db_securityadmin` or SQL admin. They are members of the roles above and nothing else.
- Grant access through roles only; no per-table grants to users.
- The identity that runs migrations is a deploy-time identity, separate from the runtime identities, and is never used by a running app.
- Users are created with `CREATE USER ... WITH SID = <sid>, TYPE = E` so the database does not need to read Entra.

## Component identity transition (issue #72C)

The component roles are an object/column permission boundary, **not row isolation**.
Both paths need `dim_user` INSERT and UPDATE of `login`/`updated_at`; their other
UPDATE columns differ. INSERT is object-wide and does not enforce immutable
identity or source-specific rows. The shared ingestion user-writer and its
identity-conflict guards remain required.

| Role | Required application surface |
| --- | --- |
| `portal_directory_ingest` | INSERT-only `IngestionRun`; SELECT/INSERT `dim_user`, UPDATE of directory profile/lifecycle/manager columns; SELECT/INSERT and freshness-column UPDATE on `DirectorySyncState`. No login history, staging, raw metrics, access/principal, audit, purge, or DELETE rights. |
| `portal_metrics_ingest` | Run-store/day-loader run SELECT/INSERT/UPDATE; artifact INSERT and SELECT of returned `artifact_id`; issue INSERT; three metrics staging tables SELECT/INSERT; organization and metrics user/history/dimension upserts; fact/aggregate publication and checkpoint updates. No directory-state or directory-attribute UPDATE, access/principal, audit, AI Credits, purge, or DDL rights. |

Exact grants are in `20261026003000.do.component-ingestion-roles.sql`. Application
locks use the default `public` database principal and need no blanket EXECUTE
grant. Metrics bulk copy checks constraints and fires triggers; do not grant
ALTER TABLE or bulk-administrator rights to work around a failed test.

Before deploying this renamed migration, privately inspect the target database's
migration history. The former version `20261026190000` must not be recorded, and
`20261026003000` must not be pending below a later applied version. If either
condition fails, stop and use an approved forward-only migration remediation;
never delete migration history or weaken the planner.

**Do not just add the new role.** An identity that remains in `portal_ingest`,
`portal_reader`, `portal_writer`, `db_datareader`, `db_datawriter`, an owner/admin
role, or an indirectly privileged custom role is not isolated. Keep the
directory app and SCM disabled during this transition. The migration creates
roles but deliberately changes no environment-specific user membership.

For a separately authorized non-production/deployment operation:

1. Obtain each managed identity's **object/principal ID** and expected new-solution
   database from environment outputs. Do not use `AZURE_CLIENT_ID` as the SID.
   Never target the old database. Create a missing TYPE=E user using the pattern
   below; for an existing name compare `sys.database_principals.sid` and `type`
   to the expected binary object ID and `E`. Stop on mismatch; do not silently
   retain or replace a differently bound principal.
2. Inventory direct grants, role memberships, nested-role inheritance, database
   ownership, and roles owning schemas/objects. Runtime identities must not own
   the database, schemas, objects, or roles. Identify consumers of the existing
   ingestion identity (including importer, AI Credits and purge); this
   metrics-only role does not grant those future consumers access.
3. In the approved maintenance window, remove the component identity's known
   broad memberships, then add only its component role. For example, after
   verifying the target identity and its consumers:

   ```sql
   -- Environment substitution, separately authorized operation only.
   IF IS_ROLEMEMBER(N'portal_ingest', N'<directory-identity-name>') = 1
       ALTER ROLE portal_ingest DROP MEMBER [<directory-identity-name>];
   IF IS_ROLEMEMBER(N'portal_ingest', N'<metrics-identity-name>') = 1
       ALTER ROLE portal_ingest DROP MEMBER [<metrics-identity-name>];
   ALTER ROLE portal_directory_ingest ADD MEMBER [<directory-identity-name>];
   ALTER ROLE portal_metrics_ingest ADD MEMBER [<metrics-identity-name>];
   ```

   Remove any other broad direct or nested role path found in step 2 under the
   reviewed transition plan; unexpected memberships or direct permissions are a
   stop condition, not permission to remove unrelated grants automatically.
   Inspect permissions granted directly to each user and revoke reviewed
   application grants rather than leaving a second permission path. CONNECT
   alone is not an application-table grant.
4. Verify each component user has **only** its intended application role; neither
   component role is a member of another role. Check
   `sys.database_role_members`, `sys.database_permissions` (including column
   `minor_id`), `sys.schemas`, `sys.objects`, and `sys.databases.owner_sid`.
   Also inspect grants to `public` and nested roles: direct membership output
   alone does not prove effective permissions.
5. Run allowed/denied probes as the actual non-production managed identity.
   Use `HAS_PERMS_BY_NAME` or `sys.fn_my_permissions` for the application objects
   and named update columns, and execute the real transaction paths.
   Directory must fail metrics/history/access reads, first/last-seen updates,
   run UPDATE/DELETE, and DDL. Metrics must fail directory-state access,
   Entra/profile/manager updates, artifact UPDATE/DELETE, login-history DELETE,
   access-table reads, audit mutation, and DDL. Both may update the approved
   shared login/timestamp columns; do not report those as isolated by source.

Use this fail-closed identity binding check before changing either component's
membership. The missing-user creation uses the same TYPE=E pattern as the
original example but deliberately assigns no broad role:

```sql
-- Separately authorized Azure SQL operation; substitute private environment outputs.
DECLARE @name sysname = N'<component-identity-name>';
DECLARE @oid uniqueidentifier = '<component-managed-identity-object-id>';
DECLARE @sid binary(16) = CONVERT(binary(16), @oid);
IF EXISTS (
    SELECT 1 FROM sys.database_principals
    WHERE name = @name AND (type <> 'E' OR sid <> @sid)
)
    THROW 51000, 'COMPONENT_IDENTITY_BINDING_MISMATCH', 1;
IF DATABASE_PRINCIPAL_ID(@name) IS NULL
BEGIN
    DECLARE @create nvarchar(max) = N'CREATE USER ' + QUOTENAME(@name)
        + N' WITH SID = ' + CONVERT(nvarchar(34), @sid, 1) + N', TYPE = E';
    EXEC (@create);
END;
```

`node --import tsx scripts/contracts/run-component-grants.ts`
uses a uniquely labelled disposable SQL Server container with an ephemeral
loopback-only port and synthetic SQL logins. Its outer runner traps INT/TERM,
cleans up only the captured owned container and verifies the port is free.
It applies the real migrations
twice, reruns the grant statements, and exercises the actual directory writer
and metrics loader (Blob writes stubbed in memory), allowed/denied columns,
run-store SQL predicates, locking, artifact OUTPUT, constrained bulk and
fact-child cascade. It does not prove Azure TYPE=E sign-in or live effective
permissions. #56 Azure SQL identity validation remains required.

No live user/grant, apply, package deployment, Graph consent, or activation is
authorized by this runbook. #55 restore/rollback, #56, maintenance-window and
owner approval gates remain. Obtain SQL backup/restore evidence and verify
storage recovery settings in the private deployment record; neither a storage
inventory nor this permission migration proves recoverability or authorizes
infrastructure changes.

## Step

The following original portal/general-ingestion example is **not** the component
transition recipe: never assign either directory or metrics component identity
to its broad `portal_ingest` example. Use the role mapping and removal checks
above for those identities.

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

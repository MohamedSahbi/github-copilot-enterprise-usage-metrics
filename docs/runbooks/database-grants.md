# Runbook: database users and grants

Migrations create permission roles, not runtime users. The portal uses `portal_reader` and
`portal_writer`; the metrics and directory ingestion identities use the separate
`portal_metrics_ingest` and `portal_directory_ingest` roles. `portal_ingest` remains a legacy
broad role for other consumers and is not a substitute for either component role.
Its `dim_user` permissions remain unchanged: the contract lands first, then the
Functions consumer switches the metrics loader to the procedure (implemented in
`functions/src/ingestion/user-writer.ts`), then a later small hardening migration
PR removes legacy direct `dim_user` writes. This consumer adds no migration or revoke.
Do not claim isolation for a runtime identity that still uses `portal_ingest`.
These roles constrain object and column permissions, not row-level access; they do not
isolate a component to particular runs, organizations, or users.

The day loader calls `portal.usp_write_metrics_users(@run_id)` inside its existing
SERIALIZABLE publication transaction, after the organization upsert and before
login history, other dimensions and facts. It retains the session day lock and
transaction-owned row/range locks until publication commits or rolls back. The
procedure preserves `MAX(user_login)` and `MIN(usage_day)` per numeric user ID,
including the minimum day as both initial observation dates for a new user.
Only directory ingestion writes directory-owned attributes.

Before any separately authorized deployment, quiesce consumers and coordinate
the reviewed contract migration, consumer package and role-mapping switch. Do not
run an old direct-write package under `portal_metrics_ingest`. The one-time legacy
Blob import must use this consumer's normal loader/replay path and **only**
`portal_metrics_ingest`, never the legacy broad role. The scheduled API timer
uses the same loader; timer packaging is unchanged here. Hosted integration
tests run the real loader with a separate SQL login in only the narrow role,
including publication/replay, history, bulk, checkpoints and denied direct writes.
This is not evidence of applied grants or managed-identity authentication;
#55/#56, maintenance-window and separate owner deployment/import authorization remain required.

## Rules

- Runtime identities are never `db_owner`, `db_ddladmin`, `db_securityadmin` or SQL admin. Each identity has only its intended role and the implicit `public` membership.
- Grant access through roles only; no per-table grants to users.
- The identity that runs migrations is a deploy-time identity, separate from the runtime identities, and is never used by a running app.
- Users are created with `CREATE USER ... WITH SID = <sid>, TYPE = E` so the database does not need to read Entra.
- Never infer that adding a component role narrows existing access. Do not remove unrelated role memberships automatically; stop if preflight finds them.

## Automated step

`scripts/deploy-db.sh` runs both steps below from a release checkout, after `scripts/deploy-infra.sh init` and apply:
`npm run db:migrate`, then `npm run db:runtime-users`, which creates each runtime identity's user from the stack outputs
(`identities`, `sql_server_fqdn`, `sql_database_name`) and maps it to its roles. Each ingestion identity runs the preflight
before and after its role is added. A THROW stops that identity, leaves its access unchanged and fails the step; the
other identities still run. It signs in with the Azure CLI identity's Entra token, so that identity (the pipeline's
service connection) must be a member of the SQL server's Entra admin group, and it must reach the server
(AllowAllWindowsAzureIps, or the agent's network, when private endpoints are off). Re-running is safe.

## Step

After `npm run db:migrate`, create the environment-specific portal, metrics and directory users as the deploy identity. Names and Entra object (principal) IDs come from environment deployment outputs, never this repository. For `CREATE USER ... WITH SID ..., TYPE = E`, use the managed identity **object ID** as the SID, not its client/application ID. The database does not validate the ID, so a wrong value only fails at sign-in. Validate on Azure SQL in a non-production environment before the first deployment.

```sql
-- Each SID is the corresponding managed identity object (principal) ID, never its client ID.
DECLARE @portal_sid varbinary(16) = CONVERT(varbinary(16), CAST('<portal-identity-object-id>' AS uniqueidentifier));
DECLARE @metrics_sid varbinary(16) = CONVERT(varbinary(16), CAST('<metrics-identity-object-id>' AS uniqueidentifier));
DECLARE @directory_sid varbinary(16) = CONVERT(varbinary(16), CAST('<directory-identity-object-id>' AS uniqueidentifier));

DECLARE @sql nvarchar(max);
IF DATABASE_PRINCIPAL_ID(N'<portal-identity-name>') IS NULL
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(N'<portal-identity-name>') + N' WITH SID = ' + CONVERT(nvarchar(34), @portal_sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;
IF DATABASE_PRINCIPAL_ID(N'<metrics-identity-name>') IS NULL
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(N'<metrics-identity-name>') + N' WITH SID = ' + CONVERT(nvarchar(34), @metrics_sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;
IF DATABASE_PRINCIPAL_ID(N'<directory-identity-name>') IS NULL
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(N'<directory-identity-name>') + N' WITH SID = ' + CONVERT(nvarchar(34), @directory_sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;

IF IS_ROLEMEMBER(N'portal_reader', N'<portal-identity-name>') <> 1
    ALTER ROLE portal_reader ADD MEMBER [<portal-identity-name>];
IF IS_ROLEMEMBER(N'portal_writer', N'<portal-identity-name>') <> 1
    ALTER ROLE portal_writer ADD MEMBER [<portal-identity-name>];
```

Run the effective-permission preflight below for each ingestion identity **before** adding its
component role. Then add only the matching role and rerun preflight in mapped mode:

```sql
IF IS_ROLEMEMBER(N'portal_metrics_ingest', N'<metrics-identity-name>') <> 1
    ALTER ROLE portal_metrics_ingest ADD MEMBER [<metrics-identity-name>];
IF IS_ROLEMEMBER(N'portal_directory_ingest', N'<directory-identity-name>') <> 1
    ALTER ROLE portal_directory_ingest ADD MEMBER [<directory-identity-name>];
```

Never add either identity to `portal_ingest`, `portal_metrics_ingest` and
`portal_directory_ingest` together, or a portal role. The component roles do not map identities,
remove legacy memberships, or activate a consumer. This runbook is not deployment authorization.

**Azure SQL validation is required before the first deployment:** `TYPE = E` is an Azure SQL
feature; the local SQL Server 2022 container rejects it. Separately validate the actual managed
identity SID and effective permissions on non-production Azure SQL under the #56 gate. SQL
Server container tests do not prove Azure authentication.

Replace the `<...>` placeholders in the pipeline, not in a committed file. Re-running is safe: existing users are kept and role membership is idempotent.

## Effective-permission preflight

Run this preflight separately for each ingestion identity. Set `@identity_name` and
`@component_role` to either the metrics pair or directory pair. Use
`@require_component_membership = 0` before adding the role, then rerun with `1` after
mapping. Any `THROW` is a hard stop: do not remove role memberships, grants, or ownership
automatically. The permission catalog check includes `PUBLIC` through effective impersonation,
recursive database-role membership, direct grants/denies, database/schema/object/column rights,
object/schema/database ownership and application-procedure execution paths.

The script is [`scripts/db/sql/ingestion-preflight.sql`](../../scripts/db/sql/ingestion-preflight.sql). To run it by hand, replace its three `{{...}}` parameters.

The procedure and
permissions are inspected as the contained user, so `PUBLIC` and effective DENYs are included.
The component role permission manifest is compared with all effective `portal` object writes;
the column check catches column-level grants that can override a table-level DENY. The migration
also explicitly DENYs metrics updates to every directory-owned column.

After both identities pass in mapped mode, record the output of this role inventory and verify
the portal identity remains only in `portal_reader` and `portal_writer`:

```sql
SELECT r.name AS role_name, m.name AS member_name
FROM sys.database_role_members AS rm
JOIN sys.database_principals AS r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals AS m ON m.principal_id = rm.member_principal_id
WHERE m.name IN (N'<portal-identity-name>', N'<metrics-identity-name>', N'<directory-identity-name>')
ORDER BY m.name, r.name;
```

Rotating an identity: create the new user the same way, add it to the role, deploy, then `DROP USER` the old one.

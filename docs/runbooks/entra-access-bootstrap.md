# Runbook: explicit Entra initial access

This command ports the original portal's explicit operator `Grant` intent and
role/scope choices into the new portal database. The original implementation
used an email-keyed access table, an upsert endpoint, and an audit insert after
the mutation. The new implementation uses the existing Entra tenant/object-ID
Principal, validated AccessGrant contract, and an atomic portal audit write.

The original `database.ts` also re-promoted `INITIAL_ADMIN_EMAILS` on every
startup; that implicit email-based behavior is intentionally not ported. The
original README references `Set-CopilotMetricsAccess.ps1`, but that script was
not present in the checked-out original repositories and is not claimed as a
source port.

This is an operator procedure, not automatic provisioning or authorization.
It does not grant SQL permissions, create credentials, deploy code, run
directory sync, change the existing role/scope policy, or authorize a live
access grant. EMU owns actual database checks and any separately approved live
execution. Restore and Azure SQL gates #55/#56 continue to apply.

## Preconditions

- Use the approved operator identity and the existing portal SQL pool
  authentication (`SQL_SERVER`, `SQL_DATABASE`, `AZURE_CLIENT_ID`, and
  `ENTRA_TENANT_ID`). Do not supply a connection string or use migration or
  ingestion credentials.
- Confirm the deployment's expected SQL server/database, the configured
  Entra tenant, target's active immutable object ID, exact requested role and
  scope/value, and approval reference against the private approved roster and
  operator evidence. The target must have one active directory row in
  `portal.dim_user`; no Graph or email lookup is performed.
- Create the version-1 JSON input privately, outside this public repository.
  Restrict it to the operator (`chmod 600 <private-input-file>`), use only
  Entra object IDs (never names, emails, logins, or group claims), and remove
  it under the private record-retention procedure. The command compares the
  configured server, database, and tenant to the manifest and verifies the
  operator object ID against the authenticated SQL session identity.
- The operator's active SQL identity must be an approved, already-authorized
  execution context. This command does not create database users or grant
  SQL roles. If the SQL session cannot yield a GUID Entra object ID or does
  not match the manifest operator ID, execution fails closed.
- The command checks current directory success state before creating an
  executive/admin grant, and checks the current fresh manager edge before a
  team grant. Department/business-area values are validated from active SQL
  directory rows using configured scope settings. It never writes directory
  state.

Input shape (placeholders only; not executable):

```json
{
  "expectedSqlServer": "<new-sql-server.database.windows.net>",
  "expectedSqlDatabase": "<portal-database>",
  "tenantId": "<configured-entra-tenant-object-id>",
  "operatorObjectId": "<authenticated-operator-object-id>",
  "targetObjectId": "<approved-target-object-id>",
  "grant": {
    "role": "<user|manager|executive|admin>",
    "scope": "<self|team|department|business_area|company>",
    "scopeValue": "<empty-or-sql-directory-value>"
  },
  "approvalReference": "<approved-change-reference>"
}
```

The manifest is validated with a strict schema. It contains no credentials.
`operatorObjectId` is only an expected value: attribution comes from
`SUSER_SID()` on the authenticated SQL transaction, and a mismatch is denied.

## Validate and apply

Run from the repository root with the approved Node 22 runtime and locked
dependencies:

```sh
npm run access:bootstrap -- --input <private-input-file>
```

The default is validation-only; it writes no durable Principal, grant, or
audit record. Review the structured summary and correlation ID. Only after the
separate approval and environment preconditions are confirmed, explicitly run:

```sh
npm run access:bootstrap -- --input <private-input-file> --apply
```

No sample input should be stored in this repository. Do not copy real operator,
tenant, target, approval, or scope values into tickets, shell history,
screenshots, logs, or public records.

## Outcomes and verification

- A new active Entra Principal and the one explicitly requested grant are
  committed together with `grant.created` audit evidence. The audit records
  the SQL-authenticated actor object ID, target grant ID, correlation ID, and
  bounded approval/grant metadata.
- Reapplying an already-effective exact grant is a no-op; it does not refresh
  timestamps or create a second audit entry.
- Disabled principals, inactive/missing directory targets, tenant/identity
  collisions, prior directory revocation/unlink evidence, a previously
  revoked exact grant, stale required directory state, invalid scope values,
  or an ineligible team edge fail closed. Nothing is re-enabled, revived,
  upgraded, or implicitly re-granted. A concurrent directory lifecycle
  transaction or bootstrap loses the shared `ingest:directory` lock and must
  be reviewed/retried as a separate operator action.
- If the Principal, grant, or audit write fails, the transaction rolls back;
  a successful-looking output is never emitted.
- After a separately authorized apply, verify access through the existing
  authentication/access readers: Entra resolution uses tenant plus object ID,
  effective permissions come only from `portal.v_active_grant`, and revocation
  or stale elevated access remains immediately enforced. At runtime the
  command connects only to the configured Azure SQL database through the
  existing SQL pool; it does not call Entra, Graph, or Azure APIs. No
  production services were contacted while implementing this runbook.

The old portal's email-based AccessControl table, startup MERGE/re-promotion,
email/group fallback, and non-atomic route mutation are not copied. Admin UI,
revoke/regrant, identity linking, and directory lifecycle ownership remain
separate features and are not changed here.

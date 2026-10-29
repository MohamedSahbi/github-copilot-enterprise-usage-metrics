# Runbook: directory runtime identity boundary

This runbook records the owner-approved target boundary for directory sync and
the operator checks required before any Graph permission is granted. It is
human-readable guidance only; it does not configure or grant access.

## Current source configuration and approved target

The owner approved a dedicated directory-sync Function App with its own managed
identity. Its directory credential path must be isolated from the GitHub App
path used by metrics and AI Credits ingestion. Graph application-permission
consent is a manual operator/admin action outside Terraform, and only for
permissions verified as necessary. No consent, deployment, role assignment, or
secret creation is authorized by this runbook.

**Slice A source configuration is not deployed isolation.** The Terraform
source now assigns the `github-directory-pat` Key Vault reference to the
directory identity, creates a separate keyless directory host-storage account,
and keeps the directory Function App natively disabled with its SCM site
stopped. The directory identity has no role on the metrics raw-archive account
and no SQL principal or role. Its app settings carry the new-solution SQL
server/database reference only; that reference does not grant database access.
Terraform's `secret_names` inventory includes the PAT name but never reads or
manages its value.

This is a source-configuration fact, not evidence of the deployed state. No
apply, package deployment, or runtime verification has been performed; the
environment's live identity assignments and app state remain unverified. A
directory-only Functions v4 timer artifact is now buildable, but no artifact
has been deployed. Do not claim deployed isolation until a separately
authorized deployment is performed and its target state is verified.

The emitted artifact includes a `package-lock.json` derived from the reviewed
root lockfile, with exact runtime dependency versions and their locked
transitive dependency closure. Deployment must preserve that lockfile and run
`npm ci --omit=dev` from the artifact directory before packaging or starting
the app. Do not run `npm install` or otherwise resolve dependencies from the
manifest at deployment time. The deployment wrapper is not part of this
change; verify that it follows this locked-install procedure before any
separately authorized deployment.

The timer uses the required `DIRECTORY_SYNC_SCHEDULE` deployment setting,
expressed as a six-field UTC NCRONTAB expression. Terraform has no default for
this input and validates its syntax and numeric field ranges. Operators must
set a cadence when preparing deployment configuration; examples are hourly
`0 0 * * * *`, daily `0 0 2 * * *`, and weekly `0 0 2 * * 1`. If a missing or
invalid setting bypasses Terraform, the Functions host cannot resolve or parse
the timer schedule and will fail to index/start the timer listener; no
frequency is substituted.
The timer remains unavailable while the Function App is disabled regardless
of a valid schedule.

Slice B contains only the timer/package and schedule configuration. It creates
no component SQL roles or grants. The component permissions contract, its
effective-permission tests, and the later consumer changes remain separate
prerequisites; the buildable package does not prove that SQL access is ready.

The target continues to use the new solution's separate database (D-29, D-34).
The identity split is not permission to create a second logical writer:
`portal.dim_user`, login history, and `portal.DirectorySyncState` retain the
single logical `ingestion` writer. Directory sync owns the directory
attributes, hierarchy, link/revocation lifecycle, and sync-state updates
through that writer. Slice A grants the directory identity no SQL access; the
component writer/access design and any grants require a separately approved
change. A partial or failed run must not advance
`DirectorySyncState.last_success_at`; preserve its existing `scim`, `graph`,
`csv`, and `seats` source values.

## Writer, reader, and credential matrix

| Runtime component / identity | SQL and storage boundary | External credentials and access |
| --- | --- | --- |
| Portal managed identity | Portal read path uses `portal_reader`; portal-owned writes use `portal_writer`. No directory or ingestion writer access. | Portal sign-in OAuth credential and, when enabled, a separate read-only Budget Lookup credential. No ingestion GitHub App key, directory PAT, or Graph permission. |
| Metrics ingestion | The metrics day loader uses `portal_metrics_ingest`, with `dim_user` observations written only through `portal.usp_write_metrics_users` in its SERIALIZABLE publication transaction. The contract, consumer package and runtime mapping switch must be coordinated with consumers quiesced; this is source configuration, not deployed isolation. The legacy Blob import must use only this narrow role after the switch. Raw archive access uses managed identity/RBAC with storage keys disabled. Must not write directory-owned user attributes or sync state as a second writer. AI Credits access is not extended by this metrics role; legacy `portal_ingest` hardening is a later migration. | GitHub App credential for metrics/AI Credits. No directory PAT or directory Graph application permission. If the separate metrics endpoint fact check (#64) requires another credential, it must not reuse the directory PAT. |
| Directory-sync Function App and dedicated managed identity | Slice A source configuration keeps the app disabled and SCM stopped. Its identity uses a separate keyless host-storage account and has no raw-archive role or SQL principal/role. Any later directory writes remain within the one logical `ingestion` writer and new database, subject to the separately approved writer/access design. No old-database access. | Source configuration references the classic PAT only for directory sync, per D-37; its value remains operator-managed in Key Vault. No Graph grant/consent is part of Slice A. Graph access remains gated on verified app-only endpoint support and separate operator/admin consent. |
| Deployment identity | Deployment-time provisioning and migration operations only; never a runtime identity. Runtime identities are not SQL administrators or `db_owner`. | Deployment authentication only. No runtime GitHub or Graph credentials. |

The PAT's existing D-37 scope description (`read:org` and `admin:enterprise`)
is recorded here as an architecture reference, not a new permission grant or a
claim that those scopes have been revalidated. Do not add scopes or change
secret values in this task.

## Soft revocation of disabled Entra accounts (#76)

When a published directory run reads an account that Entra reports as disabled (or deleted), the
directory writer, in the same transaction that publishes the profiles:

- sets `unlinked_at`, `unlink_seq` and `unlink_reason` on the account's active `PrincipalLinkState` row;
- appends a `GrantRevocation` row, on the active-to-disabled transition or once if none exists yet;
- appends one `IngestionAuditEvent` per change, with `detail_json` limited to `{"reason": ...}`.

Nothing is deleted, and `Principal` and `AccessGrant` are not read. `v_active_grant` then hides every
grant issued before the revocation, so a re-enabled account needs a new grant. The tenant comes from
the common `ENTRA_TENANT_ID` app setting; when it is empty, no revocation is written. Failed or
partial runs never revoke.

## Microsoft Graph permission prerequisite

The Graph endpoint and permission references below were checked on
2026-10-25:

| Directory read | Endpoint | Verified application-permission prerequisite |
| --- | --- | --- |
| User collection and selected user attributes | `GET /users` (use `$select` for only the configured attributes) | Microsoft Graph lists `User.Read.All` as the least-privileged application permission for listing users. Verify each configured attribute against its property-specific requirements before requesting consent. |
| Direct manager relationship | `GET /users/{id}/manager` | The Microsoft Graph “List manager” permission table says `Application: Not supported.` Do not use this endpoint for an app-only request based on this reference. |
| Manager expansion on the users collection | `GET /users?$expand=manager` | The “List manager” reference documents this request, while “List users” separately lists `User.Read.All` as the least-privileged application permission for `GET /users` and supports `$expand` generally. The references do not explicitly confirm that this application permission authorizes manager expansion. Treat app-only support and the exact permission for this expanded request as **unverified**; do not infer them from the list-users permission row. |

Sources:

- [List users — permissions and `$select`](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0)
- [List manager — endpoints and permissions](https://learn.microsoft.com/en-us/graph/api/user-list-manager?view=graph-rest-1.0)
- [Microsoft Graph permissions overview — application permissions and consent](https://learn.microsoft.com/en-us/graph/permissions-overview)

Do **not** substitute `Directory.Read.All` or another broader permission to
work around the unverified manager-read prerequisite. Before any Graph
consent, obtain endpoint-specific authoritative evidence for app-only manager
reads and the exact least-privileged application permission. Until that is
verified, do not grant a manager-read application permission or claim that the
expanded users request works app-only. The dedicated Function App and managed
identity remain the approved target; this verification gate does not authorize
a different authentication model, code change, or deployment.

Issue #67 remains open. Reverse traversal through `directReports` is an
unapproved candidate, not an approved replacement algorithm. Incomplete
coverage must never be interpreted as absence or trigger revocation.

Once the endpoint and exact application permission(s) are verified, consent is
a separate manual operator/admin step outside Terraform. Application
permissions require administrator consent; Terraform must not grant consent or
create a secret to represent Graph access. Record the approved permission,
target identity, and consent evidence in the private deployment record, not in
this public runbook. Never record tenant-specific identifiers or secret values
here.

## Choosing the Graph identity (`directory_graph_client_id`)

The directory sync reads Microsoft Graph with one of two identities, chosen in
tfvars:

| `directory_graph_client_id` | Graph identity | What an operator does |
| --- | --- | --- |
| unset (default) | The directory user-assigned managed identity | An Entra admin grants the Graph application permission `User.Read.All` to that identity's service principal, once, outside Terraform. No app registration and no secret. |
| an app registration's client ID | That app registration | Store a client secret of the app in Key Vault as `directory-graph-client-secret`; the app needs `User.Read.All` with admin consent. |

The managed identity is the simpler choice: there is no secret to store,
rotate or leak. Use an app registration when your tenant only grants Graph
permissions to app registrations.

SQL, storage and Key Vault always use the directory managed identity.

## Preconditions before an authorized deployment

1. Keep the Function App and SCM site disabled. A real Functions v4 timer
   registration and directory-only emitting artifact are available as source,
   but are not deployed or routed by an authorized deployment. The SQL
   writer/access design and grants still require separate approval and tests.
   Slice A did not create a SQL principal.
2. Resolve #67's manager-read app-only limitation above before granting Graph
   application permissions. Do not treat incomplete coverage as absence or
   revocation.
3. Keep the #55 restore/rollback and #56 non-production SQL identity gates,
   required maintenance window, human review, and explicit owner deployment
   authorization. A Terraform plan or this source configuration is not
   deployment authorization.
4. Keep the GitHub App and directory PAT on separate access paths. Operators
   manage secret values directly in Key Vault using the configured secret
   names; Terraform carries names and references only.
5. Before a separately authorized deployment, verify the exact plan outputs:
   directory PAT access is limited to the directory identity; directory host
   storage is separate and keyless; the directory identity has no raw-archive
   role or SQL access in A. Verify the directory app remains disabled.
6. Only after the future activation gates pass, verify a complete directory
   sync updates the existing `DirectorySyncState` source row and a
   partial/failed run does not advance `last_success_at`.

No deployment, Graph consent, role change, or secret creation was performed
while preparing this runbook or building the local artifact.

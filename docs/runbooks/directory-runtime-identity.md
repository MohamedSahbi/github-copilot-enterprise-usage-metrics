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

**This is a target architecture, not an isolation claim about the current
environment.** In the source configuration after #111, the Key Vault reference
`github-directory-pat` is assigned to the existing `ingestion` identity, and
the Terraform README describes directory sync as running in the ingestion
Functions app. This is a repository configuration fact; it does not establish
what is deployed. Issue #72 owns the infrastructure change to establish the
approved target boundary. Until that change is implemented and separately
authorized for deployment, do not claim the directory PAT is isolated.

The target continues to use the new solution's separate database (D-29, D-34).
The identity split is not permission to create a second logical writer:
`portal.dim_user`, login history, and `portal.DirectorySyncState` retain the
single logical `ingestion` writer. Directory sync owns the directory
attributes, hierarchy, link/revocation lifecycle, and sync-state updates
through that writer. A partial or failed run must not advance
`DirectorySyncState.last_success_at`; preserve its existing `scim`, `graph`,
`csv`, and `seats` source values.

## Writer, reader, and credential matrix

| Runtime component / identity | SQL and storage boundary | External credentials and access |
| --- | --- | --- |
| Portal managed identity | Portal read path uses `portal_reader`; portal-owned writes use `portal_writer`. No directory or ingestion writer access. | Portal sign-in OAuth credential only. No GitHub App key, directory PAT, or Graph permission. |
| Metrics and AI Credits ingestion | Ingestion-owned SQL writes use `portal_ingest`; raw archive access uses managed identity/RBAC with storage keys disabled. Must not write directory-owned user attributes or sync state as a second writer. | GitHub App credential for metrics/AI Credits. No directory PAT or directory Graph application permission. If the separate metrics endpoint fact check (#64) requires another credential, it must not reuse the directory PAT. |
| Directory-sync Function App and dedicated managed identity (approved target) | Directory data and sync-state writes remain within the one logical `ingestion` writer and the new database. The current `portal_ingest` role is broader than provider-specific table access; #72 must verify the exact SQL grants for the dedicated identity and must not imply that this runbook narrows them. No old-database access. | The classic PAT is for directory-sync use only, per D-37; its value remains operator-managed in Key Vault. Graph access is app-only only after the exact required application permission is verified and separately consented by an operator/admin. |
| Deployment identity | Deployment-time provisioning and migration operations only; never a runtime identity. Runtime identities are not SQL administrators or `db_owner`. | Deployment authentication only. No runtime GitHub or Graph credentials. |

The PAT's existing D-37 scope description (`read:org` and `admin:enterprise`)
is recorded here as an architecture reference, not a new permission grant or a
claim that those scopes have been revalidated. Do not add scopes or change
secret values in this task.

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

Once the endpoint and exact application permission(s) are verified, consent is
a separate manual operator/admin step outside Terraform. Application
permissions require administrator consent; Terraform must not grant consent or
create a secret to represent Graph access. Record the approved permission,
target identity, and consent evidence in the private deployment record, not in
this public runbook. Never record tenant-specific identifiers or secret values
here.

## Preconditions before an authorized deployment

1. Confirm #72 has implemented the dedicated Function App and managed identity,
   and that the deployment plan—not merely a test fixture—targets that identity
   for the directory PAT reference. Do not infer deployment from this document.
2. Resolve the manager-read app-only limitation above before granting Graph
   application permissions. Confirm the exact user attributes and endpoint
   permissions using the current Microsoft Graph API references.
3. Have the authorized operator/admin grant only the verified application
   permissions to the directory-sync identity. This runbook does not perform or
   authorize that action.
4. Keep the GitHub App and directory PAT on separate access paths. Operators
   manage secret values directly in Key Vault using the configured secret
   names; Terraform carries names and references only.
5. Verify SQL and storage access remains keyless and uses managed identity/RBAC.
   Preserve `portal_reader`, `portal_writer`, and `portal_ingest` ownership
   boundaries, and verify the dedicated identity's actual role membership
   against the reviewed #72 plan and deployment outputs.
6. Verify a complete directory sync updates the existing `DirectorySyncState`
   source row and a partial/failed run does not advance `last_success_at`.

No deployment, Graph consent, role change, or secret creation was performed
while preparing this runbook.

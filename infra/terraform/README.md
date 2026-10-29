# infra/terraform

Greenfield Terraform for the portal (§12). It is separate from any other IaC and keeps its own state.

```
bootstrap/                      state storage account (stub; created once per subscription)
stack/                          the single root: calls pinned Azure Verified Modules
```

One root serves every environment. An environment is a tfvars file (with `environment = "dev"`, `"test"` or `"prod"`) plus its own state key, so environments cannot drift in structure and nothing is copied. State, subscription and credentials stay separate per environment (separate state key and OIDC identity per GitHub environment).

## What exists now

The root creates the resource group, monitoring, identities, Storage (metrics raw archive/host and isolated directory host), Key Vault (secrets are created by the operator, see the `secret_names` output), SQL (or references `existing_sql`), one Linux plan with the portal Web App and separate metrics and directory Function Apps, and an alert action group. The directory Function App is natively disabled and its SCM site is stopped unless `directory_sync_enabled` is set. SQL identity users (created by migrations) come with the code that needs them. Every module is pinned to an AVM version revalidated against the registry (§12.1).

Inputs worth knowing:

| Input | Meaning |
| --- | --- |
| `organization` | Enterprise slug, organizations, login suffix, group prefix, directory provider, Entra tenant ID. Passed to the portal as app settings; real values live in the private deployment repository (D-46). |
| `github_app_id` | Required positive-decimal GitHub App identifier, passed only to metrics ingestion; not secret material. The private key remains operator-managed in Key Vault. |
| `backfill_from` | Optional inclusive metrics API start date (`YYYY-MM-DD`); omitted means no historical API fetch. Runtime enforces the moving supported window. |
| `modules` | Optional modules (D-1): `ai_credits`, `budget_lookup`, `feedback`, `upstream_views` (all upstream dashboard views from SQL). Toggling never changes the SQL schema. |
| `network.mode` | `create` (demo), `existing` (enterprise default), or `import` (D-35). |
| `private_endpoints_enabled` | On by default (D-19); disable only for development. |
| `key_vault_allowed_ipv4_addresses` | Unique bare IPv4 possible-outbound addresses for apps that need Key Vault when public access is enabled; Terraform emits `/32` rules and requires a non-empty list when private endpoints are disabled. |
| `portal_allowed_ipv4_addresses` | Optional bare IPv4 addresses allowed to reach the public portal. Each becomes a `/32` Allow rule and the portal default becomes Deny; empty keeps the default Allow (Entra/GitHub sign-in still gates access). Ignored in practice when private endpoints are enabled, because portal public access is then disabled. Keep real addresses in the private deployment configuration. |
| `key_vault_operator_object_ids` | Optional unique Entra **user object IDs**, default `[]`. Each configured user receives vault-scoped `Key Vault Secrets Officer` for operator-managed secrets. These explicit user grants are the only permitted vault-wide secret grants; runtime identities retain per-secret `Key Vault Secrets User`. |
| `existing_sql` | Reference the separately provisioned new-solution SQL server and database; never imported (D-34). |
| `existing_resource_group_name` | Deploy into a pre-existing resource group instead of creating `rg-<name_prefix>-<environment>`. The deploying identity needs Contributor and User Access Administrator on it. |
| `app_service_zone_redundant`, `sql_max_size_gb`, `sql_serverless_min_capacity` | Zone redundancy of the plan (off by default; needs P1v2+), database max size (must suit the SKU: Basic and Standard reject 32), and serverless minimum vCores (default 0.5). |
| `raw_archive_cool_after_months` | Age before raw archive blobs move to Cool (default 13 months). Azure lifecycle rules express age in days, so Terraform rounds up using the average Gregorian month length. The rule applies only to blobs under the `raw/` container prefix and never deletes blobs. |
| `raw_archive_recovery_days` | Days (7–365, default 30) that deleted blobs, deleted containers and noncurrent versions stay recoverable in the metrics raw archive account. Enables versioning plus blob and container soft delete; a lifecycle rule expires noncurrent versions after the same window. Point-in-time restore is not configured. |
| `sql_admin`, `sql_database_sku` | Entra admin of the demo SQL server (Entra-only authentication) and the database SKU. `login_username` is the display name and `object_id` the object ID of a user, group, or managed identity you pass in; Terraform does not create it. The tenant comes from `organization.entra_tenant_id`. |
| `organization.group_prefix` | Display-name prefix of the Entra groups that represent business areas (D-36). Published as the `GROUP_PREFIX` app setting; the directory sync (Phase 2) will read it, nothing uses it yet. Empty means no group-based business-area scoping. |
| `auth_trust_host`, `trusted_forwarding_ingress` | Auth.js forwarded-host trust is off unless explicitly enabled; when false, Terraform omits `AUTH_TRUST_HOST` rather than setting the truthy string `"false"`. `auth_trust_host = true` requires the operator to assert `trusted_forwarding_ingress = true`; this does not provision or verify an ingress. Only make that assertion when a trusted ingress controls forwarded host and protocol headers. |
| `portal_public_url` | Optional HTTPS origin for `AUTH_URL`, default `null`: use the portal app's default `https://<app-name>.azurewebsites.net` origin. For a custom domain, supply its HTTPS origin with no credentials, path, query, or fragment (a trailing slash and port 1–65535 are allowed). Domain binding, certificates, and OAuth callback registration remain operator prerequisites. |
| `auth_microsoft_entra_id_id`, `auth_github_id`, `organization.entra_tenant_id` | Non-secret sign-in app IDs and allowed Entra tenant. The GitHub sign-in OAuth app is separate from ingestion and directory credentials. Existing tenant and directory-provider values are also sent to the portal as app settings. |
| `access_break_glass_group_id`, `access_permission_freshness_minutes`, `access_no_access_message`, `access_request_url`, `access_contact` | Portal access-state settings (D-17). Empty group disables break-glass; freshness defaults to 5 minutes (1–60); empty request URL/contact hide those details. |
| `directory_department_attribute`, `directory_business_area_attribute`, `stale_data_threshold_hours`, `per_user_detail_enabled` | Directory scope paths (empty disables each scope), source staleness (default 36 hours), and aggregate-only/per-user detail control (default false). |
| `min_group_size` | Minimum distinct users a group needs before the portal shows it (default 5, at least 2). Sets the portal's `MIN_GROUP_SIZE`. |
| `directory_sync_schedule` | Required six-field UTC NCRONTAB schedule for the directory timer; Terraform validates numeric field ranges and applies no default cadence. Example: `0 0 2 * * *` (02:00 UTC daily). |
| `metrics_sync_schedule` | Required six-field UTC NCRONTAB schedule, emitted only as `METRICS_SYNC_SCHEDULE` on the metrics app. No default cadence. The metrics timer remains disabled pending #64 and separate activation approval. |
| `directory_sync_enabled` | Optional, default `false`. Set `true` to enable the directory Function App and its SCM site once `github-directory-pat` is in Key Vault and the directory SQL user is mapped (#56). |
| `directory_graph_client_id` | Optional, default `null`. Client ID of an Entra app registration that the directory sync uses for Microsoft Graph instead of its managed identity, for tenants where Graph permissions are granted to an app registration. Create its client secret in Key Vault as `directory-graph-client-secret` (listed in `secret_names`). SQL, storage and Key Vault stay on the managed identity. |
| `metrics_sync_enabled` | Optional, default `false`. Set `true` to enable the metrics timer (`AzureWebJobs.metricsSync.Disabled = false`) once #64 and the #55/#56 gates have passed. |
| `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_GITHUB_SECRET` | Portal-only Key Vault references using the `auth-secret`, `auth-microsoft-entra-id-secret`, and `auth-github-secret` names in the existing `secret_names` output. Terraform never stores or creates the values. |
| `app_service_sku`, `app_service_zone_redundant` | Plan SKU shared by the portal and both Functions apps (default `B1`; B, S, Premium v2/v3/v4 and memory-optimized SKUs are accepted). Zone redundancy needs a Premium SKU. |
| `sql_max_size_gb`, `sql_serverless_min_capacity` | Demo database size and serverless minimum vCores (defaults `32` and `0.5`). The size is checked against `sql_database_sku`. |
| `storage_replication_type` | Replication of the three storage accounts (default `ZRS`; `LRS`, `GRS`, `GZRS`, `RAGRS` and `RAGZRS` are accepted). |
| `network.integration_subnet_id`, `network.private_dns_zones` | Subnet for app VNet integration; private DNS zone IDs keyed `vault`, `blob`, `queue`, `table`, `sql`. |
| `existing_monitoring` | Reference an existing Log Analytics workspace and Application Insights component instead of creating them (D-24). |
| `log_retention_days` | Log Analytics retention when the workspace is created (default 30). |
| `alert_emails` | Email recipients for the Azure Monitor action group (D-50). |

## Use

```bash
cd stack
cp terraform.tfvars.example terraform.tfvars   # git-ignored; non-secret values only
terraform init \
  -backend-config="resource_group_name=<state-rg>" \
  -backend-config="storage_account_name=<state-account>" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=dev.tfstate"
terraform plan -var-file=terraform.tfvars
```

Authenticate with OIDC (`ARM_CLIENT_ID`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_USE_OIDC=true`). Never put secrets in variables or tfvars; Terraform state is sensitive.
The example tfvars contains synthetic IDs and a documentation-range IPv4 address only; it is not deployable as-is. The Key Vault firewall always uses `default_action = "Deny"` and `bypass = "None"`. With private endpoints enabled (the default), public network access remains disabled. If public access is enabled for development, populate `key_vault_allowed_ipv4_addresses` with every possible outbound IPv4 address for each existing App Service that needs Key Vault; Terraform converts each bare address to a `/32` rule. Use the complete `possibleOutboundIpAddresses` inventory, not only current outbound addresses, and refresh the inventory before app recreation or an App Service SKU/scale-unit change. App Service platform changes can also change the possible-address set. For a new environment without an existing address inventory, keep private endpoints enabled or stop for an approved bootstrap design; do not guess future addresses, open the firewall, use the `AzureServices` bypass, or add pipeline IPs.

### Temporary operator secret-management access

Configure only approved Entra user object IDs in `key_vault_operator_object_ids` in private environment configuration; never put application or managed-identity IDs in this list. The `User` principal type is enforced on each assignment, and GUID uniqueness is case-insensitive. An empty list creates no operator grants; removing an ID revokes its Terraform-managed grant on the next apply. `Secrets Officer` allows secret management, not role-assignment management. Deployment identities still require ARM role-assignment permission to apply these grants.

For an approved operator work window on a public-enabled development vault, determine the laptop's **current public IPv4**, add that bare address temporarily to `key_vault_allowed_ipv4_addresses` in uncommitted local/private configuration while preserving all app possible-outbound addresses, review the plan, and apply. Wait for firewall/RBAC propagation, do the approved secret work as the configured user, then remove only the temporary operator address, review the cleanup plan, and apply again. Verify through ARM metadata that the temporary IP rule is absent afterward; if cleanup fails, the work window is not closed and must be escalated. Never leave the laptop IP in committed tfvars or public logs, and remove temporary local overrides after cleanup. If the laptop address already belongs to the required app inventory, retain that app rule rather than deleting it. A changed laptop IP requires a refreshed work-window plan; never widen a rule to a subnet. This procedure does not enable public access for a private-endpoint vault: use its approved private network route instead.

Terraform plan/apply manages the vault firewall, secret-scoped role assignments, and App Service Key Vault references through Azure Resource Manager. It does not call the Key Vault data plane, list secret metadata, or read secret values; the deployment identity does not need Key Vault secret `list`/`get` data-plane access. This deliberately replaces the former plan-time name preflight: a successful plan is not evidence that required secrets exist or that the identities can read only their assigned secrets. Before full apply, an operator must use a separately approved route permitted by the vault firewall to verify that every name from `terraform output -json secret_names` exists, without retrieving or displaying values. After apply and RBAC propagation, the operator must verify from ARM role-assignment metadata that each component identity has only its intended secret-scoped `Key Vault Secrets User` grants and no inherited vault-wide grant, and confirm the App Service Key Vault references are correctly parsed and report `Resolved` without exposing values. Do not deploy portal code until these checks pass. If a reference remains unresolved after propagation, use the approved App Service Key Vault-reference refresh operation and verify again. Never put secret values in Terraform.

For a brand-new environment, create the vault and its network path first, then create every secret named by `terraform output -json secret_names` before the full apply that creates secret-scoped role assignments. For an existing environment, create any newly required names before that full apply. The private deployment repository supplies real client IDs, tenant ID, and access settings. `SQL_SERVER`, `SQL_DATABASE`, and the component-specific `AZURE_CLIENT_ID` settings are wired by the stack. The portal identity receives only portal sign-in secrets and the optional Budget Lookup key; the metrics identity receives the GitHub App key and optional AI Credits token; the directory identity receives only the directory PAT.

### Metrics App configuration update

The required nonsecret `github_app_id` input is a migration for all existing environments:
add a positive-decimal value to each private environment tfvars before the first full plan with
this version. New deployments must supply it in their initial tfvars, whether SQL/resource-group
resources are created or referenced as existing. Do not use the portal's `auth_github_id`.
The existing Key Vault secret `github-app-private-key` remains operator-created and retains its
existing ingestion-only role assignment. The stack supplies it to the metrics Function only as
an App Service Key Vault reference; no secret value is read or stored by Terraform.

The optional `backfill_from` input is omitted by default and emitted as `BACKFILL_FROM` only when
set. This selects an inclusive historical API fetch date; omission does not request a historical
fetch. Terraform validates the static date form, and the runtime rejects values outside the
supported moving API window.

Existing environments must also add `metrics_sync_schedule` to their private tfvars;
there is no default. Standard UTC syntax examples are `0 0 * * * *` (hourly),
`0 0 2 * * *` (daily), and `0 0 2 * * 1` (weekly). These examples do not select an
operator cadence. Missing or invalid schedules fail Terraform validation; a
bypassed invalid setting prevents the Functions host from indexing the timer.
The stack sets `AzureWebJobs.metricsSync.Disabled = true` unless `metrics_sync_enabled`
is set to `true`: #64 remains the live App proof gate, and activation requires
separate authorization. No PAT fallback or installation-ID configuration is introduced here.

`npm run build --workspace functions` emits two separate deployable roots:
`functions/dist/artifact` for directory and `functions/dist/metrics-artifact`
for metrics. Each has its own `host.json`, dependency manifest, and
`main: dist/function.js`. Select the component's root, not the workspace package,
for deployment. The metrics artifact registers `metricsSync` and composes real
App acquisition and the existing day loader; it contains no directory handler,
Graph/SCIM client, or directory PAT reference. The directory artifact excludes
metrics acquisition and Blob code. Packaging is not deployment or live evidence.

## Directory runtime status

Slice A provisions a separate directory Function App and user-assigned identity on the shared Linux plan. Its ARM properties default to `enabled = false` and `scmSiteAlsoStopped = true`; only `directory_sync_enabled = true` turns both on. Its `AzureWebJobsStorage` identity-based settings point to a separate keyless host-storage account, and only the directory identity receives roles on that account. The metrics identity retains access to the existing raw archive and its own host storage; the directory identity receives no role on that account. Raw archive lifecycle settings are unchanged.

Terraform moves the `github-directory-pat` Key Vault reference and secret-scoped role assignment to the directory identity. Operators remain responsible for creating/rotating the secret value and performing the explicit pre-apply existence and post-apply access/reference checks above; Terraform never checks secret existence or reads, imports, or writes secret values. Portal OAuth and optional Budget Lookup secrets remain portal-only; the GitHub App key and optional AI Credits token remain metrics-only.

The directory app receives the new solution's SQL server/database reference, but Terraform creates no directory SQL principal, user, or role membership. SQL access is intentionally absent and fail-closed until a separately approved writer/access design is implemented. The non-secret `directory_runtime` output contains only the app/storage resource references and new-solution database names.

This is source configuration, not deployed isolation: no apply or directory code deployment is included. `functions/` registers a Functions v4 timer and builds a directory-only artifact with an explicit runtime dependency manifest; the directory schedule is a required Terraform input and app setting with numeric range validation. If a missing or invalid schedule bypasses Terraform, it prevents the Functions host from resolving/indexing the timer listener; no default cadence is substituted. Keep `directory_sync_enabled` false until the SQL writer/access design, #67's manager-permission decision, and the remaining #55/#56, maintenance-window, review, and owner deployment gates are satisfied. This work does not resolve #67, authorize Graph grants/consent or live calls, create a database identity, deploy a package, or complete #72.

## Check without Azure

`bash scripts/terraform-check.sh` runs `terraform fmt -check`, `validate`, mocked plans for the demo and enterprise-style examples, and valid/invalid input tests without a backend or Azure credentials.

## AVM versions (revalidated 2026-10-24, §12.1)

Pinned exactly in the stack. Check the registry again before each new module.

| Module | Pinned | Note |
| --- | --- | --- |
| `avm-res-operationalinsights-workspace` | 0.5.1 | Same as the record. |
| `avm-res-insights-component` | 0.5.0 | Record said 0.4.0. 0.5.0 takes `parent_id` (resource group ID) instead of `resource_group_name` and uses the azapi provider. |
| `avm-res-managedidentity-userassignedidentity` | 0.5.3 | Same as the record. |
| `avm-res-keyvault-vault` 0.12.0, `avm-res-sql-server` 0.2.1, `avm-res-storage-storageaccount` 0.10.0, `avm-res-web-site` 0.24.1 | as pinned | Same as the record. Storage and web-site use `parent_id`. |
| `avm-res-web-serverfarm` 2.0.8, `avm-res-insights-actiongroup` 0.1.0 | new | Not in §12.1; used for the App Service plan and the action group. |
| `avm-res-network-virtualnetwork` 0.22.3, `avm-res-apimanagement-service` 0.9.0 | not yet used | Same as the record. |

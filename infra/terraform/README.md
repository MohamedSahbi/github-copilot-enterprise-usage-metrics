# infra/terraform

Greenfield Terraform for the portal (§12). It is separate from any other IaC and keeps its own state.

```
bootstrap/                      state storage account (stub; created once per subscription)
stack/                          the single root: calls pinned Azure Verified Modules
```

One root serves every environment. An environment is a tfvars file (with `environment = "dev"`, `"test"` or `"prod"`) plus its own state key, so environments cannot drift in structure and nothing is copied. State, subscription and credentials stay separate per environment (separate state key and OIDC identity per GitHub environment).

## What exists now

The root creates the resource group, monitoring, identities, Storage (metrics raw archive/host and isolated directory host), Key Vault (secrets are created by the operator, see the `secret_names` output), SQL (or references `existing_sql`), one Linux plan with the portal Web App and separate metrics and directory Function Apps, and an alert action group. The directory Function App is natively disabled, its SCM site is stopped, and Terraform exposes no activation input. SQL identity users (created by migrations) come with the code that needs them. Every module is pinned to an AVM version revalidated against the registry (§12.1).

Inputs worth knowing:

| Input | Meaning |
| --- | --- |
| `organization` | Enterprise slug, organizations, login suffix, group prefix, directory provider, Entra tenant ID. Passed to the portal as app settings; real values live in the private deployment repository (D-46). |
| `modules` | Optional modules (D-1): `ai_credits`, `budget_lookup`, `feedback`. Toggling never changes the SQL schema. |
| `network.mode` | `create` (demo), `existing` (enterprise default), or `import` (D-35). |
| `private_endpoints_enabled` | On by default (D-19); disable only for development. |
| `existing_sql` | Reference the separately provisioned new-solution SQL server and database; never imported (D-34). |
| `existing_resource_group_name` | Deploy into a pre-existing resource group instead of creating `rg-<name_prefix>-<environment>`. The deploying identity needs Contributor and User Access Administrator on it. |
| `app_service_zone_redundant`, `sql_max_size_gb`, `sql_serverless_min_capacity` | Zone redundancy of the plan (off by default; needs P1v2+), database max size (must suit the SKU: Basic and Standard reject 32), and serverless minimum vCores (default 0.5). |
| `raw_archive_cool_after_months` | Age before raw archive blobs move to Cool (default 13 months). Azure lifecycle rules express age in days, so Terraform rounds up using the average Gregorian month length. The rule applies only to blobs under the `raw/` container prefix and never deletes blobs. |
| `sql_admin`, `sql_database_sku` | Entra admin of the demo SQL server (Entra-only authentication) and the database SKU. `login_username` is the display name and `object_id` the object ID of a user, group, or managed identity you pass in; Terraform does not create it. The tenant comes from `organization.entra_tenant_id`. |
| `organization.group_prefix` | Display-name prefix of the Entra groups that represent business areas (D-36). Published as the `GROUP_PREFIX` app setting; the directory sync (Phase 2) will read it, nothing uses it yet. Empty means no group-based business-area scoping. |
| `auth_trust_host`, `trusted_forwarding_ingress` | Auth.js forwarded-host trust is off unless explicitly enabled; when false, Terraform omits `AUTH_TRUST_HOST` rather than setting the truthy string `"false"`. `auth_trust_host = true` requires the operator to assert `trusted_forwarding_ingress = true`; this does not provision or verify an ingress. Only make that assertion when a trusted ingress controls forwarded host and protocol headers. |
| `auth_microsoft_entra_id_id`, `auth_github_id`, `organization.entra_tenant_id` | Non-secret sign-in app IDs and allowed Entra tenant. The GitHub sign-in OAuth app is separate from ingestion and directory credentials. Existing tenant and directory-provider values are also sent to the portal as app settings. |
| `access_break_glass_group_id`, `access_permission_freshness_minutes`, `access_no_access_message`, `access_request_url`, `access_contact` | Portal access-state settings (D-17). Empty group disables break-glass; freshness defaults to 5 minutes (1–60); empty request URL/contact hide those details. |
| `directory_department_attribute`, `directory_business_area_attribute`, `stale_data_threshold_hours`, `per_user_detail_enabled` | Directory scope paths (empty disables each scope), source staleness (default 36 hours), and aggregate-only/per-user detail control (default false). |
| `directory_sync_schedule` | Required six-field UTC NCRONTAB schedule for the directory timer; Terraform validates numeric field ranges and applies no default cadence. Example: `0 0 2 * * *` (02:00 UTC daily). |
| `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_GITHUB_SECRET` | Portal-only Key Vault references using the `auth-secret`, `auth-microsoft-entra-id-secret`, and `auth-github-secret` names in the existing `secret_names` output. Terraform never stores or creates the values. |
| `app_service_sku` | Plan SKU shared by the portal and both Functions apps (default `B1`). |
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
The example tfvars includes synthetic IDs only. For a brand-new environment, bootstrap only the vault with a targeted plan/apply (`-target=module.key_vault`), then create every secret named by `terraform output -json secret_names` in that vault. For an existing environment, create any newly required names in its vault before running the full plan. In either case, a full plan checks names without reading values and fails with the missing names before creating any app or secret-scoped role assignment; the deployment identity needs permission to list secret metadata for this check. This preflight checks presence only, not secret validity or runtime readability. App Services depend on completion of the secret-scoped role assignments before their settings are applied. Because Azure RBAC propagation is eventual, confirm Key Vault references report `Resolved` before deploying portal code; if a reference remains unresolved after propagation, invoke the App Service Key Vault-reference refresh operation and verify again. The portal identity receives only portal sign-in secrets and the optional Budget Lookup key; the metrics identity receives the GitHub App and optional AI Credits token; the directory identity receives only the directory PAT. Never put secret values in Terraform. The private deployment repository supplies real client IDs, tenant ID, and access settings. `SQL_SERVER`, `SQL_DATABASE`, and the component-specific `AZURE_CLIENT_ID` settings are wired by the stack.

## Directory runtime status

Slice A provisions a separate directory Function App and user-assigned identity on the shared Linux plan. Its ARM properties are hard-coded to `enabled = false` and `scmSiteAlsoStopped = true`; no tfvars setting or ignore-drift rule can enable it. Its `AzureWebJobsStorage` identity-based settings point to a separate keyless host-storage account, and only the directory identity receives roles on that account. The metrics identity retains access to the existing raw archive and its own host storage; the directory identity receives no role on that account. Raw archive lifecycle settings are unchanged.

Terraform moves the `github-directory-pat` Key Vault reference and secret-scoped role assignment to the directory identity. Operators remain responsible for creating/rotating the secret value; Terraform only checks the name and never reads, imports, or writes the value. Portal OAuth and optional Budget Lookup secrets remain portal-only; the GitHub App key and optional AI Credits token remain metrics-only.

The directory app receives the new solution's SQL server/database reference, but Terraform creates no directory SQL principal, user, or role membership. SQL access is intentionally absent and fail-closed until a separately approved writer/access design is implemented. The non-secret `directory_runtime` output contains only the app/storage resource references and new-solution database names.

This is source configuration, not deployed isolation: no apply or directory code deployment is included. `functions/` registers a Functions v4 timer and builds a directory-only artifact with an explicit runtime dependency manifest; the directory schedule is a required Terraform input and app setting with numeric range validation. If a missing or invalid schedule bypasses Terraform, it prevents the Functions host from resolving/indexing the timer listener; no default cadence is substituted. Keep the Function App and its SCM site disabled until the SQL writer/access design, #67's manager-permission decision, and the remaining #55/#56, maintenance-window, review, and owner deployment gates are satisfied. This work does not resolve #67, authorize Graph grants/consent or live calls, create a database identity, deploy a package, or complete #72.

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

# infra/terraform

Greenfield Terraform for the portal (§12). It is separate from any other IaC and keeps its own state.

```
bootstrap/                      state storage account (stub; created once per subscription)
stack/                          the single root: calls pinned Azure Verified Modules
```

One root serves every environment. An environment is a tfvars file (with `environment = "dev"`, `"test"` or `"prod"`) plus its own state key, so environments cannot drift in structure and nothing is copied. State, subscription and credentials stay separate per environment (separate state key and OIDC identity per GitHub environment).

## What exists now

The root creates the resource group, monitoring, identities, Storage (raw archive and Functions host), Key Vault (secrets are created by the operator, see the `secret_names` output), SQL (or references `existing_sql`), one Linux plan with the portal Web App and the ingestion Function App, and an alert action group. Alert rules and the SQL identity users (created by migrations) come with the code that needs them. Every module is pinned to an AVM version revalidated against the registry (§12.1).

Inputs worth knowing:

| Input | Meaning |
| --- | --- |
| `organization` | Enterprise slug, organizations, login suffix, group prefix, directory provider, Entra tenant ID. Passed to the portal as app settings; real values live in the private deployment repository (D-46). |
| `modules` | Optional modules (D-1): `ai_credits`, `budget_lookup`, `feedback`. Toggling never changes the SQL schema. |
| `network.mode` | `create` (demo), `existing` (enterprise default), or `import` (D-35). |
| `private_endpoints_enabled` | On by default (D-19); disable only for development. |
| `existing_sql` | Reference the shared SQL server and database; never imported (D-34). |
| `existing_resource_group_name` | Deploy into a pre-existing resource group instead of creating `rg-<name_prefix>-<environment>`. The deploying identity needs Contributor and User Access Administrator on it. |
| `app_service_zone_redundant`, `sql_max_size_gb`, `sql_serverless_min_capacity` | Zone redundancy of the plan (off by default; needs P1v2+), database max size (must suit the SKU: Basic and Standard reject 32), and serverless minimum vCores (default 0.5). |
| `raw_archive_cool_after_months` | Age before raw archive blobs move to Cool (default 13 months). Azure lifecycle rules express age in days, so Terraform rounds up using the average Gregorian month length. The rule applies only to blobs under the `raw/` container prefix and never deletes blobs. |
| `sql_admin`, `sql_database_sku` | Entra admin of the demo SQL server (Entra-only authentication) and the database SKU. `login_username` is the display name and `object_id` the object ID of a user, group, or managed identity you pass in; Terraform does not create it. The tenant comes from `organization.entra_tenant_id`. |
| `organization.group_prefix` | Display-name prefix of the Entra groups that represent business areas (D-36). Published as the `GROUP_PREFIX` app setting; the directory sync (Phase 2) will read it, nothing uses it yet. Empty means no group-based business-area scoping. |
| `app_service_sku` | Plan SKU shared by the portal and ingestion apps (default `B1`). |
| `network.integration_subnet_id`, `network.private_dns_zones` | Subnet for app VNet integration; private DNS zone IDs keyed `vault`, `blob`, `queue`, `table`, `sql`. |
| `existing_monitoring` | Reference an existing Log Analytics workspace and Application Insights component instead of creating them (D-24). |
| `log_retention_days` | Log Analytics retention when the workspace is created (default 30). |
| `alert_emails`, `stale_data_threshold_hours` | Alert routing and the staleness threshold (D-50). |

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

## Check without Azure

`bash scripts/terraform-check.sh` runs `terraform fmt -check` and `validate` for the root without a backend or credentials.

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

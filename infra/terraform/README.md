# infra/terraform

Greenfield Terraform for the portal (§12). It is separate from any other IaC and keeps its own state.

```
bootstrap/                      state storage account (stub; created once per subscription)
stack/                          thin composition layer; calls pinned Azure Verified Modules
environments/{dev,test,prod}/   one root and one state per environment
```

## What exists now

The `stack` module defines the full input surface and the resource group. The AVM resources (Log Analytics, Application Insights, Key Vault, Storage, SQL, identities, web and function apps, alerts) are added in later changes, each pinned to an AVM version revalidated against the registry (§12.1).

Inputs worth knowing:

| Input | Meaning |
| --- | --- |
| `organization` | Enterprise slug, organizations, login suffix, group prefix, directory provider, Entra tenant ID. Passed to the portal as app settings; real values live in the private deployment repository (D-46). |
| `modules` | Optional modules (D-1): `ai_credits`, `budget_lookup`, `feedback`. Toggling never changes the SQL schema. |
| `network.mode` | `create` (demo), `existing` (enterprise default), or `import` (D-35). |
| `private_endpoints_enabled` | On by default (D-19); disable only for development. |
| `existing_sql` | Reference the shared SQL server and database; never imported (D-34). |
| `existing_monitoring` | Reference an existing Log Analytics workspace and Application Insights component instead of creating them (D-24). |
| `log_retention_days` | Log Analytics retention when the workspace is created (default 30). |
| `alert_emails`, `stale_data_threshold_hours` | Alert routing and the staleness threshold (D-50). |

## Use

```bash
cd environments/dev
cp terraform.tfvars.example terraform.tfvars   # git-ignored; non-secret values only
terraform init \
  -backend-config="resource_group_name=<state-rg>" \
  -backend-config="storage_account_name=<state-account>" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=dev.tfstate"
terraform plan
```

Authenticate with OIDC (`ARM_CLIENT_ID`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_USE_OIDC=true`). Never put secrets in variables or tfvars; Terraform state is sensitive.

## Check without Azure

`bash scripts/terraform-check.sh` runs `terraform fmt -check` and `validate` for every root without a backend or credentials.

## AVM versions (revalidated 2026-10-24, §12.1)

Pinned exactly in the stack. Check the registry again before each new module.

| Module | Pinned | Note |
| --- | --- | --- |
| `avm-res-operationalinsights-workspace` | 0.5.1 | Same as the record. |
| `avm-res-insights-component` | 0.5.0 | Record said 0.4.0. 0.5.0 takes `parent_id` (resource group ID) instead of `resource_group_name` and uses the azapi provider. |
| `avm-res-managedidentity-userassignedidentity` | 0.5.3 | Same as the record. |
| `avm-res-keyvault-vault` 0.12.0, `avm-res-sql-server` 0.2.1, `avm-res-storage-storageaccount` 0.10.0, `avm-res-web-site` 0.24.1, `avm-res-network-virtualnetwork` 0.22.3, `avm-res-apimanagement-service` 0.9.0 | not yet used | Latest on the registry equals the record. |

---
description: "Use when writing or reviewing Terraform, AVM modules, tfvars, networking modes, module toggles, or Azure resource wiring."
applyTo: "infra/**"
---

# Terraform (D-1, D-19, D-24, D-34, D-35)

- Use pinned Azure Verified Modules; re-check the registry for the current version before adding one. Custom code only for composition glue.
- Separate state per environment; remote backend in Azure Storage; OIDC for CI. Workspaces alone are not an isolation boundary.
- Network dependencies (subnets, private endpoints, private DNS zones) support three modes: `create` (demo), `existing` (enterprise default, read-only references), `import` (import blocks kept in the deployment's own config).
- SQL server and database support `existing` (shared with the budget Function App) and `create` (demo).
- Application Insights and Log Analytics are created by default; accept existing resource IDs.
- Module toggles: `modules = { ai_credits, budget_lookup, feedback }`. A flag creates the module's app settings, role assignments, and an empty Key Vault secret slot. It never changes SQL schema.
- No secret values in variables, outputs, or state. Create empty Key Vault secrets; operators fill them.
- Least-privilege managed identities per component: portal, ingestion, directory sync, deployment.
- `terraform fmt`, `validate`, and a saved plan must pass in CI; prod apply needs approval.

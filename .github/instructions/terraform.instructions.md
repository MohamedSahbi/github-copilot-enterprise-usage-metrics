---
description: "Use when writing or reviewing Terraform, AVM modules, tfvars, networking modes, module toggles, or Azure resource wiring."
applyTo: "infra/**"
---

# Terraform (D-1, D-19, D-24, D-34, D-35)

- Use pinned Azure Verified Modules; re-check the registry for the current version before adding one. Custom code only for composition glue.
- Separate state per environment; remote backend in Azure Storage; OIDC for CI. Workspaces alone are not an isolation boundary.
- Network dependencies (subnets, private endpoints, private DNS zones) support three modes: `create` (demo), `existing` (enterprise default, read-only references), `import` (import blocks kept in the deployment's own config).
- SQL resources support `existing` (separately provisioned for the new solution) and `create`. The database must be separate from the old solution; a separate logical SQL server is not required. Do not point at the old database or provision runtime cross-database comparison access (D-29, D-34). Budget Lookup is a scoped live, read-only GitHub API exception to D-11 (D-55), not old-database access.
- Application Insights and Log Analytics are created by default; accept existing resource IDs.
- Module toggles: `modules = { ai_credits, budget_lookup, feedback }`. A flag wires the module's app settings, Key Vault references, role assignments, and required secret names in the existing `secret_names` output. It never changes SQL schema.
- Names only: no secret values in variables, tfvars, outputs, or state. Terraform provisions the vault and references, but neither manages/imports secret values nor creates empty secret slots. Operators create and rotate values in Key Vault using the names in `secret_names`; preserve the existing output and Key Vault references.
- Least-privilege managed identities per component: portal, ingestion, directory sync, deployment.
- `terraform fmt`, `validate`, and a saved plan must pass in CI; prod apply needs approval.

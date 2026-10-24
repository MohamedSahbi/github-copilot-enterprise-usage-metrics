---
name: terraform-conventions
description: 'Rules for writing and reviewing the portal Terraform in infra/terraform (§12): one root, per-environment tfvars and state, AVM pinning, secrets, and what to keep simple. Use before adding or changing any Terraform.'
---

# Terraform conventions

Keep the IaC boring. Prefer fewer files, fewer layers, and no copy-paste.

## Structure

- **One root:** `infra/terraform/stack`. No per-environment directories and no wrapper modules. An environment is a tfvars file (`environment = "dev"`) plus its own state key. Separate environments by state key, subscription and OIDC identity, not by copied code.
- **Add a module only for repetition** inside the root (for example one identity per role with `for_each`). Do not write a custom module around a resource that an AVM already covers.
- **One file per concern:** `monitoring.tf`, `identities.tf`, `storage.tf`, and so on. Variables, outputs and versions stay in their own files.

## Inputs

- Follow the `config-placement` skill for every new input.
- Type and validate every variable. Give a default only when it is safe for production.
- `create` / `existing` / `import` modes for dependencies owned elsewhere (D-19, D-34, D-35). Never create what is marked `existing`.

## Modules and providers

- Pin AVM versions exactly. Check the registry before each new module and record changes in `infra/terraform/README.md`.
- Commit `.terraform.lock.hcl`; never commit `.terraform/`, state, or real tfvars.
- Authenticate with OIDC only (`ARM_USE_OIDC`). No stored credentials.

## Secrets

- No secret values in variables, outputs, tfvars or state. Create empty Key Vault secret slots; operators fill them.
- Mark outputs that carry connection strings `sensitive`.

## Checks before a PR

1. `bash scripts/terraform-check.sh` (fmt and validate).
2. If Azure access exists, `terraform plan` with the example tfvars and paste the resource summary into the PR.
3. State any AVM version change as a deviation in the PR description.

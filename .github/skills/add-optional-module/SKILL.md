---
name: add-optional-module
description: 'Add or extend an optional portal module (AI Credits, Budget Lookup, Feedback, or a new one) with Terraform flag, schema, secret reference, health check, and pages. Use when creating a module or wiring a module end to end.'
---

# Add an optional module (D-1, D-13)

A module must be enabled by a Terraform flag, one secret, and one permission. Nothing else.

## Checklist

1. **Schema** — add tables in a new migration under `db/migrations/` in the `portal` schema. Tables exist even when the module is off.
2. **Contracts** — add DTOs and row types in `shared/`.
3. **Backend** — add the timer Function (if the module ingests data) under `functions/`, following the ingestion pipeline rules.
4. **API** — add scoped, aggregate-by-default routes; apply authorization rules and tests.
5. **Pages** — add pages in our navigation, hidden when the flag is off. Flags never grant access.
6. **Terraform** — add the key to `modules`, the app setting with its Key Vault reference, the managed-identity role assignments, and the required name in the existing `secret_names` output. Operators create and rotate values in Key Vault; Terraform neither manages/imports secret values nor creates empty secret slots.
7. **Health** — add the module to the admin health page: secret present, permission OK, last run OK.
8. **Docs** — add an operator section: which secret, which GitHub or Entra permission, how to verify.
9. **Tests** — unit, authorization, and a Terraform plan check with the flag on and off.

## Do not

- Add plugin or override mechanisms.
- Write to tables owned by another component.

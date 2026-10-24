---
name: config-placement
description: 'Decide where a setting, fact, or credential lives: Terraform variable (tfvars), deployment YAML, GitHub environment variable, Key Vault, app setting, or Markdown note. Use when adding any configuration input, when writing or changing the deployment template or EMU repository, or when a value is about to be put in a document.'
---

# Config placement (D-13, D-46, D-9, D-37)

EMU and company repositories carry configuration only (D-13). Real organization values exist only in those private repositories; the public repositories carry placeholders and examples (D-46).

## Rule: structured data is never kept in prose

A value that any tool, pipeline, or the portal reads goes in a machine-readable, validated file. Markdown is only for facts a human reads.

## Where each kind of value goes

| The value is... | Put it in | Example |
| --- | --- | --- |
| Input to Terraform or becomes an app setting | `config/<env>.tfvars`, with a typed and validated variable in `infra/terraform/stack` | enterprise slug, login suffix, group prefix, tenant ID, module flags, network mode, alert emails |
| Read by the pipeline, not by Terraform | `config/deployment.yml` in the deployment repository | portal repository and pinned version, list of environments |
| Per-environment pipeline identity (not secret) | GitHub environment **variables** | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `TFSTATE_*` |
| A secret or credential | Key Vault (runtime) or GitHub environment secret (pipeline); never a file, variable default, output, or state | GitHub App key, classic PAT, OAuth client secret |
| Human-only knowledge | `docs/deployment-note.md` (private) | who the admins are, expiry and rotation dates, rationale |
| A decision for everyone | The decision record, via a new D-number | |

## Checklist for a new setting

1. Pick the row above. If more than one fits, the value is probably two values.
2. Add a typed Terraform variable with `validation` and a description; no `any` in the stack (environment roots may pass `any` through).
3. Add it to every `terraform.tfvars.example` and to the template `config/*.tfvars` with a `REPLACE` marker when it is organization-specific.
4. If it becomes an app setting, add it to the stack's app settings and to the portal's startup validation, so a missing value fails at startup with a clear message.
5. Run `bash scripts/terraform-check.sh`. Test one bad value to prove the validation rejects it.
6. Public repositories: placeholders only. Run the denylist check before pushing.

## Stop and ask when

- A value could be either a secret or a setting (for example an identifier that grants access): treat it as a secret.
- The setting changes module behaviour beyond a flag: that is a fork, not configuration (D-13).

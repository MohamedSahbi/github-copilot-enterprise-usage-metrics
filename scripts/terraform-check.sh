#!/usr/bin/env bash
# Formats and validates the Terraform root without a backend or credentials (§12.3).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/infra/terraform"

terraform fmt -check -recursive
terraform -chdir=stack init -backend=false -input=false >/dev/null
terraform -chdir=stack validate
terraform -chdir=stack test -no-color -var-file=terraform.tfvars.example
bash "$repo_root/scripts/test-terraform-variable-validation.sh"

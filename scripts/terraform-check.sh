#!/usr/bin/env bash
# Formats and validates the Terraform root without a backend or credentials (§12.3).
set -euo pipefail
cd "$(dirname "$0")/../infra/terraform"

terraform fmt -check -recursive
terraform -chdir=stack init -backend=false -input=false >/dev/null
terraform -chdir=stack validate

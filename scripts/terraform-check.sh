#!/usr/bin/env bash
# Formats and validates every Terraform root without a backend or credentials (§12.3).
set -euo pipefail
cd "$(dirname "$0")/../infra/terraform"

terraform fmt -check -recursive
for root in environments/*/; do
  echo "Validating $root"
  terraform -chdir="$root" init -backend=false -input=false >/dev/null
  terraform -chdir="$root" validate
done

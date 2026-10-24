#!/usr/bin/env bash
# Plans (and optionally applies) the portal infrastructure for one environment (§12.6).
# CI files only call this script. Authentication is OIDC through the ARM_* variables; no secrets are read or printed.
#
# Usage: scripts/deploy-infra.sh <dev|test|prod> <path-to-tfvars> [--apply]
# Required environment: TFSTATE_RESOURCE_GROUP, TFSTATE_STORAGE_ACCOUNT. Optional: TFSTATE_CONTAINER (default tfstate).
set -euo pipefail

usage() {
  echo "Usage: $0 <dev|test|prod> <path-to-tfvars> [--apply]" >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
environment="$1"
var_file="$2"
apply="${3:-}"
[[ -z "$apply" || "$apply" == "--apply" ]] || usage

case "$environment" in dev | test | prod) ;; *) usage ;; esac
[[ -f "$var_file" ]] || { echo "tfvars file not found: $var_file" >&2; exit 2; }
: "${TFSTATE_RESOURCE_GROUP:?Set TFSTATE_RESOURCE_GROUP}"
: "${TFSTATE_STORAGE_ACCOUNT:?Set TFSTATE_STORAGE_ACCOUNT}"
container="${TFSTATE_CONTAINER:-tfstate}"

# A prod tfvars file must never be applied as dev, or the reverse: the state key and the file have to agree.
declared="$(sed -n 's/^[[:space:]]*environment[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$var_file" | head -n1)"
if [[ "$declared" != "$environment" ]]; then
  echo "environment in $var_file ('${declared:-missing}') does not match '$environment'" >&2
  exit 2
fi

command -v terraform >/dev/null || { echo "terraform is required on PATH (1.11 or newer)" >&2; exit 2; }

root="$(cd "$(dirname "$0")/../infra/terraform/stack" && pwd)"
var_file="$(cd "$(dirname "$var_file")" && pwd)/$(basename "$var_file")"

terraform -chdir="$root" init -input=false -reconfigure \
  -backend-config="resource_group_name=$TFSTATE_RESOURCE_GROUP" \
  -backend-config="storage_account_name=$TFSTATE_STORAGE_ACCOUNT" \
  -backend-config="container_name=$container" \
  -backend-config="key=$environment.tfstate"

plan_file="$root/$environment.tfplan"
terraform -chdir="$root" plan -input=false -var-file="$var_file" -out="$plan_file"

if [[ "$apply" == "--apply" ]]; then
  terraform -chdir="$root" apply -input=false "$plan_file"
else
  echo "Plan only. Pass --apply to apply it."
fi

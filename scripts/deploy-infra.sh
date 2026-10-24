#!/usr/bin/env bash
# Runs one Terraform step of the portal infrastructure for one environment (§12.6).
# CI files only call this script, one step per pipeline task. Authentication is OIDC through the ARM_* variables; no secrets are read or printed.
#
# Usage: scripts/deploy-infra.sh <init|validate|plan|apply> <dev|test|prod> <path-to-tfvars>
#   init      configure the remote state backend (run it in every job, it is idempotent)
#   validate  terraform validate (needs init)
#   plan      write the plan file <stack>/<environment>.tfplan (needs init)
#   apply     apply the plan file; refuses to run without one (needs init)
# Required environment: TFSTATE_RESOURCE_GROUP, TFSTATE_STORAGE_ACCOUNT. Optional: TFSTATE_CONTAINER (default tfstate).
set -euo pipefail

usage() {
  echo "Usage: $0 <init|validate|plan|apply> <dev|test|prod> <path-to-tfvars>" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage
step="$1"
environment="$2"
var_file="$3"

case "$step" in init | validate | plan | apply) ;; *) usage ;; esac
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

plan_file="$root/$environment.tfplan"

case "$step" in
  init)
    # The state account has shared key access disabled, so the backend must use Entra (and OIDC) explicitly.
    terraform -chdir="$root" init -input=false -reconfigure \
      -backend-config="resource_group_name=$TFSTATE_RESOURCE_GROUP" \
      -backend-config="storage_account_name=$TFSTATE_STORAGE_ACCOUNT" \
      -backend-config="container_name=$container" \
      -backend-config="key=$environment.tfstate" \
      -backend-config="use_azuread_auth=true" \
      -backend-config="use_oidc=true"
    ;;
  validate)
    terraform -chdir="$root" validate
    ;;
  plan)
    terraform -chdir="$root" plan -input=false -var-file="$var_file" -out="$plan_file"
    ;;
  apply)
    [[ -f "$plan_file" ]] || { echo "no plan file at $plan_file; run the plan step first" >&2; exit 2; }
    terraform -chdir="$root" apply -input=false "$plan_file"
    ;;
esac

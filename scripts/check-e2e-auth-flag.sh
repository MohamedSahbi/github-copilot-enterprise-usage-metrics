#!/usr/bin/env bash
# Fails if the test-only sign-in flags appear in deployment configuration (D-41).
set -euo pipefail
cd "$(dirname "$0")/.."

targets=()
for target in infra pipelines .github/workflows; do [[ -e "$target" ]] && targets+=("$target"); done

if grep -rnE 'E2E_TEST_AUTH|E2E_LOCAL_BUILD' "${targets[@]}" \
  --exclude=check-e2e-auth-flag.sh --exclude-dir=.terraform --exclude-dir=.git; then
  echo "::error::E2E_TEST_AUTH must not appear in Terraform, pipelines, or workflows"
  exit 1
fi

keyvault_file="infra/terraform/stack/keyvault.tf"
stack_dir="infra/terraform/stack"
keyvault_role_assignment_count="$(grep -Ec 'role_assignments[[:space:]]*=' "$keyvault_file")"

if [[ "$keyvault_role_assignment_count" != "1" ]] ||
  ! grep -Eq 'role_assignments[[:space:]]*=[[:space:]]*\{\}' "$keyvault_file"; then
  echo "::error::Key Vault AVM role_assignments must remain empty; grant secret access at secret scope"
  exit 1
fi

assignment_count="$(grep -hE 'resource[[:space:]]+"azurerm_role_assignment"' "$stack_dir"/*.tf | wc -l | tr -d ' ')"
if [[ "$assignment_count" != "1" ]] ||
  ! grep -Eq 'for_each[[:space:]]*=[[:space:]]*local\.secret_identity_by_name' "$keyvault_file" ||
  ! grep -Eq 'scope[[:space:]]*=[[:space:]]*format\("%s/secrets/%s", module\.key_vault\.resource_id, each\.key\)' "$keyvault_file" ||
  ! grep -Eq 'principal_id[[:space:]]*=[[:space:]]*module\.identity\[each\.value\]\.principal_id' "$keyvault_file"; then
  echo "::error::Key Vault Secrets User must be granted only at per-secret scope to that secret's component identity"
  exit 1
fi

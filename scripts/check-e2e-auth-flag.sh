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

# Compare whole blocks so an operator exception cannot mask a runtime grant.
assignment_block() {
  awk -v name="$1" '
    /^resource "azurerm_role_assignment" / { active = ($3 == "\"" name "\"") }
    active { print }
    active && /^}/ { exit }
  ' "$keyvault_file" | tr -d '[:space:]'
}

expected_readers="$(tr -d '[:space:]' <<'EOF'
resource "azurerm_role_assignment" "secret_readers" {
  for_each = local.secret_identity_by_name
  scope = format("%s/secrets/%s", module.key_vault.resource_id, each.key)
  role_definition_name = "Key Vault Secrets User"
  principal_id = module.identity[each.value].principal_id
  principal_type = "ServicePrincipal"
}
EOF
)"
expected_operators="$(tr -d '[:space:]' <<'EOF'
resource "azurerm_role_assignment" "secret_operators" {
  for_each = toset([for id in var.key_vault_operator_object_ids : lower(id)])
  scope = module.key_vault.resource_id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id = each.value
  principal_type = "User"
}
EOF
)"

assignment_count="$(grep -hE 'resource[[:space:]]+"azurerm_role_assignment"' "$stack_dir"/*.tf | wc -l | tr -d ' ')"
if [[ "$assignment_count" != "2" ]] ||
  [[ "$(assignment_block secret_readers)" != "$expected_readers" ]] ||
  [[ "$(assignment_block secret_operators)" != "$expected_operators" ]]; then
  echo "::error::Only per-secret runtime Secrets User and explicit user-only vault Secrets Officer grants are permitted"
  exit 1
fi

if ! grep -Eq 'network_acls[[:space:]]*=[[:space:]]*local\.key_vault_network_acls' "$keyvault_file" ||
  ! grep -Eq 'bypass[[:space:]]*=[[:space:]]*"None"' "$keyvault_file" ||
  ! grep -Eq 'default_action[[:space:]]*=[[:space:]]*"Deny"' "$keyvault_file" ||
  ! grep -Eq 'ip_rules[[:space:]]*=[[:space:]]*\[for address in var\.key_vault_allowed_ipv4_addresses' "$keyvault_file" ||
  grep -Eq 'bypass[[:space:]]*=[[:space:]]*"AzureServices"|default_action[[:space:]]*=[[:space:]]*"Allow"' "$keyvault_file"; then
  echo "::error::Key Vault networking must use explicit Deny/None ACLs and the validated app IPv4 allowlist"
  exit 1
fi

if grep -REn '(data|resource)[[:space:]]+"azurerm_key_vault_secrets?"' "$stack_dir" --include='*.tf' --exclude-dir=.terraform --exclude-dir=.git ||
  grep -REn 'az[[:space:]]+keyvault[[:space:]]+secret[[:space:]]+(list|show)|Get-AzKeyVaultSecret' scripts pipelines .github/workflows --exclude=check-e2e-auth-flag.sh; then
  echo "::error::Terraform plan/apply and deployment scripts must not perform Key Vault data-plane secret lookups"
  exit 1
fi

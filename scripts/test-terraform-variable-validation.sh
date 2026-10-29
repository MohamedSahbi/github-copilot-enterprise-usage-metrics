#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

cp "$repo_root/infra/terraform/stack/variables.tf" "$test_root/variables.tf"
cat >"$test_root/valid.tfvars" <<'EOF'
environment = "dev"
location = "westeurope"
name_prefix = "cmp"
organization = {
  enterprise_slug = "example-enterprise"
  organizations = ["example-org"]
  login_suffix = "_example"
  directory_provider = "entra"
  entra_tenant_id = "00000000-0000-0000-0000-000000000000"
}
directory_sync_schedule = "0 0 2 * * *"
metrics_sync_schedule = "0 0 2 * * *"
auth_trust_host = false
auth_microsoft_entra_id_id = "00000000-0000-0000-0000-000000000000"
auth_github_id = "REPLACE_WITH_CLIENT_ID"
github_app_id = "123456"
sql_admin = {
  login_username = "example-sql-admins"
  object_id = "00000000-0000-0000-0000-000000000000"
}
private_endpoints_enabled = false
key_vault_allowed_ipv4_addresses = ["192.0.2.10"]
network = { mode = "create" }
EOF
sed '/^directory_sync_schedule = /d' "$test_root/valid.tfvars" >"$test_root/missing-schedule.tfvars"

terraform -chdir="$test_root" init -backend=false -input=false -no-color >/dev/null

valid_cases=0
invalid_cases=0

plan() {
  terraform -chdir="$test_root" plan -refresh=false -input=false -no-color \
    -var-file="$test_root/valid.tfvars" "$@" >"$test_root/output" 2>&1
}

expect_valid() {
  if ! plan "$@"; then
    cat "$test_root/output" >&2
    exit 1
  fi
  valid_cases=$((valid_cases + 1))
}

expect_invalid() {
  local name="$1"
  local value="$2"
  local expected="$3"
  if plan -var "$name=$value"; then
    printf 'Expected %s=%s to be rejected.\n' "$name" "$value" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$test_root/output"; then
    cat "$test_root/output" >&2
    printf 'Expected validation message not found: %s\n' "$expected" >&2
    exit 1
  fi
  invalid_cases=$((invalid_cases + 1))
}

plan
if terraform -chdir="$test_root" plan -refresh=false -input=false -no-color \
  -var-file="$test_root/missing-schedule.tfvars" >"$test_root/output" 2>&1; then
  printf 'Expected directory_sync_schedule to be required.\n' >&2
  exit 1
fi
if ! grep -Fq "No value for required variable" "$test_root/output"; then
  cat "$test_root/output" >&2
  exit 1
fi
expect_valid -var access_permission_freshness_minutes=1
expect_valid -var access_permission_freshness_minutes=60
expect_valid -var 'directory_sync_schedule=0 0 * * * *'
expect_valid -var 'directory_sync_schedule=0 0 2 * * *'
expect_valid -var 'directory_sync_schedule=0 0 2 * * 1'
expect_valid -var 'directory_sync_schedule=59 59 23 31 12 6'
expect_valid -var 'metrics_sync_schedule=0 0 * * * *'
expect_valid -var 'metrics_sync_schedule=0 0 2 * * *'
expect_valid -var 'metrics_sync_schedule=0 0 2 * * 1'
expect_valid -var 'metrics_sync_schedule=59 59 23 31 12 6'
expect_valid -var 'metrics_sync_schedule=0 */6 2-4 * * 1,3'
expect_valid -var 'access_request_url=https://example.com/request'
expect_valid -var access_break_glass_group_id=00000000-0000-0000-0000-000000000001
expect_valid -var directory_department_attribute=department
expect_valid -var directory_business_area_attribute=onPremisesExtensionAttributes.extensionAttribute1
expect_valid -var backfill_from=2024-02-29
expect_valid -var 'key_vault_allowed_ipv4_addresses=["192.0.2.11","198.51.100.12"]'
expect_valid -var auth_trust_host=true -var trusted_forwarding_ingress=true
expect_valid -var 'key_vault_operator_object_ids=["00000000-0000-0000-0000-000000000001","AAAAAAAA-0000-0000-0000-000000000002"]'
expect_valid -var portal_public_url=https://portal.example.com
expect_valid -var portal_public_url=https://portal.example.com:8443/
expect_valid -var 'organization={ enterprise_slug = "example-enterprise", organizations = ["example-org"], login_suffix = "_example", directory_provider = "csv", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }'
expect_valid -var 'organization={ enterprise_slug = "example-enterprise", organizations = ["example-org", "example-team"], login_suffix = "_example", directory_provider = "entra", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }'

expect_invalid auth_trust_host true "auth_trust_host can be true only when trusted_forwarding_ingress is true."
expect_invalid key_vault_operator_object_ids '["not-a-guid"]' "Operator object IDs must be unique Entra user GUIDs."
expect_invalid key_vault_operator_object_ids '[""]' "Operator object IDs must be unique Entra user GUIDs."
expect_invalid key_vault_operator_object_ids '["00000000-0000-0000-0000-000000000001","00000000-0000-0000-0000-000000000001"]' "Operator object IDs must be unique Entra user GUIDs."
expect_invalid key_vault_operator_object_ids '["AAAAAAAA-0000-0000-0000-000000000001","aaaaaaaa-0000-0000-0000-000000000001"]' "Operator object IDs must be unique Entra user GUIDs."
for value in "" http://portal.example.com https://portal.example.com/path 'https://portal.example.com?query=1' 'https://portal.example.com#fragment' https://user:password@portal.example.com https://portal.example.com:0 https://portal.example.com:65536 "https://portal.example.com/ bad" https://-invalid.example.com; do
  expect_invalid portal_public_url "$value" "Use an HTTPS origin only, or null for the default hostname."
done
expect_invalid auth_microsoft_entra_id_id not-a-guid "auth_microsoft_entra_id_id must be a GUID."
expect_invalid auth_github_id "" "auth_github_id must not be empty."
expect_invalid github_app_id 0 "github_app_id must be a positive decimal identifier."
expect_invalid github_app_id 12.5 "github_app_id must be a positive decimal identifier."
expect_invalid access_break_glass_group_id not-a-guid "access_break_glass_group_id must be empty or an Entra group object ID (GUID)."
expect_invalid access_permission_freshness_minutes 0 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_permission_freshness_minutes 1.5 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_permission_freshness_minutes 61 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_request_url http://example.com "access_request_url must be empty or an HTTPS URL without whitespace."
expect_invalid access_request_url "https://example.com/request access" "access_request_url must be empty or an HTTPS URL without whitespace."
expect_invalid directory_department_attribute "not a path" "directory_department_attribute must be empty or an Entra attribute path."
expect_invalid directory_business_area_attribute "not a path" "directory_business_area_attribute must be empty or an Entra attribute path."
expect_invalid stale_data_threshold_hours 1.5 "stale_data_threshold_hours must be a positive whole number."
expect_invalid min_group_size 1 "min_group_size must be a whole number of at least 2."
expect_invalid min_group_size 4.5 "min_group_size must be a whole number of at least 2."
expect_invalid directory_sync_schedule "0 0 2 * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 2 * * monday" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 ? * * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 2 */0 * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "60 0 2 * * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 60 2 * * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 24 * * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 2 32 * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 2 * 13 *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "0 0 2 * * 7" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid directory_sync_schedule "30-10 0 2 * * *" "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
expect_invalid organization '{ enterprise_slug = "example-enterprise", organizations = ["example-org"], login_suffix = "_example", directory_provider = "other", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }' "organization.directory_provider must be entra or csv (D-4)."
expect_invalid organization '{ enterprise_slug = "example-enterprise", organizations = ["example-org"], login_suffix = "_example", directory_provider = "entra", entra_tenant_id = "not-a-guid" }' "organization.entra_tenant_id must be a GUID."
expect_invalid organization '{ enterprise_slug = "example-enterprise", organizations = ["bad--login"], login_suffix = "_example", directory_provider = "entra", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }' "organization.organizations must be unique valid GitHub logins."
expect_invalid organization '{ enterprise_slug = "example-enterprise", organizations = ["Example-Org", "example-org"], login_suffix = "_example", directory_provider = "entra", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }' "organization.organizations must be unique valid GitHub logins."
expect_invalid backfill_from "" "backfill_from must be a valid calendar date in YYYY-MM-DD format or omitted."
expect_invalid backfill_from 2026-02-30 "backfill_from must be a valid calendar date in YYYY-MM-DD format or omitted."
expect_invalid key_vault_allowed_ipv4_addresses '["999.0.0.1"]' "Addresses must be unique bare IPv4 literals (maximum 1000)."
expect_invalid key_vault_allowed_ipv4_addresses '["2001:db8::1"]' "Addresses must be unique bare IPv4 literals (maximum 1000)."
expect_invalid key_vault_allowed_ipv4_addresses '["192.0.2.11/24"]' "Addresses must be unique bare IPv4 literals (maximum 1000)."
expect_invalid key_vault_allowed_ipv4_addresses '["192.0.2.11","192.0.2.11"]' "Addresses must be unique bare IPv4 literals (maximum 1000)."
expect_invalid key_vault_allowed_ipv4_addresses '[]' "Set key_vault_allowed_ipv4_addresses when private endpoints are disabled."

sed '/^metrics_sync_schedule = /d' "$test_root/valid.tfvars" >"$test_root/missing-metrics-schedule.tfvars"
if terraform -chdir="$test_root" plan -refresh=false -input=false -no-color \
  -var-file="$test_root/missing-metrics-schedule.tfvars" >"$test_root/output" 2>&1; then
  printf 'Expected metrics_sync_schedule to be required.\n' >&2
  exit 1
fi
if ! grep -Fq "No value for required variable" "$test_root/output" ||
   ! grep -Fq 'metrics_sync_schedule' "$test_root/output"; then
  cat "$test_root/output" >&2
  exit 1
fi
for invalid_schedule in "" "0 0 2 * *" "0 0 2 * * monday" "0 0 ? * * *" "0 0 2 */0 * *" \
  "60 0 2 * * *" "0 60 2 * * *" "0 0 24 * * *" "0 0 2 32 * *" \
  "0 0 2 * 13 *" "0 0 2 * * 7" "30-10 0 2 * * *"; do
  expect_invalid metrics_sync_schedule "$invalid_schedule" "metrics_sync_schedule must be a six-field UTC NCRONTAB expression."
done

printf 'Terraform variable validation: %s valid and %s invalid cases passed.\n' "$valid_cases" "$invalid_cases"

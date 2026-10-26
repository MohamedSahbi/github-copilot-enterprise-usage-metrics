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
auth_trust_host = false
auth_microsoft_entra_id_id = "00000000-0000-0000-0000-000000000000"
auth_github_id = "REPLACE_WITH_CLIENT_ID"
sql_admin = {
  login_username = "example-sql-admins"
  object_id = "00000000-0000-0000-0000-000000000000"
}
private_endpoints_enabled = false
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
expect_valid -var 'access_request_url=https://example.com/request'
expect_valid -var access_break_glass_group_id=00000000-0000-0000-0000-000000000001
expect_valid -var directory_department_attribute=department
expect_valid -var directory_business_area_attribute=onPremisesExtensionAttributes.extensionAttribute1
expect_valid -var auth_trust_host=true -var trusted_forwarding_ingress=true
expect_valid -var 'organization={ enterprise_slug = "example-enterprise", organizations = ["example-org"], login_suffix = "_example", directory_provider = "csv", entra_tenant_id = "00000000-0000-0000-0000-000000000000" }'

expect_invalid auth_trust_host true "auth_trust_host can be true only when trusted_forwarding_ingress is true."
expect_invalid auth_microsoft_entra_id_id not-a-guid "auth_microsoft_entra_id_id must be a GUID."
expect_invalid auth_github_id "" "auth_github_id must not be empty."
expect_invalid access_break_glass_group_id not-a-guid "access_break_glass_group_id must be empty or an Entra group object ID (GUID)."
expect_invalid access_permission_freshness_minutes 0 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_permission_freshness_minutes 1.5 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_permission_freshness_minutes 61 "access_permission_freshness_minutes must be an integer between 1 and 60."
expect_invalid access_request_url http://example.com "access_request_url must be empty or an HTTPS URL without whitespace."
expect_invalid access_request_url "https://example.com/request access" "access_request_url must be empty or an HTTPS URL without whitespace."
expect_invalid directory_department_attribute "not a path" "directory_department_attribute must be empty or an Entra attribute path."
expect_invalid directory_business_area_attribute "not a path" "directory_business_area_attribute must be empty or an Entra attribute path."
expect_invalid stale_data_threshold_hours 1.5 "stale_data_threshold_hours must be a positive whole number."
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

printf 'Terraform variable validation: %s valid and %s invalid cases passed.\n' "$valid_cases" "$invalid_cases"

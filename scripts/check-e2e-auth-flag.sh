#!/usr/bin/env bash
# Fails if the test-only sign-in flags appear in deployment configuration (D-41).
set -euo pipefail
cd "$(dirname "$0")/.."

targets=()
for target in infra pipelines .github/workflows; do [[ -e "$target" ]] && targets+=("$target"); done

if grep -rnE 'E2E_TEST_AUTH|E2E_LOCAL_BUILD' "${targets[@]}" --exclude=check-e2e-auth-flag.sh; then
  echo "::error::E2E_TEST_AUTH must not appear in Terraform, pipelines, or workflows"
  exit 1
fi

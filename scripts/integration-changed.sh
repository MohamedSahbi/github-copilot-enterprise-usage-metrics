#!/usr/bin/env bash
# Prints "true" when the change needs the integration tests against the local stack, otherwise "false" (D-26).
# Relevant: SQL migrations, the migration runner and local stack code, fixtures, the compose file, integration tests,
# the Vitest projects config, and this script.
# Usage: integration-changed.sh <base-ref> <head-ref>
# An unknown base (new branch, force push) counts as changed so the check is never silently skipped.
set -euo pipefail

base="${1:?base ref required}"
head="${2:?head ref required}"

if [[ "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo true
  exit 0
fi

if git diff --name-only "$base" "$head" -- \
  'db/**/*.sql' 'db/*.sql' \
  'scripts/db/*' 'scripts/stack/*' 'scripts/integration/*' 'scripts/contracts/reference/*' \
  'fixtures/*' 'docker/*' vitest.config.mts scripts/integration-changed.sh | grep -q .; then
  echo true
else
  echo false
fi

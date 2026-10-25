#!/usr/bin/env bash
# Prints "true" when the change needs the SQL Server container test, otherwise "false" (D-26).
# SQL that needs verifying: db/**/*.sql, the container test itself, and this script.
# Usage: sql-changed.sh <base-ref> <head-ref>
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
  scripts/contracts/sql-container.test.ts scripts/sql-changed.sh | grep -q .; then
  echo true
else
  echo false
fi

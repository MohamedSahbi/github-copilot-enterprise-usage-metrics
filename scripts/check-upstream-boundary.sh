#!/usr/bin/env bash
# Fails if a change touches portal/upstream other than moving the pinned submodule commit (D-14).
# Usage: check-upstream-boundary.sh <base-ref> <head-ref>
set -euo pipefail

base="${1:?base ref required}"
head="${2:?head ref required}"
path="portal/upstream"

status=0
while IFS=$'\t' read -r meta file; do
  read -r old_mode new_mode _ _ _ <<<"${meta#:}"
  if [[ "$old_mode" != "160000" || "$new_mode" != "160000" || "$file" != "$path" ]]; then
    echo "::error::Only the pinned commit of $path may change; found a change to: $file"
    status=1
  fi
done < <(git diff --raw --no-renames "$base" "$head" -- "$path")

if git diff "$base" "$head" -U0 -- .gitmodules | grep -qE '^[+-][[:space:]]*url'; then
  echo "::error::The upstream submodule URL must not change in a regular PR"
  status=1
fi

exit "$status"

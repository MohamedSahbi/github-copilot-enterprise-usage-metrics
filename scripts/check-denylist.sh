#!/usr/bin/env bash
# Fails if any term from $PRIVATE_TERMS_DENYLIST (one per line) appears in the diff (D-46).
# Never prints the terms. Usage: check-denylist.sh <base-ref> <head-ref>
set -euo pipefail

base="${1:?base ref required}"
head="${2:?head ref required}"

if [[ -z "${PRIVATE_TERMS_DENYLIST:-}" ]]; then
  if [[ "${DENYLIST_ALLOW_MISSING:-0}" == "1" ]]; then
    echo "::warning::PRIVATE_TERMS_DENYLIST is not available to this run; denylist check skipped"
    exit 0
  fi
  echo "::error::PRIVATE_TERMS_DENYLIST secret is not configured"
  exit 1
fi

terms_file="$(mktemp)"
trap 'rm -f "$terms_file"' EXIT
printf '%s\n' "$PRIVATE_TERMS_DENYLIST" | tr -d '\r' | sed '/^[[:space:]]*$/d' >"$terms_file"

if [[ ! -s "$terms_file" ]]; then
  echo "::error::PRIVATE_TERMS_DENYLIST contains no usable terms"
  exit 1
fi

# Reads all of stdin (no -q) so an early match cannot break the upstream pipe and be missed under pipefail.
matches() { grep -i -F -f "$terms_file" >/dev/null; }

status=0
while IFS= read -r -d '' file; do
  if printf '%s' "$file" | matches; then
    echo "::error::A changed file path contains a denylisted term (path withheld)"
    status=1
  elif git diff "$base" "$head" -U0 -- "$file" | grep -E '^\+' | grep -v '^+++' | matches; then
    echo "::error file=$file::Added content contains a denylisted term (term withheld)"
    status=1
  fi
done < <(git diff --name-only -z "$base" "$head")

if git log --format='%an%n%ae%n%B' "$base..$head" | matches; then
  echo "::error::A commit message or author contains a denylisted term (term withheld)"
  status=1
fi

exit "$status"

#!/usr/bin/env bash
# Runs a data operator tool against the environment's portal database, for a pipeline stage or an operator.
# Run it from a checkout of the release tag the environment pins, after scripts/deploy-infra.sh init, signed in to
# Azure CLI as a member of the SQL server's Entra admin group (like scripts/deploy-db.sh). Authentication is that
# sign-in's Entra token; no secret is read or printed. Output is counts, days, scope keys and run IDs only.
#
# Usage:
#   scripts/data-ops.sh status --from <yyyy-mm-dd> [--to <yyyy-mm-dd>]           read-only metrics state per day
#   scripts/data-ops.sh remove-synthetic                                          dry run: counts, then rolls back
#   scripts/data-ops.sh remove-synthetic --execute --expect-fact-rows <n>        deletes, if the count still matches
# See docs/runbooks/remove-runs.md and docs/runbooks/metrics-history-import.md.
set -euo pipefail

usage() { sed -n '7,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[[ $# -ge 1 ]] || usage
operation="$1"
shift
case "$operation" in
  status) script="data:run-status"; args=("$@") ;;
  remove-synthetic) script="data:remove-runs"; args=(--synthetic "$@") ;;
  *) usage ;;
esac
command -v terraform >/dev/null || { echo "terraform is required on PATH" >&2; exit 2; }
command -v az >/dev/null || { echo "az is required on PATH" >&2; exit 2; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
stack="$repo_root/infra/terraform/stack"
cd "$repo_root"

[[ -d node_modules ]] || npm ci

SQL_SERVER="$(terraform -chdir="$stack" output -raw sql_server_fqdn)"
SQL_DATABASE="$(terraform -chdir="$stack" output -raw sql_database_name)"
export SQL_SERVER SQL_DATABASE
# The token is passed only to the data command, never to npm ci's install scripts.
token="$(az account get-access-token --resource https://database.windows.net/ --query accessToken --output tsv)"

echo "Running $operation on $SQL_DATABASE on $SQL_SERVER" >&2
SQL_ACCESS_TOKEN="$token" npm run --silent "$script" -- "${args[@]}"

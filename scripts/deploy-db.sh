#!/usr/bin/env bash
# Migrates the environment's portal database and maps the runtime identities to their database roles.
# Run it from a checkout of the release tag the environment pins, after scripts/deploy-infra.sh init and apply, signed in to Azure CLI
# as a member of the SQL server's Entra admin group. Authentication is that sign-in's Entra token; no secret is read or printed.
#
# Usage: scripts/deploy-db.sh
# The server, database and identities come from the stack outputs sql_server_fqdn, sql_database_name and identities.
# Both steps are idempotent: applied migrations, existing users and existing role memberships are kept.
set -euo pipefail

[[ $# -eq 0 ]] || { echo "Usage: $0" >&2; exit 2; }
command -v terraform >/dev/null || { echo "terraform is required on PATH" >&2; exit 2; }
command -v az >/dev/null || { echo "az is required on PATH" >&2; exit 2; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
stack="$repo_root/infra/terraform/stack"
cd "$repo_root"

npm ci

SQL_SERVER="$(terraform -chdir="$stack" output -raw sql_server_fqdn)"
SQL_DATABASE="$(terraform -chdir="$stack" output -raw sql_database_name)"
RUNTIME_IDENTITIES="$(terraform -chdir="$stack" output -json identities)"
export SQL_SERVER SQL_DATABASE RUNTIME_IDENTITIES
# The token is passed only to the two database commands, never to npm ci's install scripts.
token="$(az account get-access-token --resource https://database.windows.net/ --query accessToken --output tsv)"

echo "Migrating $SQL_DATABASE on $SQL_SERVER"
SQL_ACCESS_TOKEN="$token" npm run --silent db:migrate
echo "Mapping runtime identities"
SQL_ACCESS_TOKEN="$token" npm run --silent db:runtime-users

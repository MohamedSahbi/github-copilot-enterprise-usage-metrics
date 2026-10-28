#!/usr/bin/env bash
# Builds the portal (Next.js standalone) from the current checkout and zip-deploys it to an existing App Service.
# Run it from a checkout of the release tag the environment pins. Authentication is the caller's Azure CLI sign-in; no secrets are read or printed.
#
# Usage: scripts/deploy-portal.sh <resource-group> <web-app-name> [--package-only]
#   --package-only  build and write the zip, print its path, deploy nothing
# A pipeline reads both names from the stack outputs resource_group_name and portal_app_name.
# Infrastructure, Key Vault references, migrations and grants must already be in place (docs/runbooks/migrations.md, Pipeline).
set -euo pipefail

usage() {
  echo "Usage: $0 <resource-group> <web-app-name> [--package-only]" >&2
  exit 2
}

[[ $# -eq 2 || $# -eq 3 ]] || usage
resource_group="$1"
app_name="$2"
package_only=false
if [[ $# -eq 3 ]]; then
  [[ "$3" == "--package-only" ]] || usage
  package_only=true
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; deploy only a committed release checkout." >&2
  exit 1
fi
version="$(git describe --tags --always)"

npm ci
npm run build -w portal

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/site"

# The standalone output mirrors the repository layout (outputFileTracingRoot is the repo root), so the server is portal/server.js.
cp -R portal/.next/standalone "$stage"
mkdir -p "$stage/portal/.next"
cp -R portal/.next/static "$stage/portal/.next/static"
[[ -d portal/public ]] && cp -R portal/public "$stage/portal/public"

# App Service's Node image starts a root server.js when no startup command is set, so Terraform keeps owning site_config.
cat >"$stage/server.js" <<'EOF'
require("./portal/server.js");
EOF

zip_path="$work/portal-$version.zip"
(cd "$stage" && zip -qr "$zip_path" .)

if [[ "$package_only" == true ]]; then
  mkdir -p "$repo_root/dist"
  cp "$zip_path" "$repo_root/dist/"
  echo "Package written: dist/$(basename "$zip_path")"
  exit 0
fi

echo "Deploying portal $version to $app_name"
az webapp deploy --resource-group "$resource_group" --name "$app_name" --src-path "$zip_path" --type zip --clean true --restart true

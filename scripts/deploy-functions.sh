#!/usr/bin/env bash
# Builds the metrics or directory ingestion artifact from the current checkout and zip-deploys it to an existing Function App.
# Run it from a checkout of the release tag the environment pins. Authentication is the caller's Azure CLI sign-in; no secrets are read or printed.
#
# Usage: scripts/deploy-functions.sh <metrics|directory> <resource-group> <function-app-name> [--package-only]
#   --package-only  build and write the zip, print its path, deploy nothing
# A pipeline reads the names from the stack outputs resource_group_name, ingestion_function_app_name and directory_function_app_name.
# Infrastructure, Key Vault references, migrations and grants must already be in place; schedules and settings stay owned by Terraform.
# A stopped or disabled app is skipped, never started.
set -euo pipefail

usage() {
  echo "Usage: $0 <metrics|directory> <resource-group> <function-app-name> [--package-only]" >&2
  exit 2
}

[[ $# -eq 3 || $# -eq 4 ]] || usage
component="$1"
resource_group="$2"
app_name="$3"
[[ "$component" == "metrics" || "$component" == "directory" ]] || usage
package_only=false
if [[ $# -eq 4 ]]; then
  [[ "$4" == "--package-only" ]] || usage
  package_only=true
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; deploy only a committed release checkout." >&2
  exit 1
fi
version="$(git describe --tags --always)"

# A Function App that Terraform keeps off (the directory app until directory sync is approved) refuses every deployment with 403.
# Azure reports a stopped app as Stopped and an app disabled with enabled = false as Disabled; both are skipped.
# Skip it cleanly instead of failing the run; any other state, or a failed lookup, still goes on to deploy or fails loudly.
if [[ "$package_only" == false ]]; then
  app_state="$(az functionapp show --resource-group "$resource_group" --name "$app_name" --query state --output tsv)"
  if [[ "$app_state" == "Stopped" || "$app_state" == "Disabled" ]]; then
    echo "Skipped: $component app $app_name is $app_state (kept off by Terraform); nothing was deployed or started."
    exit 0
  fi
fi

npm ci

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
artifact="$work/${component}-artifact-$version"
mkdir "$artifact"

# build-artifact.mjs writes the bundled function, host.json and a locked runtime package.json into the artifact directory.
(cd functions && node build-artifact.mjs "$component" "$artifact")
(cd "$artifact" && npm ci --omit=dev --ignore-scripts)

zip_path="$work/functions-$component-$version.zip"
(cd "$artifact" && zip -qr "$zip_path" .)

if [[ "$package_only" == true ]]; then
  mkdir -p "$repo_root/dist"
  cp "$zip_path" "$repo_root/dist/"
  echo "Package written: dist/$(basename "$zip_path")"
  exit 0
fi

echo "Deploying $component functions $version to $app_name"
# OneDeploy: config-zip rewrites app settings and polls the deployment site, which restarts it mid-deploy and returns a non-JSON reply.
az functionapp deploy --resource-group "$resource_group" --name "$app_name" --src-path "$zip_path" --type zip --timeout 600000

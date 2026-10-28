#!/usr/bin/env bash
# Builds the metrics or directory ingestion artifact from the current checkout and zip-deploys it to an existing Function App.
# Run it from a checkout of the release tag the environment pins. Authentication is the caller's Azure CLI sign-in; no secrets are read or printed.
#
# Usage: scripts/deploy-functions.sh <metrics|directory> <resource-group> <function-app-name> [--package-only]
#   --package-only  build and write the zip, print its path, deploy nothing
# A pipeline reads the names from the stack outputs resource_group_name, ingestion_function_app_name and directory_function_app_name.
# Infrastructure, Key Vault references, migrations and grants must already be in place; schedules and settings stay owned by Terraform.
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
az functionapp deployment source config-zip --resource-group "$resource_group" --name "$app_name" --src "$zip_path"

#!/usr/bin/env bash
# Creates the Terraform state storage once per subscription (§12.2, §12.3). Safe to re-run.
# Uses the Azure CLI, because Terraform would need the state it is about to create.
#
# Usage: scripts/bootstrap-state.sh <resource-group> <storage-account> <location> [principal-object-id]
# The optional principal (the pipeline's identity) gets "Storage Blob Data Contributor" on the account.
# The storage account name must be globally unique: 3-24 lowercase letters or digits.
set -euo pipefail

[[ $# -ge 3 && $# -le 4 ]] || { echo "Usage: $0 <resource-group> <storage-account> <location> [principal-object-id]" >&2; exit 2; }
group="$1"
account="$2"
location="$3"
principal="${4:-}"

[[ "$account" =~ ^[a-z0-9]{3,24}$ ]] || { echo "storage account must be 3-24 lowercase letters or digits" >&2; exit 2; }
command -v az >/dev/null || { echo "Azure CLI (az) is required" >&2; exit 2; }

az group create --name "$group" --location "$location" --output none

az storage account create \
  --name "$account" --resource-group "$group" --location "$location" \
  --sku Standard_ZRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false \
  --output none

# Versioning lets you recover an earlier state file.
az storage account blob-service-properties update \
  --account-name "$account" --resource-group "$group" --enable-versioning true --output none

az storage container create --name tfstate --account-name "$account" --auth-mode login --output none

if [[ -n "$principal" ]]; then
  scope="$(az storage account show --name "$account" --resource-group "$group" --query id --output tsv)"
  az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" --scope "$scope" --output none
fi

echo "State storage ready. Set these pipeline variables:"
echo "  TFSTATE_RESOURCE_GROUP=$group"
echo "  TFSTATE_STORAGE_ACCOUNT=$account"

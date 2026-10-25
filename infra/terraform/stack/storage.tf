# One account: the raw NDJSON archive (D-11) and the Functions host storage. Keys are disabled; identities use RBAC.
module "storage" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "0.10.0"

  name                     = local.storage_name
  location                 = var.location
  parent_id                = local.resource_group_id
  account_replication_type = "ZRS"
  tags                     = local.tags

  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access_enabled   = !var.private_endpoints_enabled
  allow_nested_items_to_be_public = false

  containers = {
    raw = { name = "raw" }
  }

  private_endpoints = local.private_endpoints_enabled ? {
    for sub in ["blob", "queue", "table"] : sub => {
      subnet_resource_id            = var.network.subnet_id
      subresource_name              = sub
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, sub, null)])
    }
  } : {}

  role_assignments = {
    ingestion_blob = {
      role_definition_id_or_name = "Storage Blob Data Owner"
      principal_id               = module.identity["ingestion"].principal_id
      principal_type             = "ServicePrincipal"
    }
    ingestion_queue = {
      role_definition_id_or_name = "Storage Queue Data Contributor"
      principal_id               = module.identity["ingestion"].principal_id
      principal_type             = "ServicePrincipal"
    }
    ingestion_table = {
      role_definition_id_or_name = "Storage Table Data Contributor"
      principal_id               = module.identity["ingestion"].principal_id
      principal_type             = "ServicePrincipal"
    }
  }

  enable_telemetry = false
}

resource "azurerm_storage_management_policy" "raw_archive" {
  storage_account_id = module.storage.resource_id

  rule {
    name    = "raw-archive-cool"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["raw/"]
    }

    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than = ceil(var.raw_archive_cool_after_months * 365.25 / 12)
      }
    }
  }
}

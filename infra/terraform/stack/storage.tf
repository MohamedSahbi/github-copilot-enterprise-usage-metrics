locals {
  raw_archive_role_assignments = {
    ingestion_blob = {
      role_definition_id_or_name = "Storage Blob Data Owner"
      principal_id               = module.identity[local.raw_archive_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
    ingestion_queue = {
      role_definition_id_or_name = "Storage Queue Data Contributor"
      principal_id               = module.identity[local.raw_archive_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
    ingestion_table = {
      role_definition_id_or_name = "Storage Table Data Contributor"
      principal_id               = module.identity[local.raw_archive_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
  }

  directory_host_storage_role_assignments = {
    directory_blob = {
      role_definition_id_or_name = "Storage Blob Data Owner"
      principal_id               = module.identity[local.directory_host_storage_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
    directory_queue = {
      role_definition_id_or_name = "Storage Queue Data Contributor"
      principal_id               = module.identity[local.directory_host_storage_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
    directory_table = {
      role_definition_id_or_name = "Storage Table Data Contributor"
      principal_id               = module.identity[local.directory_host_storage_identity_key].principal_id
      principal_type             = "ServicePrincipal"
    }
  }
}

# Metrics owns this account's raw archive and its own host storage. Keys are disabled; access uses RBAC.
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

  # Recovery from logical deletion/overwrite (D-50, #55): replication and Cool tiering are not backups.
  blob_properties = {
    versioning_enabled = true
    delete_retention_policy = {
      enabled                = true
      days                   = var.raw_archive_recovery_days
      allow_permanent_delete = false
    }
    container_delete_retention_policy = {
      enabled                = true
      days                   = var.raw_archive_recovery_days
      allow_permanent_delete = false
    }
  }

  private_endpoints = local.private_endpoints_enabled ? {
    for sub in ["blob", "queue", "table"] : sub => {
      subnet_resource_id            = var.network.subnet_id
      subresource_name              = sub
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, sub, null)])
    }
  } : {}

  role_assignments = local.raw_archive_role_assignments

  enable_telemetry = false
}

module "directory_host_storage" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "0.10.0"

  name                     = local.directory_host_storage_name
  location                 = var.location
  parent_id                = local.resource_group_id
  account_replication_type = "ZRS"
  tags                     = local.tags

  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access_enabled   = !var.private_endpoints_enabled
  allow_nested_items_to_be_public = false

  private_endpoints = local.private_endpoints_enabled ? {
    for sub in ["blob", "queue", "table"] : sub => {
      subnet_resource_id            = var.network.subnet_id
      subresource_name              = sub
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, sub, null)])
    }
  } : {}

  role_assignments = local.directory_host_storage_role_assignments

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

  # Versioning covers host blobs too; keep noncurrent versions only for the recovery window.
  rule {
    name    = "noncurrent-version-expiry"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      version {
        delete_after_days_since_creation = var.raw_archive_recovery_days
      }
    }
  }
}

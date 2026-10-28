locals {
  resource_group_name = var.existing_resource_group_name == null ? azurerm_resource_group.this[0].name : data.azurerm_resource_group.existing[0].name
  resource_group_id   = var.existing_resource_group_name == null ? azurerm_resource_group.this[0].id : data.azurerm_resource_group.existing[0].id

  name = "${var.name_prefix}-${var.environment}"
  tags = merge(var.tags, { environment = var.environment })

  enabled_modules = [for name, enabled in var.modules : name if enabled]

  # Short stable suffix keeps globally unique names (Key Vault, Storage, web apps) from clashing across deployments.
  suffix                        = substr(sha1(local.resource_group_id), 0, 4)
  compact_name                  = replace(local.name, "-", "")
  raw_archive_storage_prefix    = "st${local.compact_name}"
  directory_host_storage_prefix = "stdir${substr(local.compact_name, 0, 14)}"
  metrics_host_storage_prefix   = "stmet${substr(local.compact_name, 0, 14)}"
  storage_name                  = substr("${local.raw_archive_storage_prefix}${local.suffix}", 0, 24)
  directory_host_storage_name   = substr("${local.directory_host_storage_prefix}${local.suffix}", 0, 24)
  metrics_host_storage_name     = substr("${local.metrics_host_storage_prefix}${local.suffix}", 0, 24)
  key_vault_name                = substr("kv-${local.name}-${local.suffix}", 0, 24)
  private_endpoints_enabled     = var.private_endpoints_enabled

  create_sql        = var.existing_sql == null
  sql_server_name   = "sql-${local.name}-${local.suffix}"
  sql_server_fqdn   = local.create_sql ? module.sql[0].resource.fully_qualified_domain_name : "${split("/", var.existing_sql.server_id)[8]}.database.windows.net"
  sql_database_name = local.create_sql ? "sqldb-${local.name}" : split("/", var.existing_sql.database_id)[10]

  directory_platform_state = {
    enabled               = false
    scm_site_also_stopped = true
  }

  raw_archive_identity_key            = "ingestion"
  metrics_host_storage_identity_key   = "ingestion"
  directory_host_storage_identity_key = "directory"
}

resource "azurerm_resource_group" "this" {
  count = var.existing_resource_group_name == null ? 1 : 0

  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

data "azurerm_resource_group" "existing" {
  count = var.existing_resource_group_name == null ? 0 : 1

  name = var.existing_resource_group_name
}

# Demo SQL server with Entra-only authentication, or the shared server referenced as existing (D-34).
# Database users for the identities are created by the SQL migrations, not by Terraform.
module "sql" {
  count   = local.create_sql ? 1 : 0
  source  = "Azure/avm-res-sql-server/azurerm"
  version = "0.2.1"

  name                = local.sql_server_name
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  server_version      = "12.0"
  tags                = local.tags

  public_network_access_enabled = !var.private_endpoints_enabled

  azuread_administrator = {
    azuread_authentication_only = true
    login_username              = var.sql_admin.login_username
    object_id                   = var.sql_admin.object_id
    tenant_id                   = var.organization.entra_tenant_id
  }

  databases = {
    portal = {
      name        = "sqldb-${local.name}"
      sku_name    = var.sql_database_sku
      max_size_gb = 32
    }
  }

  private_endpoints = local.private_endpoints_enabled ? {
    sql = {
      subnet_resource_id            = var.network.subnet_id
      subresource_name              = "sqlServer"
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, "sql", null)])
    }
  } : {}

  enable_telemetry = false
}

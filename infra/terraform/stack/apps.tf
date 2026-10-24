# One Linux plan hosts the Next.js portal and the ingestion Functions app (§12.4); each has its own identity.
module "app_service_plan" {
  source  = "Azure/avm-res-web-serverfarm/azurerm"
  version = "2.0.8"

  name      = "asp-${local.name}"
  location  = var.location
  parent_id = local.resource_group_id
  os_type   = "Linux"
  sku_name  = var.app_service_sku
  tags      = local.tags

  enable_telemetry = false
}

locals {
  common_app_settings = {
    ENTERPRISE_SLUG      = var.organization.enterprise_slug
    ORGANIZATIONS        = join(",", var.organization.organizations)
    LOGIN_SUFFIX         = var.organization.login_suffix
    GROUP_PREFIX         = var.organization.group_prefix
    DIRECTORY_PROVIDER   = var.organization.directory_provider
    ENTRA_TENANT_ID      = var.organization.entra_tenant_id
    MODULE_AI_CREDITS    = tostring(var.modules.ai_credits)
    MODULE_BUDGET_LOOKUP = tostring(var.modules.budget_lookup)
    MODULE_FEEDBACK      = tostring(var.modules.feedback)
    SQL_SERVER           = local.sql_server_fqdn
    SQL_DATABASE         = local.sql_database_name
    KEY_VAULT_URI        = module.key_vault.uri
  }
}

module "portal" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "0.24.1"

  name                     = "app-${local.name}-${local.suffix}"
  location                 = var.location
  parent_id                = local.resource_group_id
  kind                     = "webapp"
  os_type                  = "Linux"
  service_plan_resource_id = module.app_service_plan.resource_id
  tags                     = local.tags

  https_only                             = true
  virtual_network_subnet_id              = var.network.integration_subnet_id
  application_insights_connection_string = local.application_insights_connection_string
  key_vault_reference_identity           = module.identity["portal"].resource_id

  managed_identities = { user_assigned_resource_ids = [module.identity["portal"].resource_id] }

  site_config = {
    application_stack = { node = { node_version = "22-lts" } }
  }

  app_settings = merge(local.common_app_settings, {
    AZURE_CLIENT_ID = module.identity["portal"].client_id
  })

  enable_telemetry = false
}

module "ingestion" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "0.24.1"

  name                     = "func-${local.name}-${local.suffix}"
  location                 = var.location
  parent_id                = local.resource_group_id
  kind                     = "functionapp"
  os_type                  = "Linux"
  service_plan_resource_id = module.app_service_plan.resource_id
  tags                     = local.tags

  https_only                             = true
  virtual_network_subnet_id              = var.network.integration_subnet_id
  application_insights_connection_string = local.application_insights_connection_string
  key_vault_reference_identity           = module.identity["ingestion"].resource_id

  storage_account_name                     = module.storage.name
  storage_uses_managed_identity            = true
  storage_user_assigned_identity_client_id = module.identity["ingestion"].client_id

  managed_identities = { user_assigned_resource_ids = [module.identity["ingestion"].resource_id] }

  site_config = {
    application_stack = { node = { node_version = "22" } }
  }

  app_settings = merge(local.common_app_settings, {
    AZURE_CLIENT_ID            = module.identity["ingestion"].client_id
    RAW_ARCHIVE_ACCOUNT        = module.storage.name
    RAW_ARCHIVE_CONTAINER      = "raw"
    STALE_DATA_THRESHOLD_HOURS = tostring(var.stale_data_threshold_hours)
  })

  enable_telemetry = false
}

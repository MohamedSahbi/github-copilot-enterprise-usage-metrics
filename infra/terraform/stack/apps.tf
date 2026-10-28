# One Linux plan hosts the portal and separate metrics/directory Functions apps (§12.4); each has its own identity.
module "app_service_plan" {
  source  = "Azure/avm-res-web-serverfarm/azurerm"
  version = "2.0.8"

  name      = "asp-${local.name}"
  location  = var.location
  parent_id = local.resource_group_id
  os_type   = "Linux"
  sku_name  = var.app_service_sku

  # The module defaults to zone balancing, which Basic and Standard SKUs reject. Enable it only on P1v2 or newer in zone-capable regions.
  zone_balancing_enabled = var.app_service_zone_redundant
  tags                   = local.tags

  enable_telemetry = false
}

locals {
  portal_app_name    = "app-${local.name}-${local.suffix}"
  ingestion_app_name = "func-${local.name}-${local.suffix}"
  directory_app_name = "func-directory-${local.name}-${local.suffix}"

  # The AVM web-site module defaults public access to off; the portal has no private endpoint, so it must opt in.
  portal_public_network_access_enabled = !var.private_endpoints_enabled
  portal_ip_restrictions = [
    for index, address in var.portal_allowed_ipv4_addresses : {
      action     = "Allow"
      ip_address = "${address}/32"
      name       = "portal-allow-${index}"
      priority   = 100 + index
    }
  ]
  portal_ip_restriction_default_action = length(local.portal_ip_restrictions) > 0 ? "Deny" : "Allow"

  common_app_settings = {
    ENTERPRISE_SLUG                   = var.organization.enterprise_slug
    ORGANIZATIONS                     = join(",", var.organization.organizations)
    LOGIN_SUFFIX                      = var.organization.login_suffix
    GROUP_PREFIX                      = var.organization.group_prefix
    DIRECTORY_PROVIDER                = var.organization.directory_provider
    ENTRA_TENANT_ID                   = var.organization.entra_tenant_id
    DIRECTORY_DEPARTMENT_ATTRIBUTE    = var.directory_department_attribute
    DIRECTORY_BUSINESS_AREA_ATTRIBUTE = var.directory_business_area_attribute
    STALE_DATA_THRESHOLD_HOURS        = tostring(var.stale_data_threshold_hours)
    MODULE_AI_CREDITS                 = tostring(var.modules.ai_credits)
    MODULE_BUDGET_LOOKUP              = tostring(var.modules.budget_lookup)
    MODULE_FEEDBACK                   = tostring(var.modules.feedback)
    SQL_SERVER                        = local.sql_server_fqdn
    SQL_DATABASE                      = local.sql_database_name
    KEY_VAULT_URI                     = module.key_vault.uri
  }

  budget_lookup_key_setting = var.modules.budget_lookup ? {
    BUDGET_LOOKUP_KEY = format("@Microsoft.KeyVault(SecretUri=%s/secrets/budget-lookup-key)", trimsuffix(module.key_vault.uri, "/"))
  } : {}

  portal_auth_trust_host_setting = var.auth_trust_host ? {
    AUTH_TRUST_HOST = "true"
  } : {}

  ingestion_key_vault_reference_identity = module.identity["ingestion"].resource_id

  directory_app_settings = merge(local.common_app_settings, {
    DIRECTORY_SYNC_SCHEDULE          = var.directory_sync_schedule
    FUNCTIONS_EXTENSION_VERSION      = "~4"
    FUNCTIONS_WORKER_RUNTIME         = "node"
    AZURE_CLIENT_ID                  = module.identity["directory"].client_id
    AzureWebJobsStorage__accountName = module.directory_host_storage.name
    AzureWebJobsStorage__credential  = "managedidentity"
    AzureWebJobsStorage__clientId    = module.identity["directory"].client_id
    GITHUB_DIRECTORY_PAT             = format("@Microsoft.KeyVault(SecretUri=%s/secrets/github-directory-pat)", trimsuffix(module.key_vault.uri, "/"))
  })

  portal_app_settings = merge(local.common_app_settings, {
    AUTH_URL                            = coalesce(var.portal_public_url, "https://${local.portal_app_name}.azurewebsites.net")
    AZURE_CLIENT_ID                     = module.identity["portal"].client_id
    AUTH_MICROSOFT_ENTRA_ID_ID          = var.auth_microsoft_entra_id_id
    AUTH_MICROSOFT_ENTRA_ID_SECRET      = format("@Microsoft.KeyVault(SecretUri=%s/secrets/auth-microsoft-entra-id-secret)", trimsuffix(module.key_vault.uri, "/"))
    AUTH_GITHUB_ID                      = var.auth_github_id
    AUTH_GITHUB_SECRET                  = format("@Microsoft.KeyVault(SecretUri=%s/secrets/auth-github-secret)", trimsuffix(module.key_vault.uri, "/"))
    AUTH_SECRET                         = format("@Microsoft.KeyVault(SecretUri=%s/secrets/auth-secret)", trimsuffix(module.key_vault.uri, "/"))
    ACCESS_BREAK_GLASS_GROUP_ID         = var.access_break_glass_group_id
    ACCESS_PERMISSION_FRESHNESS_MINUTES = tostring(var.access_permission_freshness_minutes)
    ACCESS_NO_ACCESS_MESSAGE            = var.access_no_access_message
    ACCESS_REQUEST_URL                  = var.access_request_url
    ACCESS_CONTACT                      = var.access_contact
    PER_USER_DETAIL_ENABLED             = tostring(var.per_user_detail_enabled)
  }, local.budget_lookup_key_setting, local.portal_auth_trust_host_setting)

  ingestion_app_settings = merge(local.common_app_settings, {
    METRICS_SYNC_SCHEDULE               = var.metrics_sync_schedule
    FUNCTIONS_EXTENSION_VERSION         = "~4"
    FUNCTIONS_WORKER_RUNTIME            = "node"
    "AzureWebJobs.metricsSync.Disabled" = "true"
    AzureWebJobsStorage__accountName    = module.storage.name
    AzureWebJobsStorage__credential     = "managedidentity"
    AzureWebJobsStorage__clientId       = module.identity["ingestion"].client_id
    AZURE_CLIENT_ID                     = module.identity["ingestion"].client_id
    GITHUB_APP_ID                       = var.github_app_id
    GITHUB_APP_PRIVATE_KEY              = format("@Microsoft.KeyVault(SecretUri=%s/secrets/github-app-private-key)", trimsuffix(module.key_vault.uri, "/"))
    RAW_ARCHIVE_ACCOUNT                 = module.storage.name
    RAW_ARCHIVE_CONTAINER               = "raw"
    }, var.backfill_from == null ? {} : {
    BACKFILL_FROM = var.backfill_from
  })
}

module "portal" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "0.24.1"

  name                     = local.portal_app_name
  location                 = var.location
  parent_id                = local.resource_group_id
  kind                     = "webapp"
  os_type                  = "Linux"
  service_plan_resource_id = module.app_service_plan.resource_id
  tags                     = local.tags

  https_only                             = true
  public_network_access_enabled          = local.portal_public_network_access_enabled
  virtual_network_subnet_id              = var.network.integration_subnet_id
  application_insights_connection_string = local.application_insights_connection_string
  key_vault_reference_identity           = module.identity["portal"].resource_id

  managed_identities = { user_assigned_resource_ids = [module.identity["portal"].resource_id] }
  depends_on         = [azurerm_role_assignment.secret_readers]

  site_config = {
    application_stack             = { node = { node_version = "22-lts" } }
    ip_restriction                = local.portal_ip_restrictions
    ip_restriction_default_action = local.portal_ip_restriction_default_action
  }

  app_settings = local.portal_app_settings

  enable_telemetry = false
}

module "ingestion" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "0.24.1"

  name                     = local.ingestion_app_name
  location                 = var.location
  parent_id                = local.resource_group_id
  kind                     = "functionapp"
  os_type                  = "Linux"
  service_plan_resource_id = module.app_service_plan.resource_id
  tags                     = local.tags

  https_only                             = true
  virtual_network_subnet_id              = var.network.integration_subnet_id
  application_insights_connection_string = local.application_insights_connection_string
  key_vault_reference_identity           = local.ingestion_key_vault_reference_identity

  storage_account_name                     = module.storage.name
  storage_uses_managed_identity            = true
  storage_user_assigned_identity_client_id = module.identity["ingestion"].client_id

  managed_identities = { user_assigned_resource_ids = [module.identity["ingestion"].resource_id] }
  depends_on         = [azurerm_role_assignment.secret_readers]

  site_config = {
    application_stack = { node = { node_version = "22" } }
  }

  app_settings = local.ingestion_app_settings

  enable_telemetry = false
}

module "directory" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "0.24.1"

  name                     = local.directory_app_name
  location                 = var.location
  parent_id                = local.resource_group_id
  kind                     = "functionapp"
  os_type                  = "Linux"
  service_plan_resource_id = module.app_service_plan.resource_id
  tags                     = local.tags

  https_only                             = true
  enabled                                = local.directory_platform_state.enabled
  scm_site_also_stopped                  = local.directory_platform_state.scm_site_also_stopped
  virtual_network_subnet_id              = var.network.integration_subnet_id
  application_insights_connection_string = local.application_insights_connection_string
  key_vault_reference_identity           = module.identity["directory"].resource_id

  storage_account_name                     = module.directory_host_storage.name
  storage_uses_managed_identity            = true
  storage_user_assigned_identity_client_id = module.identity["directory"].client_id

  managed_identities = { user_assigned_resource_ids = [module.identity["directory"].resource_id] }
  depends_on = [
    azurerm_role_assignment.secret_readers,
    module.directory_host_storage,
  ]

  site_config = {
    application_stack = { node = { node_version = "22" } }
  }

  app_settings = local.directory_app_settings

  enable_telemetry = false
}

locals {
  create_monitoring = var.existing_monitoring == null

  # Resource IDs have the fixed shape /subscriptions/{id}/resourceGroups/{rg}/providers/{type}/.../{name}.
  existing_ai_parts = local.create_monitoring ? [] : split("/", var.existing_monitoring.application_insights_id)

  log_analytics_workspace_id = local.create_monitoring ? module.log_analytics[0].resource_id : var.existing_monitoring.log_analytics_workspace_id

  # The module defaults both to "false", which drops all telemetry unless a private link scope is set up.
  # Like the other resources, open them only when private endpoints are off (dev).
  log_analytics_public_access_enabled = tostring(!var.private_endpoints_enabled)
}

module "log_analytics" {
  count   = local.create_monitoring ? 1 : 0
  source  = "Azure/avm-res-operationalinsights-workspace/azurerm"
  version = "0.5.1"

  name                = "log-${local.name}"
  location            = var.location
  resource_group_name = local.resource_group_name
  tags                = local.tags

  log_analytics_workspace_retention_in_days          = var.log_retention_days
  log_analytics_workspace_internet_ingestion_enabled = local.log_analytics_public_access_enabled
  log_analytics_workspace_internet_query_enabled     = local.log_analytics_public_access_enabled
  enable_telemetry                                   = false
}

module "application_insights" {
  count   = local.create_monitoring ? 1 : 0
  source  = "Azure/avm-res-insights-component/azurerm"
  version = "0.5.0"

  name         = "appi-${local.name}"
  location     = var.location
  parent_id    = local.resource_group_id
  workspace_id = local.log_analytics_workspace_id
  tags         = local.tags

  enable_telemetry = false
}

data "azurerm_application_insights" "existing" {
  count               = local.create_monitoring ? 0 : 1
  name                = local.existing_ai_parts[8]
  resource_group_name = local.existing_ai_parts[4]
}

locals {
  application_insights_connection_string = local.create_monitoring ? module.application_insights[0].connection_string : data.azurerm_application_insights.existing[0].connection_string
}

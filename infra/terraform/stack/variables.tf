variable "environment" {
  description = "Environment name; each environment has its own root, resource group, and state."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test, or prod."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "existing_resource_group_name" {
  description = "Name of a pre-existing resource group to deploy into. Null creates rg-<name_prefix>-<environment>. The deploying identity needs Owner or Contributor plus User Access Administrator on it."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Short prefix for resource names, for example the product or team name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{2,12}$", var.name_prefix))
    error_message = "name_prefix must be 2-12 lowercase letters or digits."
  }
}

variable "modules" {
  description = "Optional module flags (D-1). Enabling a module needs only a secret and a permission; schema never changes."
  type = object({
    ai_credits    = optional(bool, false)
    budget_lookup = optional(bool, false)
    feedback      = optional(bool, false)
  })
  default = {}
}

variable "organization" {
  description = "Organization facts the portal reads as app settings (D-46). Real values live only in the private deployment repository."
  type = object({
    enterprise_slug    = string
    organizations      = list(string)
    login_suffix       = string
    group_prefix       = optional(string, "")
    directory_provider = optional(string, "entra")
    entra_tenant_id    = string
  })

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.organization.enterprise_slug))
    error_message = "organization.enterprise_slug must be lowercase letters, digits, or hyphens."
  }

  validation {
    condition     = contains(["entra", "csv"], var.organization.directory_provider)
    error_message = "organization.directory_provider must be entra or csv (D-4)."
  }

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.organization.entra_tenant_id))
    error_message = "organization.entra_tenant_id must be a GUID."
  }
}

variable "alert_emails" {
  description = "Email receivers for the Azure Monitor action group (D-50)."
  type        = list(string)
  default     = []
}

variable "stale_data_threshold_hours" {
  description = "Raise the data-staleness alert after this many hours without a successful ingestion."
  type        = number
  default     = 36
}

variable "private_endpoints_enabled" {
  description = "Private endpoints on by default; disable only for development (D-19)."
  type        = bool
  default     = true
}

variable "network" {
  description = "How each network dependency is provided: create (demo), existing (enterprise default), or import (D-35)."
  type = object({
    mode                  = optional(string, "existing")
    subnet_id             = optional(string)
    integration_subnet_id = optional(string)
    private_dns_zones     = optional(map(string), {})
  })
  default = {}

  validation {
    condition     = contains(["create", "existing", "import"], var.network.mode)
    error_message = "network.mode must be create, existing, or import."
  }

  validation {
    condition     = var.network.mode != "existing" || !var.private_endpoints_enabled || var.network.subnet_id != null
    error_message = "network.subnet_id is required when network.mode is existing and private endpoints are enabled."
  }
}

variable "sql_admin" {
  description = "Entra group or user that administers the demo SQL server. Required when existing_sql is null."
  type = object({
    login_username = string
    object_id      = string
  })
  default = null

  validation {
    condition     = var.existing_sql != null || var.sql_admin != null
    error_message = "sql_admin is required when existing_sql is null."
  }
}

variable "sql_database_sku" {
  description = "SKU of the demo database."
  type        = string
  default     = "GP_S_Gen5_1"
}

variable "app_service_zone_redundant" {
  description = "Spread the App Service plan across availability zones. Needs P1v2 or newer and a zone-capable region; false for dev."
  type        = bool
  default     = false
}

variable "sql_max_size_gb" {
  description = "Maximum size of the demo database in GB. It must be valid for sql_database_sku: Basic and Standard SKUs do not accept 32."
  type        = number
  default     = 32
}

variable "sql_serverless_min_capacity" {
  description = "Minimum vCores of a serverless database (GP_S_* SKUs only). Must be above zero."
  type        = number
  default     = 0.5
}

variable "app_service_sku" {
  description = "SKU of the Linux App Service plan shared by the portal and the ingestion Functions."
  type        = string
  default     = "B1"
}

variable "existing_sql" {
  description = "Shared SQL server and database referenced as existing, never imported (D-34). Null creates a demo server."
  type = object({
    server_id   = string
    database_id = string
  })
  default = null
}

variable "existing_monitoring" {
  description = "Existing Log Analytics workspace and Application Insights component, referenced and never changed (D-24). Null creates both."
  type = object({
    log_analytics_workspace_id = string
    application_insights_id    = string
  })
  default = null
}

variable "log_retention_days" {
  description = "Log Analytics retention in days when the workspace is created (30 to 730)."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730."
  }
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

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
    ai_credits     = optional(bool, false)
    budget_lookup  = optional(bool, false)
    feedback       = optional(bool, false)
    upstream_views = optional(bool, false)
  })
  default = {}
}

variable "github_app_id" {
  description = "Positive-decimal identifier of the GitHub App used only by metrics ingestion; not a secret."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_id)) && can(regex("[1-9]", var.github_app_id))
    error_message = "github_app_id must be a positive decimal identifier."
  }
}

variable "backfill_from" {
  description = "Optional inclusive metrics API backfill start date (YYYY-MM-DD). The runtime enforces the moving API-start and 365-day window."
  type        = string
  default     = null

  validation {
    condition     = var.backfill_from == null || (can(regex("^\\d{4}-\\d{2}-\\d{2}$", var.backfill_from)) && can(formatdate("YYYY-MM-DD", "${var.backfill_from}T00:00:00Z")) && formatdate("YYYY-MM-DD", "${var.backfill_from}T00:00:00Z") == var.backfill_from)
    error_message = "backfill_from must be a valid calendar date in YYYY-MM-DD format or omitted."
  }
}

variable "metrics_sync_schedule" {
  description = "Required six-field UTC NCRONTAB schedule for the metrics timer Function. No default cadence is applied; activation remains gated on #64."
  type        = string

  validation {
    condition = length(split(" ", trimspace(var.metrics_sync_schedule))) == 6 && alltrue([
      for index, field in split(" ", trimspace(var.metrics_sync_schedule)) :
      can(regex("^(\\*|[0-9]+)(-[0-9]+)?(/[1-9][0-9]*)?(,(\\*|[0-9]+)(-[0-9]+)?(/[1-9][0-9]*)?)*$", field)) &&
      alltrue([
        for token in split(",", field) :
        split("/", token)[0] == "*" || (
          alltrue([
            for value in split("-", split("/", token)[0]) :
            try(tonumber(value), -1) >= try([0, 0, 0, 1, 1, 0][index], 0) &&
            try(tonumber(value), -1) <= try([59, 59, 23, 31, 12, 6][index], -1)
          ]) &&
          (
            length(split("-", split("/", token)[0])) == 1 ||
            try(tonumber(split("-", split("/", token)[0])[0]), -1) <= try(tonumber(split("-", split("/", token)[0])[1]), -1)
          )
        )
      ])
    ])
    error_message = "metrics_sync_schedule must be a six-field UTC NCRONTAB expression."
  }
}

variable "metrics_sync_enabled" {
  description = "Turns the metrics timer Function on (AzureWebJobs.metricsSync.Disabled = false). Off by default; the owner sets it per environment, and it needs the #64 App-token check and the #55/#56 gates to have passed."
  type        = bool
  default     = false
}

variable "directory_sync_enabled" {
  description = "Turns the directory Function App and its SCM site on. Off by default; the owner sets it per environment once the directory PAT is in Key Vault and the directory SQL user is mapped (#56)."
  type        = bool
  default     = false
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
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.organization.entra_tenant_id))
    error_message = "organization.entra_tenant_id must be a GUID."
  }

  validation {
    condition = length(var.organization.organizations) > 0 && alltrue([
      for organization in var.organization.organizations :
      length(organization) <= 39 && can(regex("^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$", organization))
    ]) && length(distinct([for organization in var.organization.organizations : lower(organization)])) == length(var.organization.organizations)
    error_message = "organization.organizations must be unique valid GitHub logins."
  }
}

variable "portal_public_url" {
  description = "Optional HTTPS origin for portal sign-in callbacks; null uses the App Service default hostname."
  type        = string
  default     = null

  validation {
    condition = var.portal_public_url == null ? true : (
      can(regex("^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?/?$", var.portal_public_url)) &&
      try(tonumber(regex(":([0-9]+)/?$", var.portal_public_url)[0]), 443) >= 1 &&
      try(tonumber(regex(":([0-9]+)/?$", var.portal_public_url)[0]), 443) <= 65535
    )
    error_message = "Use an HTTPS origin only, or null for the default hostname."
  }
}

variable "auth_trust_host" {
  description = "Whether Auth.js trusts the forwarded host. Enable only behind a trusted forwarding ingress."
  type        = bool

  validation {
    condition     = !var.auth_trust_host || var.trusted_forwarding_ingress
    error_message = "auth_trust_host can be true only when trusted_forwarding_ingress is true."
  }
}

variable "trusted_forwarding_ingress" {
  description = "Operator assertion that a trusted ingress controls forwarded host and protocol headers."
  type        = bool
  default     = false
}

variable "auth_microsoft_entra_id_id" {
  description = "Client ID of the portal's Entra sign-in application."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.auth_microsoft_entra_id_id))
    error_message = "auth_microsoft_entra_id_id must be a GUID."
  }
}

variable "auth_github_id" {
  description = "Client ID of the separate GitHub sign-in OAuth application."
  type        = string

  validation {
    condition     = trimspace(var.auth_github_id) != ""
    error_message = "auth_github_id must not be empty."
  }
}

variable "access_break_glass_group_id" {
  description = "Entra group object ID allowed to use the restricted break-glass path; empty disables it."
  type        = string
  default     = ""

  validation {
    condition     = var.access_break_glass_group_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.access_break_glass_group_id))
    error_message = "access_break_glass_group_id must be empty or an Entra group object ID (GUID)."
  }
}

variable "access_permission_freshness_minutes" {
  description = "Maximum age of verified permission evidence in whole minutes (D-17)."
  type        = number
  default     = 5

  validation {
    condition     = var.access_permission_freshness_minutes >= 1 && var.access_permission_freshness_minutes <= 60 && floor(var.access_permission_freshness_minutes) == var.access_permission_freshness_minutes
    error_message = "access_permission_freshness_minutes must be an integer between 1 and 60."
  }
}

variable "access_no_access_message" {
  description = "Optional message shown after a completed permission lookup with no usable grant."
  type        = string
  default     = "You do not currently have permission to use this portal."
}

variable "access_request_url" {
  description = "Optional HTTPS request-access link; empty hides the link."
  type        = string
  default     = ""

  validation {
    condition     = var.access_request_url == "" || can(regex("^https://[^\\s]+$", var.access_request_url))
    error_message = "access_request_url must be empty or an HTTPS URL without whitespace."
  }
}

variable "access_contact" {
  description = "Optional plain-text access contact; empty hides it."
  type        = string
  default     = ""
}

variable "directory_department_attribute" {
  description = "Entra attribute path used for department scope; empty disables that scope."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.directory_department_attribute) == "" || can(regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)*$", trimspace(var.directory_department_attribute)))
    error_message = "directory_department_attribute must be empty or an Entra attribute path."
  }
}

variable "directory_business_area_attribute" {
  description = "Entra attribute path used for business-area scope; empty disables that scope."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.directory_business_area_attribute) == "" || can(regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)*$", trimspace(var.directory_business_area_attribute)))
    error_message = "directory_business_area_attribute must be empty or an Entra attribute path."
  }
}

variable "directory_sync_schedule" {
  description = "Required six-field UTC NCRONTAB schedule for the directory timer Function. No default cadence is applied."
  type        = string

  validation {
    condition = length(split(" ", trimspace(var.directory_sync_schedule))) == 6 && alltrue([
      for index, field in split(" ", trimspace(var.directory_sync_schedule)) :
      can(regex("^(\\*|[0-9]+)(-[0-9]+)?(/[1-9][0-9]*)?(,(\\*|[0-9]+)(-[0-9]+)?(/[1-9][0-9]*)?)*$", field)) &&
      alltrue([
        for token in split(",", field) :
        split("/", token)[0] == "*" || (
          alltrue([
            for value in split("-", split("/", token)[0]) :
            try(tonumber(value), -1) >= try([0, 0, 0, 1, 1, 0][index], 0) &&
            try(tonumber(value), -1) <= try([59, 59, 23, 31, 12, 6][index], -1)
          ]) &&
          (
            length(split("-", split("/", token)[0])) == 1 ||
            try(tonumber(split("-", split("/", token)[0])[0]), -1) <= try(tonumber(split("-", split("/", token)[0])[1]), -1)
          )
        )
      ])
    ])
    error_message = "directory_sync_schedule must be a six-field UTC NCRONTAB expression."
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

  validation {
    condition     = var.stale_data_threshold_hours >= 1 && floor(var.stale_data_threshold_hours) == var.stale_data_threshold_hours
    error_message = "stale_data_threshold_hours must be a positive whole number."
  }
}

variable "min_group_size" {
  description = "Minimum distinct users a reported group needs before the portal shows it; smaller groups are hidden."
  type        = number
  default     = 5

  validation {
    condition     = var.min_group_size >= 2 && floor(var.min_group_size) == var.min_group_size
    error_message = "min_group_size must be a whole number of at least 2."
  }
}

variable "per_user_detail_enabled" {
  description = "Whether the portal may return per-user detail; false keeps responses aggregate-only."
  type        = bool
  default     = false
}

variable "private_endpoints_enabled" {
  description = "Private endpoints on by default; disable only for development (D-19)."
  type        = bool
  default     = true
}

variable "key_vault_operator_object_ids" {
  description = "Entra user object IDs allowed to manage vault secrets as Secrets Officer; no operators by default."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = (
      length(distinct([for id in var.key_vault_operator_object_ids : lower(id)])) == length(var.key_vault_operator_object_ids) &&
      alltrue([for id in var.key_vault_operator_object_ids : can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", id))])
    )
    error_message = "Operator object IDs must be unique Entra user GUIDs."
  }
}

variable "key_vault_allowed_ipv4_addresses" {
  description = "IPv4 egress addresses permitted by the public Key Vault firewall; each is emitted as a /32 rule."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      length(var.key_vault_allowed_ipv4_addresses) <= 1000,
      length(distinct(var.key_vault_allowed_ipv4_addresses)) == length(var.key_vault_allowed_ipv4_addresses),
      alltrue([for address in var.key_vault_allowed_ipv4_addresses : can(cidrnetmask("${address}/32"))]),
    ])
    error_message = "Addresses must be unique bare IPv4 literals (maximum 1000)."
  }

  validation {
    condition     = var.private_endpoints_enabled || length(var.key_vault_allowed_ipv4_addresses) > 0
    error_message = "Set key_vault_allowed_ipv4_addresses when private endpoints are disabled."
  }
}

variable "portal_allowed_ipv4_addresses" {
  description = "IPv4 addresses allowed to reach the public portal; each is emitted as a /32 rule and the default becomes Deny. Empty leaves the portal open to sign-in."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      length(var.portal_allowed_ipv4_addresses) <= 100,
      length(distinct(var.portal_allowed_ipv4_addresses)) == length(var.portal_allowed_ipv4_addresses),
      alltrue([for address in var.portal_allowed_ipv4_addresses : can(cidrnetmask("${address}/32"))]),
    ])
    error_message = "Addresses must be unique bare IPv4 literals (maximum 100)."
  }
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

variable "raw_archive_recovery_days" {
  description = "Days that deleted blobs, deleted containers and noncurrent blob versions stay recoverable in the metrics raw archive account."
  type        = number
  default     = 30

  validation {
    condition     = var.raw_archive_recovery_days >= 7 && var.raw_archive_recovery_days <= 365 && floor(var.raw_archive_recovery_days) == var.raw_archive_recovery_days
    error_message = "raw_archive_recovery_days must be a whole number from 7 to 365."
  }
}

variable "raw_archive_cool_after_months" {
  description = "Age in whole months before raw archive blobs move to Cool. Azure lifecycle policies use age in days."
  type        = number
  default     = 13

  validation {
    condition     = var.raw_archive_cool_after_months >= 1 && floor(var.raw_archive_cool_after_months) == var.raw_archive_cool_after_months
    error_message = "raw_archive_cool_after_months must be a positive whole number."
  }
}

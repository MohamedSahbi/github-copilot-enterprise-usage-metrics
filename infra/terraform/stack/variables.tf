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
    mode              = optional(string, "existing")
    subnet_id         = optional(string)
    private_dns_zones = optional(map(string), {})
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

variable "existing_sql" {
  description = "Shared SQL server and database referenced as existing, never imported (D-34). Null creates a demo server."
  type = object({
    server_id   = string
    database_id = string
  })
  default = null
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

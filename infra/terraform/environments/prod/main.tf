terraform {
  required_version = ">= 1.11"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # Partial configuration; supply storage account, container, and key at init time (see ../../README.md).
  backend "azurerm" {}
}

# Authentication is OIDC via ARM_CLIENT_ID, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID, ARM_USE_OIDC (no stored secrets).
provider "azurerm" {
  features {}
}

variable "location" { type = string }
variable "name_prefix" { type = string }
variable "organization" { type = any }
variable "modules" {
  type    = any
  default = {}
}
variable "alert_emails" {
  type    = list(string)
  default = []
}
variable "private_endpoints_enabled" {
  type    = bool
  default = true
}
variable "network" {
  type    = any
  default = {}
}
variable "existing_sql" {
  type    = any
  default = null
}
variable "existing_monitoring" {
  type    = any
  default = null
}
variable "log_retention_days" {
  type    = number
  default = 30
}

module "stack" {
  source = "../../stack"

  environment               = "prod"
  location                  = var.location
  name_prefix               = var.name_prefix
  organization              = var.organization
  modules                   = var.modules
  alert_emails              = var.alert_emails
  private_endpoints_enabled = var.private_endpoints_enabled
  network                   = var.network
  existing_sql              = var.existing_sql
  existing_monitoring       = var.existing_monitoring
  log_retention_days        = var.log_retention_days
}

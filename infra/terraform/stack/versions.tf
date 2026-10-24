terraform {
  # Key Vault AVM requires Terraform 1.11 or later (§12.1).
  required_version = ">= 1.11"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # Partial configuration; supply storage account, container, and one state key per environment at init time (see ../README.md).
  backend "azurerm" {}
}

# Authentication is OIDC via ARM_CLIENT_ID, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID, ARM_USE_OIDC (no stored secrets).
provider "azurerm" {
  features {}
}

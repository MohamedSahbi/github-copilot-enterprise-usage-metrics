locals {
  name = "${var.name_prefix}-${var.environment}"
  tags = merge(var.tags, { environment = var.environment })

  enabled_modules = [for name, enabled in var.modules : name if enabled]
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

# Next (separate changes, each pinned to a revalidated AVM version, §12.1): Key Vault (with one empty secret slot per
# enabled module), Storage, SQL (or existing_sql), the portal Web App, the ingestion Function App, and the alert action group.

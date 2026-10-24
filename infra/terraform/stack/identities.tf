# Separate least-privilege runtime identities for the portal and the ingestion Functions (§12.4).
# Role assignments are added next to the resources they grant access to.
module "identity" {
  for_each = toset(["portal", "ingestion"])
  source   = "Azure/avm-res-managedidentity-userassignedidentity/azurerm"
  version  = "0.5.3"

  name                = "id-${local.name}-${each.key}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags

  enable_telemetry = false
}

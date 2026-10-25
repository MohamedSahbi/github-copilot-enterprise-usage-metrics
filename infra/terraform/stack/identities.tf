# Separate least-privilege runtime identities for the portal and each Functions component (§12.4).
# Role assignments are added next to the resources they grant access to.
module "identity" {
  for_each = toset(["portal", "ingestion", "directory"])
  source   = "Azure/avm-res-managedidentity-userassignedidentity/azurerm"
  version  = "0.5.3"

  name                = "id-${local.name}-${each.key}"
  location            = var.location
  resource_group_name = local.resource_group_name
  tags                = local.tags

  enable_telemetry = false
}

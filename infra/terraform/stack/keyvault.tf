# Terraform does not create secrets: a placeholder would overwrite the operator's value on the next apply.
# Operators create each name listed in `secret_names`; each runtime identity receives only its component's secret access.
locals {
  secret_names_by_component = {
    portal = concat(
      ["auth-secret", "auth-microsoft-entra-id-secret", "auth-github-secret"],
      var.modules.budget_lookup ? ["budget-lookup-key"] : [],
    )
    ingestion = concat(
      ["github-app-private-key"],
      var.modules.ai_credits ? ["ai-credits-token"] : [],
    )
    directory = ["github-directory-pat"]
  }

  secret_names = concat(
    local.secret_names_by_component.portal,
    local.secret_names_by_component.ingestion,
    local.secret_names_by_component.directory,
  )

  key_vault_network_acls = {
    bypass                     = "None"
    default_action             = "Deny"
    ip_rules                   = [for address in var.key_vault_allowed_ipv4_addresses : "${address}/32"]
    virtual_network_subnet_ids = []
  }

  key_vault_public_network_access_enabled = !var.private_endpoints_enabled

  secret_identity_by_name = merge([
    for component, names in local.secret_names_by_component : {
      for name in names : name => component
    }
  ]...)
}

module "key_vault" {
  source  = "Azure/avm-res-keyvault-vault/azurerm"
  version = "0.12.0"

  name                = local.key_vault_name
  location            = var.location
  resource_group_name = local.resource_group_name
  tenant_id           = var.organization.entra_tenant_id
  tags                = local.tags

  purge_protection_enabled      = true
  public_network_access_enabled = local.key_vault_public_network_access_enabled
  network_acls                  = local.key_vault_network_acls

  private_endpoints = local.private_endpoints_enabled ? {
    vault = {
      subnet_resource_id            = var.network.subnet_id
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, "vault", null)])
    }
  } : {}

  role_assignments = {}

  enable_telemetry = false
}

resource "azurerm_role_assignment" "secret_readers" {
  for_each = local.secret_identity_by_name

  scope                = format("%s/secrets/%s", module.key_vault.resource_id, each.key)
  role_definition_name = "Key Vault Secrets User"
  principal_id         = module.identity[each.value].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "secret_operators" {
  for_each = toset([for id in var.key_vault_operator_object_ids : lower(id)])

  scope                = module.key_vault.resource_id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
  principal_type       = "User"
}

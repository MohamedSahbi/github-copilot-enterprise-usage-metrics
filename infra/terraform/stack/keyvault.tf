# Terraform does not create secrets: a placeholder would overwrite the operator's value on the next apply.
# Operators create each name listed in `secret_names`; each runtime identity receives only its component's secret access.
locals {
  secret_names_by_component = {
    portal = concat(
      ["github-oauth-client-secret", "auth-secret", "auth-microsoft-entra-id-secret", "auth-github-secret"],
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

  secret_identity_by_name = merge([
    for component, names in local.secret_names_by_component : {
      for name in names : name => component
    }
  ]...)

  missing_secret_names = setsubtract(
    toset(local.secret_names),
    toset(data.azurerm_key_vault_secrets.existing.names),
  )
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
  public_network_access_enabled = !var.private_endpoints_enabled

  private_endpoints = local.private_endpoints_enabled ? {
    vault = {
      subnet_resource_id            = var.network.subnet_id
      private_dns_zone_resource_ids = compact([lookup(var.network.private_dns_zones, "vault", null)])
    }
  } : {}

  role_assignments = {}

  enable_telemetry = false
}

# Reading only the names checks bootstrap ordering without placing secret values in Terraform state.
data "azurerm_client_config" "current" {}

data "azurerm_key_vault_secrets" "existing" {
  key_vault_id = format(
    "/subscriptions/%s/resourceGroups/%s/providers/Microsoft.KeyVault/vaults/%s",
    data.azurerm_client_config.current.subscription_id,
    local.resource_group_name,
    local.key_vault_name,
  )
}

resource "terraform_data" "required_key_vault_secrets" {
  input = local.secret_names

  lifecycle {
    precondition {
      condition     = length(local.missing_secret_names) == 0
      error_message = "Create the required Key Vault secrets before planning the full stack: ${join(", ", sort(tolist(local.missing_secret_names)))}."
    }
  }
}

resource "azurerm_role_assignment" "secret_readers" {
  for_each = local.secret_identity_by_name

  scope                = format("%s/secrets/%s", module.key_vault.resource_id, each.key)
  role_definition_name = "Key Vault Secrets User"
  principal_id         = module.identity[each.value].principal_id
  principal_type       = "ServicePrincipal"

  depends_on = [terraform_data.required_key_vault_secrets]
}

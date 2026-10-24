# RBAC vault. Terraform does not create the secrets: the Key Vault secret resource needs a value, and a placeholder would overwrite
# the operator's value on the next apply. Operators create each secret listed in the `secret_names` output (§12.4, D-9, D-37).
locals {
  secret_names = concat(
    ["github-app-private-key", "github-oauth-client-secret"],
    var.modules.ai_credits ? ["ai-credits-token"] : [],
    var.modules.budget_lookup ? ["budget-lookup-key"] : [],
    # Directory sync only; the portal and ingestion identities get no read access to it.
    ["github-directory-pat"],
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

  role_assignments = {
    portal = {
      role_definition_id_or_name = "Key Vault Secrets User"
      principal_id               = module.identity["portal"].principal_id
      principal_type             = "ServicePrincipal"
    }
    ingestion = {
      role_definition_id_or_name = "Key Vault Secrets User"
      principal_id               = module.identity["ingestion"].principal_id
      principal_type             = "ServicePrincipal"
    }
  }

  enable_telemetry = false
}

output "resource_group_name" {
  value = local.resource_group_name
}

output "enabled_modules" {
  description = "Names of the optional modules turned on in this environment."
  value       = local.enabled_modules
}

output "organization" {
  description = "Organization facts passed to the portal as app settings."
  value       = var.organization
}

output "log_analytics_workspace_id" {
  value = local.log_analytics_workspace_id
}

output "identities" {
  description = "Runtime identities by role; used for role assignments and app settings."
  value = {
    for role, id in module.identity : role => {
      resource_id  = id.resource_id
      client_id    = id.client_id
      principal_id = id.principal_id
    }
  }
}

output "secret_names" {
  description = "Key Vault secrets the operator must create after the first deployment (az keyvault secret set)."
  value       = local.secret_names
}

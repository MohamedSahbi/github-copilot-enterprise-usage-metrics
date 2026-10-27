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
  description = "Key Vault secret names for the operator's pre-apply check; Terraform does not query secret names or values."
  value       = local.secret_names
}

output "directory_runtime" {
  description = "Non-secret directory component references; the Function App remains disabled by Terraform."
  value = {
    function_app_resource_id         = module.directory.resource_id
    host_storage_account_name        = module.directory_host_storage.name
    host_storage_account_resource_id = module.directory_host_storage.resource_id
    sql_server_name                  = local.create_sql ? local.sql_server_name : split("/", var.existing_sql.server_id)[8]
    sql_database_name                = local.sql_database_name
  }
}

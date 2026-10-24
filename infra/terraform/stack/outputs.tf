output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "enabled_modules" {
  description = "Names of the optional modules turned on in this environment."
  value       = local.enabled_modules
}

mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example"
    }
  }

}
mock_provider "azapi" {}

run "demo_example" {
  command = plan

  assert {
    condition     = length(azurerm_role_assignment.secret_operators) == 0
    error_message = "No vault-wide operator access may be granted by default."
  }

  override_resource {
    target          = azurerm_resource_group.this[0]
    override_during = plan
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example"
    }
  }

  override_module {
    target = module.key_vault

    outputs = {
      uri         = "https://kv-example.vault.azure.net/"
      resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.KeyVault/vaults/kv-example"
    }
  }

  override_module {
    target = module.identity["ingestion"]

    outputs = {
      client_id    = "00000000-0000-0000-0000-000000000001"
      principal_id = "00000000-0000-0000-0000-000000000002"
      resource_id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-example-ingestion"
    }
  }

  assert {
    condition = alltrue([
      local.ingestion_app_settings.GITHUB_APP_ID == "123456",
      local.ingestion_app_settings.GITHUB_APP_PRIVATE_KEY == format(
        "@Microsoft.KeyVault(SecretUri=%s/secrets/github-app-private-key)",
        trimsuffix(module.key_vault.uri, "/"),
      ),
      local.ingestion_app_settings.AZURE_CLIENT_ID == "00000000-0000-0000-0000-000000000001",
      contains(keys(local.ingestion_app_settings), "AZURE_CLIENT_ID"),
      contains(keys(local.ingestion_app_settings), "SQL_SERVER"),
      local.ingestion_app_settings.SQL_DATABASE == local.sql_database_name,
      contains(keys(local.ingestion_app_settings), "RAW_ARCHIVE_ACCOUNT"),
      local.ingestion_app_settings.RAW_ARCHIVE_CONTAINER == "raw",
      local.ingestion_key_vault_reference_identity == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-example-ingestion",
      !contains(keys(local.ingestion_app_settings), "BACKFILL_FROM"),
      !contains(keys(local.ingestion_app_settings), "AUTH_GITHUB_ID"),
      contains(output.secret_names, "auth-secret"),
      contains(output.secret_names, "auth-microsoft-entra-id-secret"),
      contains(output.secret_names, "auth-github-secret"),
      contains(output.secret_names, "github-directory-pat"),
      local.key_vault_network_acls == {
        bypass                     = "None"
        default_action             = "Deny"
        ip_rules                   = ["192.0.2.10/32"]
        virtual_network_subnet_ids = []
      },
      local.key_vault_public_network_access_enabled,
    ])
    error_message = "The plan must retain component settings and allow only the explicit synthetic IPv4 rule under a deny-by-default vault firewall."
  }

  assert {
    condition = alltrue([
      local.portal_app_settings.AUTH_GITHUB_ID == "REPLACE_WITH_CLIENT_ID",
      !contains(keys(local.portal_app_settings), "GITHUB_APP_ID"),
      !contains(keys(local.portal_app_settings), "GITHUB_APP_PRIVATE_KEY"),
      !contains(keys(local.directory_app_settings), "GITHUB_APP_ID"),
      !contains(keys(local.directory_app_settings), "GITHUB_APP_PRIVATE_KEY"),
      !contains(keys(local.directory_app_settings), "BACKFILL_FROM"),
    ])
    error_message = "GitHub App ingestion settings must not leak into portal OAuth or directory runtime configuration."
  }

  assert {
    condition = local.secret_identity_by_name == {
      "github-oauth-client-secret"     = "portal"
      "auth-secret"                    = "portal"
      "auth-microsoft-entra-id-secret" = "portal"
      "auth-github-secret"             = "portal"
      "github-app-private-key"         = "ingestion"
      "github-directory-pat"           = "directory"
    }
    error_message = "Each default Key Vault secret must be granted only to its owning component identity."
  }

  assert {
    condition = alltrue([
      local.raw_archive_identity_key == "ingestion",
      toset(keys(local.raw_archive_role_assignments)) == toset(["ingestion_blob", "ingestion_queue", "ingestion_table"]),
    ])
    error_message = "Only the ingestion identity may access the metrics raw archive and its host storage."
  }

  assert {
    condition = alltrue([
      local.directory_host_storage_identity_key == "directory",
      toset(keys(local.directory_host_storage_role_assignments)) == toset(["directory_blob", "directory_queue", "directory_table"]),
      local.directory_host_storage_prefix != local.raw_archive_storage_prefix,
    ])
    error_message = "Directory host storage must be separate from the raw archive and accessible only to the directory identity."
  }

  assert {
    condition = alltrue([
      local.directory_platform_state.enabled == false,
      local.directory_platform_state.scm_site_also_stopped == true,
      nonsensitive(module.directory.resource).body.properties.enabled == false,
      nonsensitive(module.directory.resource).body.properties.scmSiteAlsoStopped == true,
      local.directory_app_settings.DIRECTORY_SYNC_SCHEDULE == var.directory_sync_schedule,
      local.directory_app_settings.FUNCTIONS_EXTENSION_VERSION == "~4",
      local.directory_app_settings.FUNCTIONS_WORKER_RUNTIME == "node",
      contains(keys(local.directory_app_settings), "GITHUB_DIRECTORY_PAT"),
      local.directory_app_settings.SQL_DATABASE == local.sql_database_name,
      contains(keys(local.directory_app_settings), "SQL_SERVER"),
      !contains(keys(local.directory_app_settings), "SQL_CONNECTION_STRING"),
      !contains(keys(local.directory_app_settings), "SQL_USER"),
      !contains(keys(local.directory_app_settings), "SQL_PASSWORD"),
      local.directory_app_settings.AzureWebJobsStorage__credential == "managedidentity",
      contains(keys(local.directory_app_settings), "AzureWebJobsStorage__accountName"),
      contains(keys(local.directory_app_settings), "AzureWebJobsStorage__clientId"),
      !contains(keys(local.directory_app_settings), "AzureWebJobsStorage"),
    ])
    error_message = "The directory Function must stay natively disabled with its own PAT, identity, host storage, and new-solution database reference."
  }

  assert {
    condition     = length(local.portal_auth_trust_host_setting) == 0
    error_message = "Auth.js host trust must be omitted when it is disabled; the string false is truthy."
  }

  assert {
    condition = (
      local.portal_app_settings.AUTH_URL == "https://app-${local.name}-${local.suffix}.azurewebsites.net" &&
      !contains(keys(local.portal_app_settings), "AUTH_TRUST_HOST")
    )
    error_message = "The portal must have a canonical HTTPS AUTH_URL without enabling forwarded-host trust."
  }
}

run "portal_custom_origin" {
  command = plan

  variables {
    portal_public_url = "https://portal.example.com"
  }

  assert {
    condition = (
      local.portal_app_settings.AUTH_URL == "https://portal.example.com" &&
      !contains(keys(local.portal_app_settings), "AUTH_TRUST_HOST") &&
      !contains(keys(local.ingestion_app_settings), "AUTH_URL") &&
      !contains(keys(local.directory_app_settings), "AUTH_URL")
    )
    error_message = "The custom origin must override only the portal AUTH_URL without enabling forwarded-host trust."
  }
}

run "portal_rejects_non_origin_url" {
  command = plan

  variables {
    portal_public_url = "https://portal.example.com/api/auth"
  }

  expect_failures = [var.portal_public_url]
}

run "explicit_secret_operators" {
  command = plan

  variables {
    key_vault_operator_object_ids = [
      "00000000-0000-0000-0000-000000000001",
      "AAAAAAAA-0000-0000-0000-000000000002",
    ]
  }

  override_module {
    target = module.key_vault
    outputs = {
      uri         = "https://kv-example.vault.azure.net/"
      resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.KeyVault/vaults/kv-example"
    }
  }

  assert {
    condition = (
      length(azurerm_role_assignment.secret_operators) == 2 &&
      alltrue([for id, assignment in azurerm_role_assignment.secret_operators :
        assignment.scope == module.key_vault.resource_id &&
        assignment.role_definition_name == "Key Vault Secrets Officer" &&
        assignment.principal_type == "User" &&
        assignment.principal_id == id
      ]) &&
      toset(keys(azurerm_role_assignment.secret_operators)) == toset([
        "00000000-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
      ])
    )
    error_message = "Only the explicitly configured users may receive vault-scoped Secrets Officer grants."
  }

  assert {
    condition = alltrue([for name, assignment in azurerm_role_assignment.secret_readers :
      assignment.scope == "${module.key_vault.resource_id}/secrets/${name}" &&
      assignment.role_definition_name == "Key Vault Secrets User" &&
      assignment.principal_type == "ServicePrincipal"
    ])
    error_message = "Runtime identities must retain only per-secret Secrets User grants."
  }
}

run "enterprise_existing_resources" {
  command = plan

  variables {
    existing_resource_group_name = "rg-example-enterprise"
    existing_sql = {
      server_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Sql/servers/sql-example"
      database_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Sql/servers/sql-example/databases/portal"
    }
    sql_admin                        = null
    private_endpoints_enabled        = false
    key_vault_allowed_ipv4_addresses = ["198.51.100.12"]
    network = {
      mode = "existing"
    }
  }

  assert {
    condition = alltrue([
      contains(output.secret_names, "auth-secret"),
      contains(output.secret_names, "auth-microsoft-entra-id-secret"),
      contains(output.secret_names, "auth-github-secret"),
      local.ingestion_app_settings.GITHUB_APP_ID == "123456",
      !contains(keys(local.ingestion_app_settings), "BACKFILL_FROM"),
      output.directory_runtime.sql_database_name == "portal",
      local.key_vault_network_acls.ip_rules == ["198.51.100.12/32"],
    ])
    error_message = "Existing-resource plans must preserve portal secrets while referencing the new-solution database and separate directory host storage."
  }
}

run "private_endpoint_keeps_public_key_vault_access_disabled" {
  command = plan

  variables {
    private_endpoints_enabled        = true
    key_vault_allowed_ipv4_addresses = []
    network = {
      mode      = "existing"
      subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Network/virtualNetworks/vnet-example/subnets/private-endpoints"
    }
  }

  assert {
    condition = alltrue([
      !local.key_vault_public_network_access_enabled,
      local.key_vault_network_acls == {
        bypass                     = "None"
        default_action             = "Deny"
        ip_rules                   = []
        virtual_network_subnet_ids = []
      },
    ])
    error_message = "Private-endpoint environments must keep public Key Vault access disabled and the firewall deny-by-default."
  }
}

run "optional_metrics_backfill" {
  command = plan

  variables {
    backfill_from = "2025-10-10"
  }

  assert {
    condition     = local.ingestion_app_settings.BACKFILL_FROM == "2025-10-10"
    error_message = "A configured backfill date must be set only on the metrics ingestion app."
  }
}

run "optional_module_secret_ownership" {
  command = plan

  variables {
    modules = {
      ai_credits    = true
      budget_lookup = true
      feedback      = false
    }
  }

  assert {
    condition = alltrue([
      local.secret_identity_by_name["ai-credits-token"] == "ingestion",
      local.secret_identity_by_name["budget-lookup-key"] == "portal",
      local.secret_identity_by_name["github-directory-pat"] == "directory",
    ])
    error_message = "Optional module secrets must be granted only to the module's owning component identity."
  }
}

run "directory_runtime_cannot_be_enabled_by_tfvars" {
  command = plan

  assert {
    condition = alltrue([
      local.directory_platform_state.enabled == false,
      local.directory_platform_state.scm_site_also_stopped == true,
      nonsensitive(module.directory.resource).body.properties.enabled == false,
      nonsensitive(module.directory.resource).body.properties.scmSiteAlsoStopped == true,
    ])
    error_message = "The actual planned ARM body must keep the directory Function disabled and its SCM site stopped; no Terraform input may activate it."
  }
}

run "trusted_forwarding_ingress_enabled" {
  command = plan

  variables {
    auth_trust_host            = true
    trusted_forwarding_ingress = true
  }

  assert {
    condition     = try(local.portal_auth_trust_host_setting.AUTH_TRUST_HOST, "") == "true"
    error_message = "Auth.js host trust must be enabled only with an explicit trusted-ingress assertion."
  }
}

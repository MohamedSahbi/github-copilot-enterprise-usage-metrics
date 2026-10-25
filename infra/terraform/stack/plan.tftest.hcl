mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example"
    }
  }

  mock_data "azurerm_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000000"
    }
  }
  mock_data "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example"
    }
  }

  mock_data "azurerm_key_vault_secrets" {
    defaults = {
      names = [
        "github-oauth-client-secret",
        "auth-secret",
        "auth-microsoft-entra-id-secret",
        "auth-github-secret",
        "github-app-private-key",
        "github-directory-pat",
        "ai-credits-token",
        "budget-lookup-key",
      ]
    }
  }
}
mock_provider "azapi" {}

run "demo_example" {
  command = plan

  assert {
    condition = alltrue([
      contains(output.secret_names, "auth-secret"),
      contains(output.secret_names, "auth-microsoft-entra-id-secret"),
      contains(output.secret_names, "auth-github-secret"),
      contains(output.secret_names, "github-directory-pat"),
    ])
    error_message = "The portal sign-in secret names must be included in secret_names."
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
      contains(keys(local.directory_app_settings), "GITHUB_DIRECTORY_PAT"),
      local.directory_app_settings.SQL_DATABASE == local.sql_database_name,
      contains(keys(local.directory_app_settings), "SQL_SERVER"),
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
}

run "enterprise_existing_resources" {
  command = plan

  variables {
    existing_resource_group_name = "rg-example-enterprise"
    existing_sql = {
      server_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Sql/servers/sql-example"
      database_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Sql/servers/sql-example/databases/portal"
    }
    sql_admin                 = null
    private_endpoints_enabled = false
    network = {
      mode = "existing"
    }
  }

  assert {
    condition = alltrue([
      contains(output.secret_names, "auth-secret"),
      contains(output.secret_names, "auth-microsoft-entra-id-secret"),
      contains(output.secret_names, "auth-github-secret"),
      output.directory_runtime.sql_database_name == "portal",
    ])
    error_message = "Existing-resource plans must preserve portal secrets while referencing the new-solution database and separate directory host storage."
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

run "missing_secret_names_fail" {
  command = plan

  variables {
    existing_resource_group_name = "rg-example-enterprise"
    private_endpoints_enabled    = false
    network = {
      mode = "existing"
    }
  }

  override_data {
    target = data.azurerm_key_vault_secrets.existing
    values = {
      names = ["github-oauth-client-secret"]
    }
  }

  expect_failures = [terraform_data.required_key_vault_secrets]
}

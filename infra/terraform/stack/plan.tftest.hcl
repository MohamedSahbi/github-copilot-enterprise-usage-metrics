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
      "github-directory-pat"           = "ingestion"
    }
    error_message = "Each default Key Vault secret must be granted only to its owning component identity."
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
    ])
    error_message = "The portal sign-in secret names must be included in secret_names."
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
    ])
    error_message = "Optional module secrets must be granted only to the module's owning component identity."
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

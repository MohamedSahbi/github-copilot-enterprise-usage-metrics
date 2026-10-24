# One action group with an email receiver per address (D-50). Alert rules arrive with the code that emits the signals.
module "action_group" {
  count   = length(var.alert_emails) > 0 ? 1 : 0
  source  = "Azure/avm-res-insights-actiongroup/azurerm"
  version = "0.1.0"

  name       = "ag-${local.name}"
  location   = "global"
  parent_id  = local.resource_group_id
  short_name = substr("cmp${var.environment}", 0, 12)
  tags       = local.tags

  email_receivers = {
    for i, address in var.alert_emails : "email${i}" => {
      name                    = "email${i}"
      email_address           = address
      use_common_alert_schema = true
    }
  }

  enable_telemetry = false
}

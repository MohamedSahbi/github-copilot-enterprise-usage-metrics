# Runbook: live Budget Lookup check

`npm run budget:probe` runs the same read-only GETs as the Budget Lookup page for one
GitHub login and prints what came back. Use it once against the real enterprise before
turning `modules.budget_lookup` on, and again if the page shows "invalid or incomplete data".

It never writes to GitHub, SQL or Key Vault. It makes the same two calls as the original
`Lookup-BudgetCostCenter` function: `GET /enterprises/{enterprise}/settings/billing/budgets?user=<login>&per_page=1`
for the effective budget and its spend, then `GET .../budgets/{id}` for that budget.

## Prerequisites

- The `budget-lookup-key` value: a classic PAT with `manage_billing:enterprise`, owned by an
  enterprise owner or billing manager. Fine-grained PATs and GitHub App tokens are not accepted
  for enterprise budget endpoints.
- Your enterprise slug.
- A test login that has an individual AI-credit budget, and ideally a second one that only has
  the default per-user budget.

## Run

```sh
read -rs BUDGET_LOOKUP_KEY && export BUDGET_LOOKUP_KEY
ENTERPRISE_SLUG=<slug> npm run budget:probe -- <github-login>
unset BUDGET_LOOKUP_KEY
```

The output has two parts:

- `pages`: for each request, the HTTP status and field names. For the budget by ID, also its
  `budget_type`, `budget_product_sku` and `budget_scope`. No amounts and no other users' logins.
- `result`: the mapped Budget Lookup data for that login (exit code 0), or the error code the
  page would show (exit code 1).

## What to check

| Check | Expected | If not |
| --- | --- | --- |
| Status on both requests | 200 | 401/403: token type, scope or owner role is wrong |
| `effectiveBudgetFields` | `budget_amount`, `consumed_amount`, `id` | `null` means GitHub applies no budget to that login |
| Budget by ID | `budget_type: "BundlePricing"`, `budget_product_sku: "ai_credits"`, `budget_scope: "user"` (or `multi_user_customer` for a login on the default) | The page shows the budget as outside what it supports |
| `result.data.budgets[0].consumedAmount` | `reported` | Spend shows as not reported |

Save the output (it has no secrets) with the PR or issue that records the check. If a row
does not match, the client in `portal/src/budget/` needs a fix before the module is turned on.

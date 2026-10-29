# Runbook: live Budget Lookup check

`npm run budget:probe` runs the same read-only GETs as the Budget Lookup page for one
GitHub login and prints what came back. Use it once against the real enterprise before
turning `modules.budget_lookup` on, and again if the page shows "invalid or incomplete data".

It never writes to GitHub, SQL or Key Vault. It only calls
`GET /enterprises/{enterprise}/settings/billing/budgets` three times (`scope=user`,
`scope=multi_user_customer`, then unscoped), each with `user=<login>`.

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

- `pages`: for each request, the HTTP status, the top-level field names, and for each budget its
  `budget_type`, `budget_product_sku`, `budget_scope` and whether `user`, `consumed_amount` and
  the plural `budget_product_skus` are present. No amounts and no other users' logins.
- `result`: the mapped Budget Lookup data for that login (exit code 0), or the error code the
  page would show (exit code 1).

## What to check

The portal relies on the response schema in GitHub's REST docs (API version `2026-03-10`). The
docs' example response is narrower than that schema, so confirm:

| Check | Expected | If not |
| --- | --- | --- |
| Status on all three pages | 200 | 401/403: token type, scope or owner role is wrong |
| AI-credit budgets | `budget_type: "BundlePricing"`, `budget_product_sku: "ai_credits"`, no `budget_product_skus` | The budget is skipped and the page shows no budgets |
| `scope=user` budgets | `has_user: true` | Lookup fails with "omitted target-user identity" |
| Unscoped page | `hasTopLevelUser: true`, `topLevelUserMatches: true` | Lookup fails with "mismatched user identity" |
| `hasEffectiveBudget` | true when the login has a budget | The page shows the effective budget as not reported |
| `has_consumed_amount` | true | Consumed amount shows as not reported |

Save the output (it has no secrets) with the PR or issue that records the check. If a row
does not match, the client in `portal/src/budget/` needs a fix before the module is turned on.

# Prerequisites (owner only)

Agents cannot do these. Complete them before assigning Phase 1 tasks. Record IDs and names in the private deployment note, not in the public repository.

## Azure

- [ ] Subscription and resource groups for dev, test, prod
- [ ] Storage account and container for Terraform state (bootstrap)
- [ ] Federated credentials (OIDC) for GitHub Actions per environment; Azure DevOps service connection if Azure Pipelines is used
- [ ] Decide `existing` vs `create` for network, private DNS zones, SQL server and database, Log Analytics, Application Insights; collect existing resource IDs
- [ ] Azure budget owner and `alert_emails` list (users, team mailbox, or distribution list)

## Entra ID

- [ ] App registration for portal sign-in (redirect URIs per environment)
- [ ] Graph application permission `User.Read.All` for the directory sync identity, with **admin consent**
- [ ] Break-glass Entra group for admin and health access when SQL is unavailable
- [ ] Groups or users for initial admin access

## GitHub (enterprise / organization)

- [ ] Create the GitHub App for ingestion; install on the enterprise/organization with read access to enterprise billing and organization Copilot metrics; store App ID and private key in Key Vault
- [ ] Create the classic PAT for the directory sync (`read:org`, `admin:enterprise`), owned by an enterprise owner account; store in Key Vault; note its expiry date
- [ ] OAuth app (or GitHub App user authorization) for portal GitHub sign-in
- [ ] "Copilot usage metrics" policy enabled for the enterprise
- [ ] Budgets for Copilot (AI Credits) and Actions minutes used by agents

## GitHub (new public repository)

- [ ] Repository created; Copilot coding agent enabled
- [ ] Branch protection on `main`: PR required, CODEOWNERS review, required status checks
- [ ] Secret scanning, push protection, private vulnerability reporting enabled
- [ ] Actions secret `PRIVATE_TERMS_DENYLIST` with organization-specific terms (one per line)
- [ ] GitHub App token for release-please stored as Actions secrets
- [ ] Coding agent network allowlist: container registry for SQL Server (`mcr.microsoft.com`) and the Playwright browser download host, if not allowed by default
- [ ] Labels: `task`, `ready-for-agent`, `area:*`, `bug`, `triage`, `found-by-agent`, `severity:high|medium|low`, `metric-change`

## Before cut-over

- [ ] Restore test done and recorded
- [ ] Credentials valid for at least 30 days
- [ ] Alert emails confirmed receiving test alerts

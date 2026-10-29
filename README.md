# github-copilot-enterprise-usage-metrics

Single-tenant-per-deployment portal for GitHub Copilot usage analytics on Azure (MIT). The design is in [docs/architecture/decision-record.md](docs/architecture/decision-record.md); agent rules are in [.github/copilot-instructions.md](.github/copilot-instructions.md).

See the [portal FAQ](docs/portal-faq.md) for usage-period and privacy behavior.

## Status: alpha (0.2.x)

The alpha is a restricted private release. What ships today:

- **Portal pages.** Overview and Copilot Impact, rendered on the server as daily
  aggregate tables, for the scopes the viewer is granted (company,
  reports, self, or an exact department or business area). Groups under 5 users
  are suppressed. The usage JSON APIs and user-detail routes return 404. See the
  [Safe Alpha runbook](docs/runbooks/safe-alpha.md) for the release boundary.
- **Access.** Entra and GitHub sign-in, direct grants only (navigation and feature
  flags never grant access), admin access and audit pages, and soft revocation of
  grants when Entra disables an account.
- **Metrics ingestion.** A GitHub App reads the enterprise Copilot usage metrics
  into a raw blob archive and curated SQL facts, with optional backfill.
- **Directory sync.** Entra users, managers and departments into SQL.
- **Infrastructure.** One Terraform root per environment
  ([infra/terraform](infra/terraform/README.md)) and Azure DevOps pipelines
  ([pipelines/azure](pipelines/azure)).

Built but **off by default**, each behind its own switch in
[terraform.tfvars.example](infra/terraform/stack/terraform.tfvars.example):

| Switch | What it turns on | Turn it on when |
| --- | --- | --- |
| `metrics_sync_enabled` | The scheduled metrics fetch | The App-token check (#64) and the restore and SQL permission gates (#55, #56) have passed |
| `directory_sync_enabled` | The directory Function App and its deploy site | `github-directory-pat` holds a real PAT in Key Vault and the directory SQL user is mapped (#56) |
| `modules.upstream_views` | Every upstream dashboard view, built from SQL | The owner accepts whole-scope suppression instead of the Safe Alpha restriction (#115, #143) |
| `per_user_detail_enabled` | Logins, Users and User Details | Per-user detail is approved for the environment |

Not in the alpha: per-chart breakdown privacy for the extra views (#143) and the
manager-permission decision (#67). The Safe Alpha restriction does not complete
the broader #115 reporting scope.

## Deploy

1. Check the [prerequisites](docs/setup/prerequisites.md).
2. Copy `infra/terraform/stack/terraform.tfvars.example` to `terraform.tfvars` in your
   private deployment repository and fill it in. Every parameter is explained inline.
   Keep secrets in Key Vault, never in tfvars.
3. Plan and apply, then create the secrets listed by the `secret_names` output.
4. Turn on the switches above one at a time, after their gates pass.

## Getting started

```sh
git clone --recurse-submodules <repo-url>   # or: git submodule update --init
nvm use                                     # Node 22
npm ci
npx playwright install chromium
npm run build && npm run test:e2e           # the same steps CI runs: npm run ci
npm run dev -w portal                       # http://localhost:3000
```

Deployed smoke tests (unauthenticated paths and `/api/health` only): `BASE_URL=https://<environment-url> npm run test:smoke`. With `BASE_URL` set, only `e2e/smoke` runs and no local server is started.

## Local stack

Needs Docker. One command brings up SQL Server 2022 and Azurite (loopback only, throwaway data), applies `db/migrations` through the migration runner and loads the synthetic fixtures from `fixtures/` into the staging tables:

```sh
npm run stack:up      # first start pulls images; SQL Server takes 1-2 minutes on Apple Silicon
npm run stack:down    # stops the containers and deletes their data
npm run db:fixtures   # reload the fixtures into a running stack
npm run db:migrate    # run the migration runner against SQL_CONNECTION_STRING
npm run test:integration   # integration tests against the running stack (not part of `npm test`)
```

SQL Server has no arm64 image, so the stack runs it as `linux/amd64`; Docker Desktop emulates it on Apple Silicon (enable "Use Rosetta" for speed). Defaults: SQL on `127.0.0.1:14330`, database `portal_local`, Azurite on `10000-10002`. Override with `LOCAL_SQL_PORT` and `LOCAL_SQL_SA_PASSWORD`. The fixture loader refuses any non-local host. See [docs/runbooks](docs/runbooks/README.md) for migrations.

`portal/upstream/` is a pinned git submodule and is never edited (D-14). See [docs/architecture/poc-submodule.md](docs/architecture/poc-submodule.md).

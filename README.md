# github-copilot-enterprise-usage-metrics

Single-tenant-per-deployment portal for GitHub Copilot usage analytics on Azure (MIT). The design is in [docs/architecture/decision-record.md](docs/architecture/decision-record.md); agent rules are in [.github/copilot-instructions.md](.github/copilot-instructions.md).

Status: Phase 1 skeleton. No business features yet.

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
```

SQL Server has no arm64 image, so the stack runs it as `linux/amd64`; Docker Desktop emulates it on Apple Silicon (enable "Use Rosetta" for speed). Defaults: SQL on `127.0.0.1:14330`, database `portal_local`, Azurite on `10000-10002`. Override with `LOCAL_SQL_PORT` and `LOCAL_SQL_SA_PASSWORD`. The fixture loader refuses any non-local host. See [docs/runbooks](docs/runbooks/README.md) for migrations.

`portal/upstream/` is a pinned git submodule and is never edited (D-14). See [docs/architecture/poc-submodule.md](docs/architecture/poc-submodule.md).

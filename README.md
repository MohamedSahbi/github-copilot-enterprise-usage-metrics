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

`portal/upstream/` is a pinned git submodule and is never edited (D-14). See [docs/architecture/poc-submodule.md](docs/architecture/poc-submodule.md).

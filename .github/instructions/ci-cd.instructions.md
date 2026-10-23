---
description: "Use when editing GitHub Actions workflows, Azure Pipelines templates, Dependabot, release-please, or scripts used by CI."
applyTo: ".github/workflows/**,.github/dependabot.yml,pipelines/**,scripts/**,release-please-config.json"
---

# CI/CD (D-20, D-21, D-26, D-27)

- All logic lives in `scripts/` or npm scripts. Workflow and pipeline files only call them, so GitHub Actions and Azure Pipelines stay identical in behaviour.
- GitHub Actions is primary and tested end to end; Azure Pipelines templates are "provided, community-tested".
- Azure authentication uses OIDC; no long-lived credentials in workflow files.
- Dependabot `gitsubmodule` bumps `portal/upstream` weekly with commit prefix `fix(deps):`.
- On bump PRs, a step posts the upstream compare link and changed-file summary as a PR comment.
- A check fails any PR that changes files inside `portal/upstream/` other than the pinned commit.
- release-please runs with a GitHub App token (tags created with `GITHUB_TOKEN` do not trigger workflows) and appends the pinned upstream commit to release notes.
- Agent and Dependabot runs get no deployment secrets; tests use fixtures.
- Pin third-party actions to a full commit SHA.
- PR pipeline order: lint → typecheck → unit/contract → integration (SQL Server container + Azurite) → build → Playwright E2E (upload screenshots and traces as artifacts) → Terraform plan when `infra/` changes.
- Deploy pipeline: migrate → deploy → smoke tests → promote only if smoke passes.
- A check fails if `E2E_TEST_AUTH` appears in any Terraform, app setting, or deployment configuration.
- A check fails if any term from the Actions secret `PRIVATE_TERMS_DENYLIST` appears in the diff. Never write the terms into the repository or logs.
- `copilot-setup-steps.yml` checks out submodules, runs `npm ci`, and installs Playwright browsers so the coding agent can run and verify the app.

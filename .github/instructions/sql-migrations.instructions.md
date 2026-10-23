---
description: "Use when adding or changing SQL schema, migrations, views, indexes, or table ownership."
applyTo: "db/**"
---

# SQL migrations (D-34)

- Migrations are forward-only, named `yyyyMMddHHmmss_description.sql` (UTC timestamp) so parallel PRs never collide, and idempotent where possible. Never edit a migration that has been merged; add a new one.
- The app never runs DDL at startup. Migrations run from `scripts/` in the deployment pipeline.
- Portal-owned tables go in the `portal` schema. Do not create or alter `dbo` budget or cost-center tables; they belong to the PowerShell Function App.
- `CopilotUserDirectory` and `ManagerHierarchy` keep their documented column contract. Any change to those columns needs a contract-test update and a note in the PR for the budget Functions' owner.
- Every module's tables are always created; module flags never change schema.
- Each table has exactly one writer; record the writer in a comment at the top of its migration.
- Add indexes for the query shape (organization + date range + user key) and justify new ones in the PR.
- The portal writes only `portal.AuditLog`; `dbo.AuditLog` belongs to the budget Function App.
- Data migrations from the legacy portal tables (decision record §15.1) are separate scripts with a reconciliation query; they never drop source data.

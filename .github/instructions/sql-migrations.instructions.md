---
description: "Use when adding or changing SQL schema, migrations, views, indexes, or table ownership."
applyTo: "db/**"
---

# SQL migrations (D-34)

- Migrations are forward-only, named `yyyyMMddHHmmss.do.description.sql` (UTC timestamp; the `.do.` form is the postgrator runner's forward-only naming) so parallel PRs never collide, and idempotent where possible. Never edit a migration that has been merged; add a new one.
- The app never runs DDL at startup. Migrations run from `scripts/` in the deployment pipeline.
- Portal-owned tables go in the `portal` schema in a database separate from the old solution. Do not create or alter old `dbo` directory, hierarchy, audit, budget or cost-center tables.
- Reuse the approved numeric-ID directory model (`dim_user`, manager-ID attributes, link/revocation and sync state). Do not add compatibility shadows of `CopilotUserDirectory`, `ManagerHierarchy` or `HierarchySyncRun` for old consumers. Historical v1/v2 budget descriptors are references, not the new runtime schema; any shared contract delta needs its own PR before dependent migration work (D-47).
- Every module's tables are always created; module flags never change schema.
- Each table has exactly one writer; record the writer in a comment at the top of its migration. One logical `ingestion` component owns `dim_user` and login history; directory sync owns directory attributes/hierarchy/link/revocation state through it, never portal-owned principal/grant rows.
- Add indexes for the query shape (organization + date range + user key) and justify new ones in the PR.
- The portal writes only `portal.AuditLog`; `dbo.AuditLog` belongs to the budget Function App.
- Data migration from legacy portal tables happens at the end (decision record §15.1), under a separately approved source-access/migration plan with reconciliation; never drop source data. No migration, source access, deployment or cutover is authorized by database separation. Restore/rollback, Azure SQL grants validation and existing maintenance-window gates remain.

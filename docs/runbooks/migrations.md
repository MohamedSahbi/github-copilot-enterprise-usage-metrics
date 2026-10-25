# Runbook: database migrations

Forward-only SQL for the `portal` schema (D-34, D-48). One runner, `scripts/db/migrate.ts`, built on postgrator. Files live in `db/migrations/` and are named `yyyyMMddHHmmss.do.description.sql` (UTC timestamp is the version). There are no down migrations: fix forward with a new file.

## What the runner does

1. Connects with `SQL_CONNECTION_STRING` (never printed) and takes `sp_getapplock('portal-migrations', Exclusive, Session)`. A second runner waits up to `MIGRATION_LOCK_TIMEOUT_MS` (default 60000), then fails with `LOCK_TIMEOUT`.
2. Creates the `portal` schema and `portal.schema_version` if they do not exist, never anything in `dbo`.
3. Checks every previously applied migration against its file (md5 of the LF-normalised content). A changed, missing or checksum-less file stops the run with `CHECKSUM_MISMATCH`, `FILE_MISSING` or `CHECKSUM_MISSING` before anything new is applied.
4. Applies pending files in version order, splitting each on `GO`. A pending file older than the newest applied one (two PRs merged out of timestamp order) is refused with `OUT_OF_ORDER` before anything is applied; give it a newer timestamp in a follow-up PR.
5. Records each file in `portal.schema_version` after it succeeds, then releases the lock.

A second run with nothing pending is a no-op. A failing file is not recorded; fix it by adding a new migration only if the file already merged, otherwise correct it in the PR.

## Rules for authors

- Never edit a merged migration. The checksum check will block every environment that already applied it.
- Idempotent statements (`IF OBJECT_ID(...) IS NULL`), `portal` schema only, header naming the single writer of each new table.
- The history row is written after the script, not in the same transaction. If the process dies in between, the file is applied but unrecorded; re-running is safe because migrations are idempotent.
- Keep files LF (`.gitattributes` enforces it for `db/migrations/*.sql`).

## Development

```sh
npm run stack:up      # SQL Server 2022 + Azurite, runner applied, fixtures loaded
npm run db:migrate    # after adding a migration, with SQL_CONNECTION_STRING set (see below)
npm run stack:down
```

Local connection string (throwaway credentials, loopback only; `stack:up` prints it with the password masked):
`SQL_CONNECTION_STRING="Server=127.0.0.1,14330;Database=portal_local;User Id=sa;Password=<LOCAL_SQL_SA_PASSWORD>;Encrypt=true;TrustServerCertificate=true" npm run db:migrate`

Tests: `npm run test:sql` runs the runner against a throwaway SQL Server 2022 container (applies all files, no-op rerun, tamper refusal, concurrency, lock timeout). `npm run test:integration` runs the integration tests against the running stack.

## Pipeline

Run the runner once per environment, before the app deploys, from a job that has the deployment identity and nothing else:

1. Resolve the connection string for that environment from Key Vault into the job's secret environment (not into a repository variable or a log).
2. `npm ci && npm run db:migrate`. Exit code 0 means applied or already up to date; 1 means failure (read the message; it never contains the connection string); 2 means bad input.
3. Run the grants step in [database-grants.md](database-grants.md).
4. Deploy the app and run smoke tests.

Do not run two pipelines against one database at once; the applock serialises them, but the second will fail with `LOCK_TIMEOUT` rather than queue indefinitely.

Authentication today is a connection string. The `mssql` driver also accepts Entra authentication options in the connection string; moving the pipeline to token-based sign-in is a follow-up.

## Restore plan

Migrations are not transactional. Before the first migration of a release on a database that holds data, take a point-in-time restore marker (note the UTC time) or copy the database. If a file fails half-way, the schema may be partly changed and the history has no row for it: since files are idempotent, fix forward and re-run; if the state is unusable, restore to the marker and re-run after the fix. Rollback, cut-over and restore runbooks (D-50) are still to be written.

## Failures

| Symptom | Meaning | Action |
| --- | --- | --- |
| `CHECKSUM_MISMATCH` | An applied file was edited | Revert the edit; add a new migration for the change |
| `FILE_MISSING` | An applied version has no file | Restore the file from history |
| `CHECKSUM_MISSING` | History row without checksum | Stop and ask the owner; do not patch the table by hand |
| `OUT_OF_ORDER` | A pending file is older than the newest applied one | Rename it with a newer timestamp (only if not yet applied anywhere), then re-run |
| `LOCK_TIMEOUT` | Another runner holds the lock | Wait for it to finish, then re-run |
| A migration fails | Nothing was recorded for it | Fix the cause, re-run; the earlier files stay applied |

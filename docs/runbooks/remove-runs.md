# Runbook: remove named ingestion runs (synthetic seed data)

`npm run data:remove-runs` removes metrics (`users_1_day`) or AI Credits (`ai_credit`) ingestion
runs that you name by run ID, plus everything that points at them: curated facts, aggregates,
staging rows, validation issues and their actions, audit events and source artifact rows. It is
meant for clearing synthetic seed data from a sandbox before importing real history. It never
touches directory runs, Blob storage or access grants.

## Gates

- Owner approval for the specific database and run IDs. This is a data-bearing delete.
- A recent restore point or backup of the database (see [restore and rollback](restore-rollback.md)).
- Pause the metrics timer while it runs if the runs share days with real data.

## Find the run IDs (read-only)

```sql
SELECT run_id, source_kind, scope_key, report_day, status, is_current, rows_loaded, started_at
FROM portal.IngestionRun
WHERE source_kind IN ('users_1_day', 'ai_credit')
ORDER BY started_at;
```

Synthetic runs are the ones that were not written by the metrics loader (for example, a fixed
seed run ID or a `SourceArtifact` path that does not exist in the raw archive).

## Run

The tool connects with `SQL_SERVER`, `SQL_DATABASE` and Azure default credentials (your `az login`
or `AZURE_CLIENT_ID`). The identity needs delete rights on the `portal` tables.

1. Dry run. It performs the deletes inside a transaction, prints the row counts and rolls back:

   ```sh
   npm run data:remove-runs -- --run-id <uuid> [--run-id <uuid> ...]
   ```

2. Execute with the fact-row count from the dry run. It commits only if the count still matches:

   ```sh
   npm run data:remove-runs -- --run-id <uuid> ... --execute --expect-fact-rows <n>
   ```

Optional `--user-id <id>` and `--organization-id <id>` also remove synthetic `dim_user` (with its
login history) and `dim_organization` rows, but only when no remaining facts use them. Any other
reference, such as an access grant or scope assignment, makes the delete fail and rolls back
everything. Output is counts only.

After removal, the affected days have no current run, so the metrics backfill fetches them again.

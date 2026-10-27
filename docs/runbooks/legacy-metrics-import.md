# Runbook: one-time legacy Copilot metrics import

This tool imports only existing raw Copilot users-1-day NDJSON blobs from a legacy Blob
container. It sends each day's bytes through the portal's existing `loadMetricsDay` pipeline,
which archives the bytes in the portal Blob container and validates, stages, and publishes the
day in the portal SQL database. It does not call GitHub or read the legacy SQL database.

The direct load is a one-time, owner-approved exception to D-28's raw-copy-then-replay decision.
The owner approved this tool calling `loadMetricsDay`; the decision record was not changed.
Enhanced blobs are ignored. The source blobs are read only and never deleted or rewritten.

## Required gates and access

Do not run `--execute` until all of these are true:

- The separate Functions consumer change has switched `loadMetricsDay` to
  `portal.usp_write_metrics_users` and has been merged and deployed to the version used for
  the import. `portal_metrics_ingest` intentionally cannot perform the current loader's direct
  `dim_user` writes before that consumer switch.
- The operator has confirmed the managed identity's effective SQL permissions on the target
  Azure SQL database. Map the identity to `portal_metrics_ingest` only. **Never map it to
  `portal_ingest`**, `db_owner`, or any other ingestion component role. Follow the
  [database users and grants runbook](database-grants.md), including the effective-permission
  preflight.
- The managed identity has `Storage Blob Data Reader` scoped to the legacy source container,
  and `Storage Blob Data Contributor` scoped to the portal's destination archive container.
  Do not grant storage account-wide access when container-scoped access is available.
- The target portal database is the new, separate database. Confirm the organization ID and
  login supplied at runtime match the target deployment; do not put those values in this
  public repository.

Dry-run mode also reads the current published day from SQL and checks the corresponding
destination blob metadata for its SHA-256. It therefore needs source-container read access,
destination-archive read access, and SQL read access to `portal.IngestionRun`, even though it
does not write anything.

## Run

Use Node 22 and install the repository's locked dependencies with `npm ci`. All values below
are examples/placeholders: replace them in the shell invocation, not in this runbook or a
committed config file. The account URLs must be HTTPS origins. The managed identity client ID,
not its secret, is supplied to pin Azure authentication to the intended identity.

Start with the dry run:

```sh
npm run import:legacy-metrics -- \
  --source-account-url https://<legacy-storage-account>.blob.core.windows.net \
  --source-container usage-metrics-reports \
  --archive-account-url https://<portal-storage-account>.blob.core.windows.net \
  --archive-container <portal-raw-container> \
  --sql-server <portal-sql-server>.database.windows.net \
  --sql-database <portal-database> \
  --managed-identity-client-id <managed-identity-client-id> \
  --organization-id <numeric-organization-id> \
  --organization-login <organization-login> \
  --from 2025-01-01 \
  --to 2025-01-31 \
  --dry-run
```

The date range is inclusive. A dry run lists only `YYYY/MM/raw/` paths in the requested
months, validates the legacy filename `UsageMetrics-dd-MM-yyyy.json`, downloads and hashes
the candidate raw files, and reports `would-import` or `skipped`. A day is skipped only when
the current published run's archive metadata contains the same digest. The tool does not write
to SQL or the destination container in dry-run mode.

Review the candidate days and outcomes. If a day is missing from the source, it will not be
imported; verify expected coverage against authorized evidence before proceeding. Malformed
raw blob names, multiple distinct blobs for one day, access errors, and loader quarantine are
errors and must be investigated. A partial failure stops the range; rerun after resolving it.

When approved to load, repeat the same command with `--execute` instead of `--dry-run`:

```sh
npm run import:legacy-metrics -- <same runtime options> --execute
```

The loader uses a per-day SQL application lock. Re-running the command is safe: a matching
current published digest is skipped; changed source bytes are reprocessed through the normal
day loader. The loader's smaller-day guard and quarantine behavior remain in force.

Do not run against production unless the deployment's separate data-bearing-operation,
restore, source-access, and maintenance-window approvals have been completed. This runbook
does not authorize deployment, migration, cut-over, or decommissioning.

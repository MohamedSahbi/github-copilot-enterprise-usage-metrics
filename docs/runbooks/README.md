# docs/runbooks

Deploy, rollback, cut-over, credential rotation, restore, backfill, and incident triage (D-50).

- [Database migrations](migrations.md): running the forward-only runner in development and from the pipeline.
- [Restore and rollback](restore-rollback.md): pre-change markers, Azure SQL and raw archive recovery, bad legacy import recovery, and quarterly restore evidence. **Data-bearing deployment is gated on review and an exercised non-production restore; #55 remains open pending private operator evidence.**
- [Phase 2 parallel run](parallel-run.md): separate-database boundaries, deployment gates, evidence, reconciliation cadence and the exit criterion.
- [Cut-over and rollback gates](cutover.md): D-49 go/no-go checks, separately authorized final migration and traffic switch, and irreversible/data-loss boundaries.
- [Database users and grants](database-grants.md): `CREATE USER ... WITH SID, TYPE = E` and the rule that runtime identities never get `db_owner`.
- [Directory runtime identity boundary](directory-runtime-identity.md): approved target separation, current source-configuration gap, and verified Graph permission prerequisites.
- [Directory failure recovery and retry](../../functions/README.md#directory-failure-recovery-and-retry): durable per-user negative evidence, atomic profile publication and ordered fresh-snapshot retries.
- [One-time legacy metrics import](legacy-metrics-import.md): operator-run import of raw legacy Blob reports through the existing day loader.
- [Remove ingestion runs](remove-runs.md): operator-run removal of named metrics runs, such as synthetic seed data, dry run first.
- [Import metrics history](metrics-history-import.md): per-day metrics status, synthetic-run removal and `BACKFILL_FROM`, all from the pipeline.
- [Safe Alpha release surface](safe-alpha.md): released server-rendered pages, denied endpoints, scope restrictions, and synthetic verification.

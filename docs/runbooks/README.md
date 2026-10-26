# docs/runbooks

Deploy, rollback, cut-over, credential rotation, restore, backfill, and incident triage (D-50).

- [Database migrations](migrations.md): running the forward-only runner in development and from the pipeline.
- [Database users and grants](database-grants.md): `CREATE USER ... WITH SID, TYPE = E` and the rule that runtime identities never get `db_owner`.
- [Directory runtime identity boundary](directory-runtime-identity.md): approved target separation, current source-configuration gap, and verified Graph permission prerequisites.
- [Safe Alpha release surface](safe-alpha.md): released server-rendered pages, denied endpoints, scope restrictions, and synthetic verification.

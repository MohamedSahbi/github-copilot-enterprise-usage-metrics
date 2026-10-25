---
name: azure-sql-design
description: 'Design and review Azure SQL / SQL Server tables, indexes, migrations and T-SQL for the portal schema. Use before writing or reviewing anything in db/migrations, a shared SQL contract, or a query: key sizes, collation, implicit conversions, safe live alterations, idempotent re-runs, NULL pitfalls.'
---

# Azure SQL design and T-SQL correctness

Condensed from Microsoft's `design-azure-sql-schema`, `schema-migrations-safely` and `t-sql-correctness` skills (microsoft/microsoft-sql, found via Agent Finder) plus the sql-migrations instructions. The repository rules win on conflict: portal schema only, single writer per table (D-34), forward-only migrations, no `dbo` changes.

## Schema (costs arrive later, in production)

- Index key budget is in bytes: 1700 nonclustered, 900 clustered, summed over a composite key. `NVARCHAR(n)` costs 2n, so safe maxima are `NVARCHAR(850)` nonclustered and `NVARCHAR(450)` clustered. Exceeding it is only a warning at DDL time and fails on the first long row. `INCLUDE` columns do not count. `MAX`, `json` and `vector` cannot be keys.
- Foreign key columns must match the parent column's type, length and collation.
- Collation is fixed at `CREATE DATABASE`; the default is case-insensitive SQL collation. Case-significant identifiers (tokens, hashes) need a `_CS_` collation per column; hashes stored as hex should be `CHAR(64)` with a binary or CS collation.
- Drivers bind strings as NVARCHAR. Comparing that to a `VARCHAR` column under a SQL collation converts the column and turns a seek into a scan. Prefer `NVARCHAR` for text columns that are looked up, or a Windows collation.
- A UNIQUE constraint accepts exactly one NULL; use a filtered unique index (`WHERE col IS NOT NULL`) when NULLs repeat.
- `IDENTITY` leaves gaps (restart, rollback); never rely on it being contiguous.
- Use `DATETIME2`, `DECIMAL(p,s)` for money and credits, `BIT` for flags; name constraints explicitly so later migrations can drop them.
- Index for the access path: organization + date range + user key; keep per-user rows and aggregates in separate tables with separate retention.

## Migrations on a live database

- Metadata-only (cheap): add nullable column; add NOT NULL column with a runtime-constant default; widen a varchar (not to MAX); `ADD CONSTRAINT ... WITH NOCHECK`; drop column.
- Rewrites every row (log-heavy, long Sch-M lock): `NEWID()`/`NEWSEQUENTIALID()` default, int→bigint, varchar→nvarchar, varchar→MAX, NULL→NOT NULL, anything crossing 8,060 bytes per row.
- Every `ALTER TABLE` takes a schema-modification lock that blocks all readers, including snapshot and NOLOCK, and queued behind a long query it blocks everything after it. Use `WITH (ONLINE = ON)` where supported, set `LOCK_TIMEOUT` on migrations, and run them outside the reporting window.
- Prefer expand → backfill in batches → contract across separate migrations; never edit an applied migration.
- A guard (`IF OBJECT_ID(...) IS NULL`) protects one statement, not concurrent runners or retried backfills. Serialise runners with `sp_getapplock` (`portal-migrations`) and make backfills keyed and repeatable.
- Migrations should be idempotent and re-runnable; verify by applying twice against a SQL Server 2022 container.

## T-SQL correctness

- `= NULL` and `<> value` drop NULL rows; use `IS NULL`, `IS NOT DISTINCT FROM`, or `NOT EXISTS` instead of `NOT IN` over a nullable column (it returns nothing).
- Aggregates skip NULLs silently (`AVG` divides by non-null count).
- Integer division truncates; cast to `DECIMAL` first. `ISNULL` takes the type of its first argument (truncates), `COALESCE` the highest-precedence type.
- Always give a length: `NVARCHAR` with none is 1 character in a declaration.
- Pagination is `ORDER BY ... OFFSET n ROWS FETCH NEXT m ROWS ONLY`; `RETURNING` is `OUTPUT INSERTED.x`; no `LIMIT`, `ILIKE`, `NOW()`, `ON CONFLICT`, `SERIAL`.
- Run scripts with `sqlcmd -I` so `QUOTED_IDENTIFIER` is ON.
- Upserts: `MERGE` has known concurrency pitfalls; prefer `UPDATE` then `INSERT` inside a transaction with `UPDLOCK, HOLDLOCK`.

## Permissions and operations

- Runtime identities are least privilege (`db_datareader`-style roles per schema, never `db_owner`); create Entra users with `CREATE USER ... WITH SID = ..., TYPE = E`.
- Parameterise every query; never concatenate user input into SQL.
- Check plans for scans on the date-range queries and confirm row estimates before adding indexes.

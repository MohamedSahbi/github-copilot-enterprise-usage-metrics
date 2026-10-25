# Migrations

Forward-only SQL for the `portal` schema (D-34). Runner: postgrator (D-48 naming updated by the owner); never edit a merged file.

- Name: `yyyyMMddHHmmss.do.description.sql` (UTC timestamp is the version).
- Every file starts with a header naming the single writer of each table it creates.
- Idempotent (`IF OBJECT_ID(...) IS NULL`), `portal` schema only, never `dbo`.
- Runtime grants use roles; users are created by the pipeline with `CREATE USER ... WITH SID, TYPE = E`.

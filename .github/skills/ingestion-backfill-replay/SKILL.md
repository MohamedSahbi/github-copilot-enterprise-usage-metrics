---
name: ingestion-backfill-replay
description: 'Backfill, import, replay, or reconcile Copilot usage metrics and AI Credits data. Use when loading historical days, importing existing raw NDJSON files, re-running a day, or comparing results with the legacy runbooks.'
---

# Backfill, import, and replay (D-23, D-28)

## Backfill from the API

1. Set `backfill_from` (clamped to the last 365 days; the API starts at 2025-10-10).
2. The timer Function processes one day at a time, oldest first, under a per-day `sp_getapplock`.
3. Each day is landed raw, validated, staged, and replaced in curated only if it is complete and not smaller than the stored day.

## Import existing files

1. Run the importer against the existing container (for example `usage-metrics-reports`). It copies **raw** NDJSON only into `raw/{source}/{org}/{yyyy}/{mm}/{dd}/`; enhanced files are ignored.
2. Trigger replay for the imported date range.

## Replay

- Replay re-reads the raw archive for a date range and runs the normal pipeline. Use it after parser or definition changes.

## Reconcile (parallel run)

1. Keep the two solutions independent, with separate databases (D-29, D-34); never add compatibility shadow tables or a runtime old-database comparison identity.
2. For each day, compare per-user and total counts between explicitly authorized legacy evidence and new SQL. Use synthetic fixtures locally; source access is not implied.
3. Produce a report: provenance, coverage, matching days, mismatching days with differences, missing days and unavailable evidence. Missing evidence is incomplete, not a match; public evidence contains sanitized counts/conclusions only.
4. No unexplained differences is a necessary acceptance criterion, not cut-over permission. Final data migration happens at the end under a separately approved plan; decommission follows new-solution acceptance and explicit authorization. Restore/rollback, Azure SQL grants and maintenance-window gates remain.

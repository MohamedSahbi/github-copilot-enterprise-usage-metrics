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

1. For each day, compare per-user and total counts between the legacy output and SQL.
2. Produce a report: matching days, mismatching days with differences, missing days.
3. Cut-over is allowed only when the report shows no unexplained differences.

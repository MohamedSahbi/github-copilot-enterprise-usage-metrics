# Runbook: Phase 2 parallel run

D-10, D-29, D-34, D-49 and D-50 (#80). The new metrics and directory pipeline
runs next to the old solution, each in its own database, until the results are
good enough for new-solution acceptance. This runbook says how to operate and
judge that run. It is **not authorization to deploy, read the old database,
import data, cut over or retire anything**.

## Boundaries

- **Separate databases.** The new solution writes only to its own database. The
  old solution and its database stay untouched: no compatibility shadow tables,
  no schema changes, and no runtime identity with access to both databases.
- **Comparison happens offline.** Results are compared against authorized
  evidence exports, never by a live query from the new solution to the old
  database. [Metrics reconciliation](metrics-reconciliation.md) reads only
  supplied local evidence files plus the new database and new archive.
- **Directory comparison** (current hierarchy and profiles against authorized
  legacy evidence) is the directory slice of #79 and follows the same rules.
- **Budget.** #43 is a deferred decision about the external Budget Functions, not
  a prerequisite for an independent Phase 2 run. Optional Budget Lookup stays as
  it is (live, read-only GitHub access, D-55); its read-source and access
  contract is still open and must not be assumed here.

## Gates before a data-bearing deployed run

A deployed run that holds real data is blocked until all of these clear:

1. #55: the [restore and rollback runbook](restore-rollback.md) is complete and
   reviewed, with an exercised non-production restore.
2. #56: non-production SQL users and grants are validated per
   [database users and grants](database-grants.md).
3. Directory sync, when part of the run, additionally follows #67 and #72
   ([directory runtime identity](directory-runtime-identity.md)).
4. A maintenance window is scheduled and recorded before the first deployment
   that contains migration `20261026001200` (AI Credits key/table rewrites).
5. The owner explicitly approves the run, its evidence location and its window.

Synthetic or local-stack runs need none of these and prove nothing about
acceptance.

## Evidence inputs

Only owner-authorized evidence counts: legacy report exports and hierarchy
snapshots the owner has approved for this purpose, each with a provenance label,
retrieval time and approval reference. Keep the evidence, configuration and
private outputs in the owner-approved private location described in
[metrics reconciliation](metrics-reconciliation.md#approval-and-configuration),
never in this repository. Retention follows that location's approved policy;
keep the evidence at least until acceptance is signed and any rollback window
has closed.

## Cadence

1. For every completed report day in the window, build a manifest from the
   authorized evidence and run the report mode of `npm run reconcile:metrics`.
2. Review the public summaries on the cadence the owner sets in the private
   plan. Investigate every unmatched, incomplete or unavailable day before the
   next review; do not let them accumulate.
3. Record each review in the private deployment record: date range, coverage,
   outcome per day and any follow-up issue.

## Exit criterion

The run passes only when every day in the agreed window is **matched or
explained**, with no unexplained differences, duplicates or missing periods, and
the directory comparison shows the same. Explained days stay visible for owner
review. Missing evidence, an unavailable day or an incomplete manifest is a
fail, never an acceptance by default. A passing run feeds the
[cut-over go/no-go review](cutover.md#gono-go-review); it does not approve it.

## Sample sanitized record

The public summary from `reconcile:metrics` is the only artifact that may leave
the private boundary. A review record built from it looks like this (synthetic
values):

| Field | Value |
| --- | --- |
| Window | 2026-01-05 to 2026-01-18 (14 report days) |
| Provenance | `legacy-export` label, retrieved 2026-01-19, approval reference kept private |
| Coverage | 14 of 14 days have evidence and a published run |
| Outcome | 13 matched, 1 explained (`quarantined_rejects`), 0 unmatched, 0 unavailable |
| Directory | Hierarchy comparison matched for the snapshot day |
| Limitations | Raw-byte load fidelity only, not chart-definition parity; per-user evidence not included |
| Result | Pass for this window, pending owner review of the explained day |

No organization names, IDs, user data, hashes or approval references appear in
the record.

## Afterwards

Final data migration happens at the end, into the new database, under a
separately approved migration, source-access and cut-over plan
([cut-over and rollback gates](cutover.md)). Decommissioning the old solution
needs new-solution acceptance and explicit owner authorization. Nothing in this
runbook grants production access, deployment, cut-over or decommissioning.

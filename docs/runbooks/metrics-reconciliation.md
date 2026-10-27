# Metrics reconciliation (metrics slice of #79)

`npm run reconcile:metrics -- --config /absolute/path/to/private-config.json`
is an operator-only tool, not a timer or portal endpoint. It implements
`shared/src/reconciliation.ts` and data-contracts §16. It verifies raw-byte load
fidelity, not legacy chart-definition parity. Directory comparison remains in #79.
No decision record change, old-system access, source extraction, SQL writes,
grants, deployment, cutover or retirement is authorized by running this tool.

## Approval and configuration

There is **no default or currently approved private evidence location**. Before
using real evidence, the owner must explicitly approve an existing private
directory and its access/retention policy. The operator supplies that directory
and an opaque approval reference at runtime. The tool does not create it or infer
approval from a path. It rejects repository-contained directories, symlink
destinations and group/other-accessible directories. Output files are created
exclusively with mode `0600`; existing files are never overwritten.

Keep configuration and manifests private and outside this repository. Do not put
real values in public documentation, logs, PRs or fixtures. No credentials belong
in the configuration: the report uses the specified managed identity and existing
new-database/archive read permissions. Provisioning or changing those permissions
is a separate operation. Database selection is an operator responsibility: select
only the new solution's database. The tool never connects to an old database.
Restore/rollback, Azure SQL verification and maintenance-window gates still apply
to data-bearing operations; this change performs none.

The JSON configuration is strict; unknown fields fail. It has two modes:

| Mode | Required fields |
|---|---|
| Both | `mode`, numeric `organizationId`, `privateOutput: { directory, approvalRef }` |
| `manifest` | Absolute `localRawFile`, ISO `reportDay`, `provenance: { sourceLabel, retrievedAt, approvalRef, toolVersion }`; optional `includePerUser` (default false) |
| `report` | ISO `from`, `to`; `manifestFiles: [{ reportDay, path }]`; absolute `publicSummaryFile`; `sql: { server, database, managedIdentityClientId }`; `archive: { accountUrl, container }` |

`provenance.sourceLabel` is a generic label, not a tenant/storage name.
`retrievedAt` is an ISO timestamp. The provenance approval covers the supplied
source evidence; `privateOutput.approvalRef` covers the private output destination.
They do not grant source access. The manifest mode opens **only a supplied local
regular file**; it has no source API/Blob client.

## Manifest and comparison

1. Manifest mode reads the exact local bytes, computing SHA-256, byte length,
   non-empty line/object/user/duplicate counts and all additive totals. Credits
   are summed exactly, with no floating-point conversion. It writes
   `manifest-{correlationId}.json` only to the approved private directory. Malformed
   UTF-8/JSON, wrong day/organization, missing/unmeasurable fields, empty files and
   numeric overflow yield an explicit incomplete manifest, never invented zeros.
   Duplicate keys are counted; ambiguous per-user evidence is omitted and cannot
   match. Nested validation failures may still have measurable root totals.
2. Report mode maps each supplied manifest to its requested day. Omitted days are
   unavailable; invalid or unreadable supplied manifests are incomplete. It reads
   the current `users_1_day` published run, its single source artifact, validation
   issues and the day's facts in one consistent read-only SQL transaction.
   Multiple/missing artifacts, invalid counts and mixed fact lineage fail closed.
   No published run is incomplete, not an empty matched report.
3. It downloads only that artifact from the explicitly configured **new archive**
   container and independently recomputes its digest, size, counts and accepted
   metrics using the current loader parser. Missing/denied archive or SQL reads
   are unavailable. Invalid/partial/corrupt archives are incomplete.
4. It compares all required checks and optional per-user evidence, then uses
   `deriveDayStatus` / `deriveRangeCoverage`. `quarantined_rejects` is the only
   explanation: identical artifact bytes, SQL agreement with accepted rows and
   exact reject line/hash evidence are required. A reject count alone is not
   proof; unrelated SQL differences stay unexplained. Whole-file quarantine or
   fatal validation never becomes explained.

Private `detail-{correlationId}.json` contains the approval reference, per-check
values, totals and optional per-user differences. It is written before the public
summary. The summary passes `assertPublicSummary` immediately before writing;
only dates, check outcomes and aggregate counts can leave the private boundary.
Public/private output paths cannot overlap. Neither hashes, identity values,
source locators nor approval references are logged; logs contain fixed event
codes, correlation IDs and counts only. Raw exception messages are not emitted.

Exit `0` means the manifest was available, or the complete report was matched or
explained. Incomplete manifests and unmatched/unavailable reports are still
written (when possible) but exit `1`; configuration/output failures also exit `1`.
An explained day is not an exact match and must remain visible for owner review.
Neither exit code nor a matched range authorizes migration or cutover.

## Synthetic verification

Focused units: `npx vitest run --project unit functions/src/reconciliation/report.test.ts scripts/reconciliation/metrics.test.ts`.

The existing hosted integration job runs
`scripts/integration/metrics-reconciliation.int.test.ts` with SQL Server and
Azurite. It creates a throwaway database/container and covers equal, missing,
mismatched, rejected/explained, quarantined, unavailable, invalid and partial
coverage. It uses synthetic data only and asserts public/log privacy.

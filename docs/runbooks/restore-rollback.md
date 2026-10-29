# Runbook: restore and rollback

Implements the operational guidance for D-34, D-49 and D-50. Applies to the
**new solution's separate database and storage only**, including the first
data-bearing alpha import. It does not authorize a deployment, restore, legacy
source access, final migration, or retirement.

**Gate:** no data-bearing deployment, import, backfill, or parallel run until
this runbook is completed and reviewed and the private operator has recorded an
exercised non-production restore. Documentation review or a tabletop alone is
not restore evidence. [Issue #55](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/55)
remains open until that evidence is accepted. The separate
[#56](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/56)
Azure SQL identity/grants gate and explicit owner authorization still apply.
No restore has been exercised as part of this documentation change.

## Owners and prerequisites

Assign named people and a backup for each role in the **private** deployment
record before the work window. Public examples such as `{sql-database}`,
`{raw-account}`, `{restore-target}` and `{incident-id}` are placeholders only.

| Role | Responsibility |
| --- | --- |
| Change owner / incident lead | Approves the window, recovery choice, acceptable data loss and resumption; records go/no-go |
| SQL operator | Verifies backups and restore permissions, performs isolated recovery and checks schema/history and database users |
| Storage operator | Verifies object recovery coverage, recovers exact bytes and checks archive lineage; protects Functions host storage |
| Ingestion operator | Stops and drains new-solution writers, inventories runs/checkpoints, performs approved loader replay and reconciliation |
| Portal/access operator | Isolates traffic and portal writes, deploys the compatible release and verifies grants, freshness and privacy |
| Independent verifier | Reviews restored results, evidence, loss assessment and release decision with the owner |

Operators need separately approved Azure management and data-plane permissions,
quota/capacity, and a working private network/DNS route to the source and isolated
recovery targets. Verify access before the incident; do not make resources public,
enable shared keys, grant runtime admin rights, or borrow the old solution's
identity. Use [database-grants.md](database-grants.md) for effective SQL permissions
and managed-identity verification. Recovery privileges are temporary operator
privileges, not runtime role extensions.

For encrypted resources, verify required key versions and recovery access without
displaying values. Keep resource IDs, principals, backup locations, manifests,
payloads, logs and approvals private. Machine-consumed configuration belongs in
the private deployment repository's validated configuration, secrets in Key Vault;
Markdown records human decisions, not executable configuration.

## Before every data-bearing change

1. Record the approved scope, UTC start/window, operator/verifier, current and
   proposed release SHA/artifact, configuration revision and migration file
   checksums/`portal.schema_version` state. Identify compatible old/new app and
   ingestion packages. Include module data, current run IDs, source checkpoints,
   day coverage, expected counts and raw hashes. For a first import, explicitly
   record which tables/days and archive prefixes are empty; do not assume all
   control, access or directory data is empty.
2. Isolate new-solution traffic and stop all its writers: portal mutations,
   metrics/API timer, import/backfill/replay processes, directory sync, retention
   and optional-module jobs. Keep an already disabled directory app disabled.
   Drain in-flight requests and SQL transactions; confirm no competing day locks,
   migration runner or queued retry can publish. Stopping a timer alone does not
   cancel an active import or transaction. Record the last committed boundary.
   Do not stop or change legacy schedules during independent parallel operation.
3. Have the SQL operator verify the actual Azure SQL backup retention and
   earliest/latest available restore times. Choose a pre-change UTC restore point
   after quiescence and prove that it is recoverable, or create and verify an
   approved consistent database copy. A timestamp, successful deployment, export
   request, or configured retention value is not proof of a usable backup.
   For a new database, wait for a usable recovery baseline before loading data.
   Preserve the source database; never use its deletion as a rollback step.
4. Have the storage operator inventory the `raw` container: exact object names,
   sizes, SHA-256 hashes, metadata and available version/snapshot/backup references.
   Verify recovery for each pre-existing referenced object and an approved
   protection path for new writes. Retain the immutable import source and manifest
   throughout the run; capture new archive references as it progresses. If native
   protection does not cover the operation, obtain a separately approved,
   access-controlled independent copy and verify its bytes, or stop. An empty
   archive baseline does not protect the first newly written objects.
5. Record a coherent SQL/archive marker: the SQL point/copy, current runs and
   their `SourceArtifact` references, and recoverable raw objects/hashes. Blob and
   SQL do not share a transaction or atomic backup. Mark any objects landed but
   not published; retain them, do not treat them as successful days.
6. Confirm the recovery route, compatible packages, decision deadline and
   acceptable loss/outage for this window with the owner. Production RPO/RTO are
   still open in the decision record; do not invent targets or promote without
   approved targets. Schedule the maintenance window before the first deployment
   containing migration `20261026001200` (AI Credits key/table rewrites).
7. Record the completed runbook review, restore-exercise evidence and #56 result
   with the owner's explicit go decision. Any missing marker, inaccessible
   backup, unproven recovery coverage or required approval is **no-go**.

### Source configuration is not backup evidence

[`sql.tf`](../../infra/terraform/stack/sql.tf) creates or references the new
database, but does not establish a deployment-specific verified restore window.
[`storage.tf`](../../infra/terraform/stack/storage.tf) uses ZRS and a
Cool-tier lifecycle rule. Replication and Cool tiering are not backups against
logical deletion/corruption. The metrics raw archive account enables Blob
versioning, blob soft delete and container soft delete for `raw_archive_recovery_days`
(default 30), and a lifecycle rule expires noncurrent versions after the same window.
Blob point-in-time restore and change feed are not configured. Configuration is
not evidence: inspect the deployed settings and retained versions.
Any required protection change needs separate infrastructure approval, not this
runbook. Do not start a data-bearing run with an unprotected archive.

## Incident containment and recovery choice

Stop promotion, isolate affected reads/mutations, stop and drain new-solution
writers as above, and preserve the failed database/archive, release and sanitized
diagnostics. Record detection time, first bad commit/run, last known-good marker
and affected organizations/days privately. Unknown scope means keep the system
unavailable, not serve partial data as complete.

| Choice | Use only when | Stop condition |
| --- | --- | --- |
| Redeploy compatible previous code | Data/schema remain correct and the previous package is proven compatible | Old code expects removed columns/tables or broader permissions |
| Forward fix | Damage is bounded; a reviewed correction/replay can preserve valid later writes and meet the approved window | Unknown effects, unsafe retry, unexplained reconciliation differences or missed deadline |
| Restore | A verified pre-damage point/copy exists; owner accepts the identified loss and dependent storage recovery | No recoverable point, missing raw bytes, incompatible schema/package or unacceptable loss |

SQL migrations are forward-only. Redeploying code does not undo DDL. For a
partially applied migration, inspect both schema and history:
[migrations.md](migrations.md) describes the non-atomic script/history boundary.
Correct prerequisites and retry only if safe; faulty merged SQL requires an
owner-approved recovery plan. Never edit merged files or patch
`portal.schema_version` to pretend a rollback occurred.

Migration `20261026000800` removes `BreakGlassConfig`; preserve existing rows and
verify the replacement deployment setting before applying it. Migration
`20261026001200` rewrites AI Credits keys and cannot recover rows previously
rejected by old keys without source replay. Neither is reversed by an app rollback.

## Azure SQL recovery

1. SQL operator confirms the exact new-solution server/database and approved
   pre-damage point/copy, recovery scope and expected lost-write interval.
   Inventory valid post-marker writes separately: grants/revocations, identity
   links, directory state, feedback, audit and ingestion may all be affected.
   Obtain the owner's explicit acceptance of loss or an approved reconciliation
   plan before switching. Never query or restore the legacy database implicitly.
2. In Azure SQL's **Restore** workflow, select the verified UTC point-in-time and
   create a distinct `{restore-target}` database. PITR creates a new database,
   not an in-place overwrite. For a verified copy, use that isolated recovery
   baseline. Wait for completion and record the Azure operation result, actual
   selected time, target identity, duration and any failure. A restored database
   is not yet a production-ready endpoint.
3. Keep the target inaccessible to normal traffic and writers. Verify database
   consistency, required tables/constraints, migration versions/checksums and
   compatible application/loader artifacts. Validate counts, day coverage,
   aggregates, current runs, checkpoints and lineage against the pre-change
   manifest and authorized reconciliation evidence. Recover referenced raw bytes
   with the storage procedure below before attempting replay.
4. Verify contained Entra users/SIDs and effective permissions on Azure SQL with
   [database-grants.md](database-grants.md); do not broaden permissions to make a
   previous package work. Verify network, server-level dependencies and Key Vault
   references separately; a database restore does not restore all infrastructure.
   Do not auto-apply the newest migrations to a database intended for old code.
5. Reconcile security changes since the marker before any user traffic: an old
   backup can resurrect revoked grants or links, stale hierarchy and purged PII.
   Reapply authorized revocations/purges through reviewed owner/writer procedures
   and obtain fresh directory evidence. Never fabricate sync success timestamps
   or rely on restored sessions to establish current permissions. Keep elevated
   access fail-closed until freshness and identity checks pass.
6. Independent verifier checks the restored target with the pinned compatible
   package: health, authorized and denied personas, small-group suppression,
   aggregate-only restrictions and disabled surfaces/modules. No production
   test-auth provider. Use the approved non-production validation route first.
7. Only after owner sign-off, change the private deployment's SQL target through
   the approved deployment/configuration mechanism for **every** new-solution
   consumer together, restart to discard old pools, and verify connections reach
   only the restored target. Review Terraform's next plan for target drift or
   accidental recreation; do not run apply as an ad hoc restore command.
8. Resume one intended writer at a time, reconcile any approved replay, then
   restore traffic and monitor freshness/errors/counts. Record actual data loss,
   outage and remaining gaps. Preserve the failed source and recovery evidence
   for the incident's approved retention; cleanup needs separate approval.

If backup retention has expired or a regional outage prevents PITR, stop for the
operator's separately validated copy/LTR/geo-recovery plan. Do not assume those
features or cross-region access exist. Raw metrics alone cannot reconstruct
portal access, feedback, audit or all directory lifecycle state.

## Raw archive and related storage recovery

1. Storage operator identifies the precise affected container/prefix and marker
   objects. Freeze publishers/replay and preserve evidence before changing any
   version. Metrics raw archive and metrics Functions host share an account;
   directory host storage is separate. **Do not restore the whole account or
   rewind host queues/tables, leases, receipts or timer state to recover raw data.**
   Host recovery/redeployment needs a separate reviewed plan so it cannot retrigger
   writes or weaken directory isolation.
2. Choose a recovery mechanism verified as enabled **before** the loss: recover a
   deleted object with soft delete, recover the correct version/snapshot, or copy
   from the verified independent backup. Versioning/soft-delete retention must
   cover the marker. Blob PITR additionally requires supported account/blob
   features, versioning, blob soft delete and change feed; inspect its range and
   limitations before use. It does not recover deleted containers/accounts.
   Account/container deletion needs independently verified protection or backup.

   **Versioned containers (the raw archive):** with blob versioning on, deleting a
   blob keeps its earlier versions and leaves no soft-deleted blob, so `undelete`
   fails with `BlobNotFound`. Restore the previous version instead: list versions
   (`az storage blob list --include v --prefix <path> --auth-mode login`), pick the
   version ID whose hash matches `SourceArtifact`, and copy it back over the blob
   (`az storage blob copy start --source-uri "<blob-url>?versionid=<id>"
   --destination-blob <path> ... --auth-mode login`). Use `undelete` only on
   containers without versioning. `az storage blob delete` has no `--version-id`
   option; deleting a single version (for example, drill clean-up) needs the Blob
   REST API (`DELETE <blob-url>?versionid=<id>`) with an Entra token.
3. Recover into an isolated location first where supported. Verify exact content
   hashes and sizes against the manifest and `SourceArtifact`, plus metadata,
   paths and availability. Enumerate missing/extra objects and failed copies;
   a successful copy request without byte verification is not recovery evidence.
   If references encode an account/container, an alternate location is not
   automatically usable: settle reference resolution in a reviewed recovery plan,
   never hand-edit lineage.
4. Under the approved window, recover required objects at their referenced
   locations or use the reviewed relocation plan. Do not overwrite a retained
   immutable run object with different bytes. Retain corrupt/unpublished objects
   as incident evidence outside the replay input selection. Preserve good raw
   objects newer than a restored SQL point; SQL restore is not a reason to rewind
   or delete the archive. Reconcile them explicitly before replay.
5. Verify the matched SQL/Blob set: every current run's referenced raw bytes exist
   and match hashes; checkpoints and day coverage agree with published SQL state.
   SQL facts do not recover lost source bytes, and recovering a blob does not
   publish SQL. Replay only approved raw inputs through the ingestion writer,
   never enhanced files or direct fact-table edits. Verify component RBAC and
   normal lifecycle/host behavior before resumption.

If no usable object version or backup exists, record the gap and stop. A fresh API
download is acceptable only under separately approved source access and comparison;
its contents may differ and older days may be outside the API history window.
Never silently substitute it for the original artifact.

## Undoing a bad legacy import run

This section covers only the owner-approved **one-time D-28 exception** being
built separately: legacy **raw** NDJSON is loaded through `loadMetricsDay` as
`portal_metrics_ingest`. It is not a general upload interface or a change to the
normal archive-only importer rule. Verify the merged import package and its
actual invocation/retry interface before the private run; this runbook invents
no import, delete or force command.

1. Stop the importer, its retries and all competing new-solution writers. Record
   the source manifest/hash, exact target database/archive, code SHA, attempted
   days, run IDs and outcomes. Confirm transactions are drained. Preserve source
   files, raw objects, staging/validation evidence and checkpoints privately.
   Never modify the legacy source or its runtime.
2. Distinguish outcomes by durable state, not just process exit: quarantine can
   leave raw/staging evidence without publishing, while a connection failure
   after commit can report failure even though the day is current. Compare
   `IngestionRun`, current-day facts/aggregates, `SourceArtifact` and
   `SourceCheckpoint`. A multi-day import is not one all-or-nothing transaction;
   some days may already be committed.
3. If no day published, verify previous curated/current/checkpoint state is
   unchanged. Correct the input or loader only after review, then retry with
   the supported run-ID semantics of that package. Do not delete failed runs,
   raw evidence or mutate checkpoint/history to make the run appear absent.
4. For a bounded bad published day with a complete known-good raw replacement,
   prefer a reviewed replay through the same normal loader and narrow role.
   Its day lock, validation, atomic publication and smaller-day guard still apply.
   Reconcile facts, aggregates, lineage and checkpoints after every day.
   Replaying correct facts is **not** a complete inverse: shared user observations,
   login history and other dimension effects may remain from the bad run.
   Assess these effects explicitly before declaring recovery.
5. If the correct replacement is smaller, empty, absent before import, or damage
   includes dimensions/security state that replay cannot reverse, stop for an
   owner-approved recovery plan. The checked-in `loadMetricsDay` input exposes
   no admin-force/undo flag; do not bypass the guard with SQL, toggle `is_current`,
   fabricate an empty day or delete dimension rows. Use the verified pre-import
   SQL restore/copy procedure when complete reversal is required. Restore loses
   **all** later database writes, not just this import; inventory and approve
   that loss/reconciliation first.
6. After SQL recovery, retain import raw objects for investigation and exclude
   them from further input selection; no blanket blob deletion. Validate the
   restored pre-import baseline, security freshness and SQL/archive references.
   Re-import only approved inputs through the normal loader after the verifier
   and owner approve resumption. An initially empty target is not permission
   to drop/recreate the database or erase audit/history.

## Quarterly restore exercise and retained evidence

The private operator performs an exercise **every quarter and before cut-over**;
cut-over requires a successful exercise within the last **30 days** (D-49).
Repeat after material changes to recovery dependencies. A tabletop reviews the
decision path but does not replace an exercised Azure SQL and raw-object restore.

1. Book an approved non-production window and isolated SQL/storage targets with
   the same relevant authentication/network/recovery features. Use synthetic
   data, never copy production PII into a developer stack. Include portal-owned
   grants/feedback/audit, directory state, two published metric days and matching
   archive objects; record counts, hashes, versions and a verified recovery marker.
2. Tabletop code-only failure, partial forward migration, corrupt raw data and
   partial multi-day legacy import. Assign owners and choose forward fix versus
   restore, including the later-write loss and revocation/PII risks.
3. On the disposable targets only, introduce a controlled post-marker data
   change and raw-object loss/corruption covered by the chosen protection.
   Exercise actual SQL restore to a new target and raw recovery using the
   procedures above. Prove the marker data returns and identify which
   post-marker changes are intentionally not recovered.
4. Run schema/history, exact-byte lineage, counts/aggregates/checkpoints,
   least-privilege managed-identity and access/freshness checks. Exercise the
   approved loader replay on the restored target and a non-production connection
   switch; confirm health/smoke and denied-access cases. Measure restore duration
   and lost-write interval against the approved targets; a local container test
   alone cannot prove Azure PITR or Entra SQL authentication.
5. Verifier and owner sign the result, record failures and remediation/retest
   dates, then approve cleanup of only the named exercise resources. A failed
   or incomplete exercise leaves the gate blocked.

Retain an access-controlled evidence bundle in the private deployment/incident
record: exercise/change ID, date/UTC times, operators/verifier/approvals, exact
source and target resources, release/config/migration versions, restore window
and marker, Azure operation IDs/results, raw manifest and hash comparisons,
pre/post counts and reconciliation differences, permissions/access/smoke results,
actual duration/loss, exceptions and remediation, and cleanup confirmation.
Set the evidence retention/access policy with the operator; keep it available
for quarterly comparison and cut-over review. No credentials, connection strings,
raw payloads, real identifiers or unsanitized screenshots belong in public PRs.

**Evidence status for #55:** runbook review, tabletop date, SQL restore result,
raw recovery result, verifier sign-off and private evidence reference must each
be recorded by the operator. They are **pending**, not implied by this document.
Publish only a sanitized outcome and private evidence reference when accepted;
leave #55 open until the exercised restore evidence is complete.

## Platform references

- [Azure SQL backup recovery](https://learn.microsoft.com/en-us/azure/azure-sql/database/recovery-using-backups?view=azuresql)
- [Blob point-in-time restore prerequisites and limitations](https://learn.microsoft.com/en-us/azure/storage/blobs/point-in-time-restore-overview)
- [Cut-over and rollback gates](cutover.md)

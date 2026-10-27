# Runbook: cut-over and rollback gates

D-34, D-49 and D-50. This is a decision checklist and recovery sequence, **not
authorization to extract legacy data, freeze the old service, migrate, switch
traffic or retire anything**. Final data migration happens at the end into the
new solution's separate database. A separately reviewed private plan and explicit
owner authorization must supply source access, stable-ID mapping, timing, exact
targets, operators and rollback deadline before execution.

The first data-bearing alpha import is not final cut-over. It is still blocked
by [restore/rollback readiness](restore-rollback.md), #55/#56 and separate owner
approval. The old solution remains untouched during independent parallel runs.

## Go/no-go review

Change owner, SQL/storage/ingestion/portal operators and independent verifier
record evidence and sign-off in the private deployment record. **Unknown,
missing, stale or failed evidence is no-go**, not a waived check.

| Required evidence | Go condition |
| --- | --- |
| Recovery prerequisites | Completed/reviewed restore runbook; exercised restore accepted for #55, successful restore test within the last 30 days; verified pre-change SQL and raw markers; approved loss/outage and rollback deadline |
| Azure SQL readiness | #56 actual non-production managed-identity/grants verification accepted; compatible schema, code and narrow runtime roles; maintenance window approved before first deployment containing `20261026001200` |
| Metrics reconciliation | Authorized legacy comparison provenance, dates and coverage recorded; SQL metrics match legacy output, no unexplained discrepancies, duplicates or missing periods |
| Migrated portal data | Per-table source/target counts reconciled, stable Entra principal mappings verified; every unmapped grant/author reported and resolved or explicitly accepted without silently dropping it |
| Hierarchy | Rebuilt current hierarchy compared against authorized legacy evidence; manual override disposition approved; no legacy table changes or runtime cross-database comparison identity |
| Feedback and audit | Feedback/vote/comment authors mapped to principals; every screenshot reference exists and parent visibility is enforced; only portal-originated audit rows copied, old `dbo.AuditLog` untouched |
| Feature and privacy acceptance | Owner-approved feature-parity checklist passes as E2E; scoped/denied access, freshness and small-group suppression verified; aggregate-only restrictions and disabled alpha surfaces remain enforced |
| Deployment smoke | Production smoke green on the deployed new release before public traffic promotion, under the approved restricted validation route; failed smoke blocks promotion |
| Operational readiness | Credentials valid for at least 30 days; alert emails confirmed; health/freshness monitoring and incident ownership ready |
| Rollback capability | Previous portal artifact/configuration deployable; legacy runbooks remain schedulable for one release; tested routing/config reversal and post-switch-write disposition agreed |
| Authorization | Separate final migration/source-access/switch plan approved; all deviations, irreversible effects and acceptable data loss explicitly accepted by the owner |

Budget/cost-center automation and its tables are not migrated or changed. Budget
Lookup, if enabled, remains live read-only GitHub access (D-55), with no old/new
SQL fallback. Disabling a module does not undo its schema or data.

## Approved-window sequence

1. **Prepare:** identify exact old/new release artifacts and independent stores,
   routing mechanism, validation route, owner/verifier, observation window and
   rollback decision deadline. Use placeholders in public discussion; keep
   actual configuration in the private validated deployment files.
2. **Freeze only what is approved:** stop/drain new-solution writes and take the
   [verified SQL/archive markers](restore-rollback.md#before-every-data-bearing-change).
   Freezing legacy portal writes or schedules requires separate authorization in
   the final plan; do not infer it from this sequence or a matching parallel run.
3. **Migrate at the end:** execute only the separately approved mappings and
   source-access procedure into `portal` in the new database. Reconcile grants,
   hierarchy, feedback, screenshots and portal audit per table. Never alter old
   `dbo` objects, map permissions by email/login, or hand-edit migration history.
4. **Review before switching:** verifier checks every go/no-go row; owner records
   the decision. Deploy the compatible release, validate the restricted new
   endpoint and smoke, then switch traffic only through the approved mechanism.
   Keep writes frozen until their target and rollback disposition are confirmed.
5. **Observe:** monitor smoke, SQL/auth errors, freshness, scoped access and
   reconciliation for the owner-approved window. Record all new-solution writes
   since the marker. Reopening old-service writes is a separate plan decision;
   never enable two writers against one table.
6. **Accept:** owner signs new-solution acceptance. Keep the previous portal
   deployable and runbooks schedulable for one release. Retirement/deletion is
   a later separately authorized change, never automatic after an observation
   period or a successful smoke test.

## When rollback is required

Failed smoke, unexplained metric/count differences, incorrect identity/scope,
missing feedback/screenshots/audit, unworkable freshness/alerts or recovery
deadline exhaustion stops promotion. Isolate traffic for suspected incorrect
access; never keep serving data to avoid an outage. Before the approved rollback
deadline, the owner chooses a bounded reviewed forward fix or rollback using the
[recovery decision table](restore-rollback.md#incident-containment-and-recovery-choice).
After the deadline, require a new approved plan rather than improvising.

1. Contain and preserve evidence. Stop/drain new-solution writes and record all
   committed post-switch changes, especially revocations, links, purges and
   feedback. Do not assume returning traffic to the old portal preserves these.
2. For code-only failure, redeploy the pinned compatible previous package only
   after schema/permission compatibility is verified. For SQL damage, follow
   [Azure SQL recovery](restore-rollback.md#azure-sql-recovery), not a down migration.
   For raw loss, follow the scoped storage procedure; do not rewind Functions hosts.
3. Returning to the legacy portal is a **routing rollback**, not a data rollback.
   Validate its current security state, health, credentials and required
   dependencies before restoring traffic. If security revocations or required
   new writes cannot be safely reconciled through an authorized procedure, remain
   unavailable until a reviewed recovery path is approved. No reverse sync,
   cross-database write or old-schema alteration is authorized here.
4. Reconcile the approved lost/replayed/preserved writes, validate smoke and
   authorized/denied access, and obtain verifier/owner sign-off before reopening
   traffic. Resume only the intended schedules; old automation changes require
   their own approval. Record outcome, loss, gaps and next review.

## Irreversible effects and data-loss boundaries

SQL PITR/copy recovery loses later writes unless explicitly recovered through an
approved plan; replaying raw metrics cannot reconstruct all access, audit,
feedback or directory lifecycle state. A restored backup may resurrect revoked
permissions or purged personal data. Forward-only migrations and their dropped
objects/key rewrites are not undone by reverting code; some partial batches may
have committed without a migration history row.

Deleted raw bytes beyond protection retention, expired API history, missing
screenshots and retired legacy dependencies may be unrecoverable. A new API report
need not match the original bytes. Deleting the old database, archive, credentials
or deployment artifacts can eliminate the routing rollback path. Do not perform
such cleanup, destructive reverse migrations, or blanket day/run deletion as
part of cut-over. Record unresolved risks as no-go unless the separately approved
plan explicitly accepts their loss and provides a safe operating state.

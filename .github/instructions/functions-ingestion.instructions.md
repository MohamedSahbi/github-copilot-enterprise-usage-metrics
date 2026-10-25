---
description: "Use when building or changing Azure Functions: usage metrics ingestion, AI Credits ingestion, directory sync, backfill, importer, or replay."
applyTo: "functions/**"
---

# Ingestion and directory sync (D-10, D-11, D-28, D-29, D-36)

## Ingestion pipeline (per day)

1. Extract the day's report from the GitHub API (see the API inventory in the decision record §2.3).
2. Land the raw NDJSON in Blob at `raw/{source}/{org}/{yyyy}/{mm}/{dd}/...`, immutable, with a SHA-256 hash in `SourceArtifact`.
3. Validate; quarantine invalid rows with a reason. Never drop rows silently.
4. Stage typed rows with the run ID.
5. Replace the curated day in one transaction, only if the new data passes validation and has at least as many rows as the stored day, unless forced.
6. Take a per-day `sp_getapplock` so timer, backfill, and importer runs never overlap on one day.
7. Record `IngestionRun` status, counts, and lineage. Do not advance the checkpoint on partial batches.

- Usage metrics: `GET /orgs/{org}/copilot/metrics/reports/users-1-day?day=`. Only the last 365 days are available; `backfill_from` is clamped to that window.
- AI Credits: `POST /enterprises/{ent}/settings/billing/reports` with `report_type: "ai_credit"`, poll, download. Never `premium_request`.
- The importer only copies existing raw NDJSON into the archive layout; the normal replay loads it. Ignore "enhanced" files.

## Directory sync

- Write only to the new solution's separate database (D-29, D-34); the old directory, hierarchy and PowerShell Functions remain untouched. No v1-compatible shadow tables or runtime old-database comparison access.
- One logical `ingestion` component is the sole writer of `portal.dim_user` and login history; metrics/directory paths use it, not independent database writers. Directory sync owns directory attributes and current hierarchy/link/revocation state through ingestion. Reuse manager-ID attributes, `DirectorySyncState` and the approved shared contracts; do not treat historical budget v1/v2 descriptors as the new runtime schema.
- Never mark a partial directory run successful or advance successful sync state. Preserve stable-ID authorization, immutable principal Entra columns, tenant-FK arrangement, append-only revocation/audit and portal-owned access/grant boundaries.
- Sources: SCIM `GET /scim/v2/enterprises/{ent}/Users` supplies identity and groups (login from `profileUrl`, fallback normalized `userName`; `externalId` = Entra object ID), seats `GET /orgs/{org}/copilot/billing/seats` supplies numeric user ID + login, and Entra Graph bulk reads supply manager, department, and business area.
- Department and business area come from configurable Entra attributes (`directory.department_attribute` and `directory.business_area_attribute`, D-5/§13.1), copied into `department` and `business_area`. An empty attribute setting disables that scope. Never derive these attributes from SCIM groups; keep organization-specific attribute names in private deployment configuration.
- Store `github_user_id` ↔ `entra_object_id`. Login string rules are the last resort and never grant permissions.
- Do not call `consumed-licenses` (D-38).
- Leave `github_license_type` nullable/unsourced wherever retained. Required contract deltas land separately (#69), before persistence (#70) or provider implementation (#75).

## Independent parallel run

- Compare new outputs against explicitly authorized legacy evidence with provenance, coverage and limitations; missing evidence is not a match. No old-database access or extraction approval is implied.
- Final data migration happens at the end under a separate approved plan. New-solution acceptance and explicit authorization precede decommission; parity, privacy and deployment/restore gates are not waived by database separation.

## Credentials (D-37)

- Ingestion uses the GitHub App. The directory sync alone uses the classic PAT. Never share either secret across components.

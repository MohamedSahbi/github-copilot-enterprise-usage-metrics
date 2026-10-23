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

- Single writer of `CopilotUserDirectory`, `ManagerHierarchy`, and `HierarchySyncRun`; keep the documented column contract the PowerShell budget Functions read. Write one `HierarchySyncRun` row per run; budget reconciliation trusts only the latest `success` row, so never write `success` for a partial run.
- Sources: SCIM `GET /scim/v2/enterprises/{ent}/Users` (login from `profileUrl`, fallback normalized `userName`; `externalId` = Entra object ID; business area from SCIM `groups`), seats `GET /orgs/{org}/copilot/billing/seats` (numeric user ID + login), Graph bulk reads for manager and department.
- Store `github_user_id` ↔ `entra_object_id`. Login string rules are the last resort and never grant permissions.
- Do not call `consumed-licenses` (D-38).

## Credentials (D-37)

- Ingestion uses the GitHub App. The directory sync alone uses the classic PAT. Never share either secret across components.

# Migrations

Forward-only SQL for the `portal` schema (D-34). Runner: postgrator (D-48 naming updated by the owner); never edit a merged file.

- Name: `yyyyMMddHHmmss.do.description.sql` (UTC timestamp is the version).
- Every file starts with a header naming the single writer of each table it creates.
- Idempotent (`IF OBJECT_ID(...) IS NULL`), `portal` schema only, never `dbo`.
- Runtime grants use roles; users are created by the pipeline with `CREATE USER ... WITH SID, TYPE = E`.

## Directory persistence inventory (#70)

**No migration is required by the merged #69 contract.** The normalized
`DirectoryUserSchema` input and runtime rows in `shared/src/rows.ts` fit the
existing migrations below. This inventory implements D-29/D-34 in the new
solution's separate database; the decision record and executable contracts are
unchanged. Read [data contracts, sections 7 and 10](../../docs/architecture/data-contracts.md#7-directory-contracts-and-historical-budget-descriptors-d-29-d-34)
for the canonical input, lifecycle and ownership requirements.

Versions in this table refer to the existing `*.do.*.sql` files in this directory.
Text widths are UTF-16 code units (`NVARCHAR`); GUID columns are
`UNIQUEIDENTIFIER`, numeric GitHub IDs are `BIGINT`.

| Contract input or runtime capability | Existing persistence | Migration version(s) |
| --- | --- | --- |
| Stable `user_id`; mutable nullable `login` | `dim_user` primary key `user_id`; `login` (255), non-unique filtered login index. Positive safe-integer validation belongs to the canonical input, not a new SQL identity key | `20261026000400` |
| `entra_object_id` | Nullable `dim_user.entra_object_id` with filtered lookup index; canonical directory input requires a GUID, whereas unmapped metrics users may remain null | `20261026000400` |
| Optional `email`, `display_name` | Nullable `dim_user.email` (320), `display_name` (255); recognition attributes, never authorization keys | `20261026000400` |
| `manager_entra_object_id`, `manager_email` | Nullable manager GUID and recognition email (320) on `dim_user`; `CK_dim_user_manager_email` requires email alongside a non-null manager ID; filtered manager index supports current hierarchy traversal | `20261026000900` |
| Normalized `department`, `business_area` | Nullable `dim_user` attributes (100/50), each with a filtered index. Normalization and disabled-scope settings remain ingestion/API behavior | `20261026000900` |
| GitHub `state` | Existing `active`, `deleted`, `suspended` check; deleted rows require `deleted_at`. No old `AccountStatus` taxonomy | `20261026000400` |
| Observation, deletion and PII lifecycle | Nullable `first_seen_day`, `last_seen_day` (`DATE`), `deleted_at`, `pii_purged_at`; non-null `updated_at` (`DATETIME2(0)`). Ingestion supplies lifecycle values, not CSV overrides | `20261026000400` |
| Login history row | `dim_user_login_history`: `(user_id, login)` primary key, FK to `dim_user`, first/last observation dates and `is_hashed_login`; retained audit history, not a second current directory | `20261026000400` |
| Explicit `entra_account_enabled` evidence | Transient input only; false feeds the existing unlink/revocation workflow. No additional SQL column; GitHub state or missing input is not disable evidence | `20261026000900`, `20261026001000` |
| Link/unlink state | `PrincipalLinkState`: tenant/object GUIDs, numeric GitHub ID, link/unlink timestamps, reason, run FK and `unlink_seq`. Filtered unique indexes enforce one active link in both directions | `20261026000900` |
| Soft grant revocation | `GrantRevocation` and `v_active_grant`, ordered by `seq_access_event` positions rather than potentially equal timestamps; no deletion or rewrite of portal grants | `20261026000800`, `20261026000900`, `20261026001100` |
| Directory audit evidence | Append-only `IngestionAuditEvent`, existing directory unlink/revocation actions, run FK and correlation metadata. Action-specific privacy allowlists remain a dependent writer requirement (#50 L5) | `20261026001000`, `20261026001100` |
| `DirectorySyncStateRow` | Existing source primary key/check (`scim`, `graph`, `csv`, `seats`), nullable success/attempt timestamps and error code (64). A failed/partial run must not advance `last_success_at`; enforcement belongs to the sync transaction | `20261026000600`, `20261026000700` |

No runtime requirement in #69 needs job title, manager name, seat plan/activity,
cancellation or license columns. Historical `DIRECTORY_CONTRACT_V1`/v2 descriptors
describe external budget consumers, not these runtime tables. In particular,
`github_license_type` remains absent from `dim_user` and nullable/unsourced in the
historical descriptors; this work introduces neither consumed-licenses calls nor
compatibility copies of `CopilotUserDirectory`, `ManagerHierarchy` or
`HierarchySyncRun`.

### Existing writer and identity boundaries

One logical **ingestion** component writes `dim_user` and login history.
Directory sync owns attributes, current hierarchy and link/revocation state
through it; metrics observations must not overwrite directory attributes.
Migration headers already name these writers; none is changed by this inventory.

| Existing SQL role | Directory and access permissions after all migrations |
| --- | --- |
| `portal_ingest` | INSERT/UPDATE `dim_user`, login history and `DirectorySyncState`; login-history DELETE only through `usp_purge_login_history`. INSERT `PrincipalLinkState`, UPDATE only its unlink fields; INSERT `GrantRevocation` and `IngestionAuditEvent`; UPDATE on the access-event sequence |
| `portal_ingest` exclusions | No INSERT/UPDATE/DELETE grants on `Principal`, `PrincipalIdentity` or `AccessGrant`; explicit SELECT denial on those tables and `v_active_grant`. No INSERT on portal-owned `AuditLog`; audit/revocation UPDATE/DELETE and link DELETE are denied |
| `portal_writer` / `portal_reader` | Read active grants through the existing view. Portal writer owns principal/grant changes, but principal Entra columns cannot be directly updated and grants can only be updated at `revoked_at`; existing one-time `usp_link_principal_entra` handles initial linking |

The existing principal tenant/object pairing, unique identity indexes,
`PrincipalIdentity` principal FK and `AccessGrant` principal/Entra composite FK
remain unchanged. No tenant FK is introduced or altered. No `dbo`, old-database
objects, comparison identities or grants are added. Final data migration, source
access, deployment and cutover remain separately authorized; #55/#56 and the
existing maintenance-window gate still apply.

### Reproducible evidence

`npm run test:sql` uses the existing disposable SQL Server 2022 container harness:
random container name and password, dynamically allocated loopback port, isolated
test databases, and cleanup of that container only. It never uses the local
stack's database or an Azure/old database.

The added test, **reuses the directory contract tables after two applies and
isolates ingestion writes from portal ownership**, compares all six directory
table column sets to #69's shared registry after applying migrations twice,
checks ID types and text widths, performs ingestion-owned writes including soft
unlink/revocation and audit, stores a failed-attempt state without a successful
timestamp, and asserts real permission failures for portal-owned writes.
This demonstrates available persistence, not a completed directory publisher.

Existing SQL tests also cover second-apply no-op, script replay after loss of
history, portal-only objects, role/scope pairs, linked-identity grant FKs,
one-to-one active links, sequence-ordered revocation, immutable principal Entra
columns, manager-ID/email coherence, purge ownership and append-only audit.
`npm test` includes shared directory/CSV validation, historical descriptor tests
and migration-to-shared-column registry checks. SQL tests skipped by `npm test`
are not SQL execution evidence; report the separate SQL command's actual result
and any timeout limitations in the PR.

# Data contracts (D-47)

Status: proposed with the contracts PR. Companion to [decision-record.md](decision-record.md) (§6, §6.5, §13.6). Types are in `shared/src/`, SQL in `db/migrations/`. A change to any contract lands in `shared/` first, in its own PR.

Verification legend: **V** = verified against a recorded sample or the enterprise docs; **A** = assumption, not verified (listed again in the PR).

## 1. Settings (deployment settings, not SQL rows)

| Setting | Default | Meaning |
| --- | --- | --- |
| `retention.per_user_months` | 13 (1 to 36) | Per-user rows and PII are purged after this window (D-12) |
| `retention.aggregate_months` | unlimited | Aggregates kept indefinitely (D-12) |
| `retention.login_history_months` | 24 (1 to 60) | `dim_user_login_history` is purged only after this maximum age; explicit exception to the per-user rule (§11) |
| `privacy.min_group_size` | 5 (floor 5) | Groups below this size are suppressed for every scope, including business area (§6.3) |
| `privacy.per_user_detail` | off | Named users in responses (see §6) |
| `staging.retention_days` | 14 | Staged rows of published or failed runs are deleted after this; quarantined runs are kept until an admin acts |
| `access.break_glass_group_id` | empty | Entra group whose members reach admin and health pages when permissions cannot be read (D-17). Empty or a GUID. A setting, not a table |
| `access.permission_freshness_minutes` | 5 (1 to 60) | Maximum age of the permission data before the portal fails closed (D-17) |
| `directory.department_attribute` | empty | Entra attribute (Graph path) that holds the department. Empty = department scope disabled |
| `directory.business_area_attribute` | empty | Entra attribute (Graph path) that holds the business area. Empty = business_area scope disabled |
| `directory.empty_attribute_threshold_percent` | 20 | An enabled attribute that is empty for more than this share of users records the `attribute_empty_share` ValidationIssue |

## 2. users-1-day NDJSON → staging/curated (V against a recorded sample)

One JSON object per line; one line = one user, one organization, one day. Fact key: `(organization_id, usage_day, user_id)`.

| Field | Column | Type | Null | Notes |
| --- | --- | --- | --- | --- |
| `user_id` | `user_id` | BIGINT | no | Numeric GitHub ID; the identity key |
| `user_login` | dim_user.login | NVARCHAR(255) | yes | Mutable attribute |
| `day` | `usage_day` | DATE | no | Must lie inside the requested report window |
| `organization_id` | `organization_id` | BIGINT | no | Sent as a string; parsed to integer |
| `enterprise_id` | `enterprise_id` | BIGINT | yes | Staging only |
| `user_initiated_interaction_count` | `interaction_count` | INT | no | ≥ 0 |
| `code_generation_activity_count` | `code_generation_count` | INT | no | ≥ 0 |
| `code_acceptance_activity_count` | `code_acceptance_count` | INT | no | ≥ 0 |
| `loc_suggested_to_add_sum` / `_delete_sum` | `loc_suggested_to_add` / `_delete` | BIGINT | no | ≥ 0 |
| `loc_added_sum` / `loc_deleted_sum` | `loc_added` / `loc_deleted` | BIGINT | no | ≥ 0 |
| `used_agent`, `used_chat`, `used_cli` | same | BIT | no | |
| `used_copilot_coding_agent` | `used_coding_agent` | BIT | no | |
| `used_copilot_cloud_agent`, `used_copilot_app`, `used_vscode_agent` | `used_cloud_agent`, `used_copilot_app`, `used_vscode_agent` | BIT | no | Absent in some rows → false |
| `used_copilot_code_review_active` / `_passive` | `used_code_review_active` / `_passive` | BIT | no | Absent/null → false |
| `ai_credits_used` | `ai_credits_used` | DECIMAL(18,9) | no | Absent → 0; never rounded |
| `ai_adoption_phase{phase_number,phase,version}` | `ai_adoption_phase_number`, `ai_adoption_phase` | TINYINT / VARCHAR | yes | |
| `totals_by_ide[]` | breakdown `ide` (key_1 = ide) | | | `last_known_ide_version` and `last_known_plugin_version` → `version_info` (compact JSON of the documented string fields, NULL when absent) |
| `totals_by_feature[]` | breakdown `feature` | | | |
| `totals_by_language_feature[]` | breakdown `language_feature` (key_1 language, key_2 feature) | | | No interaction count in source → 0 |
| `totals_by_language_model[]` | breakdown `language_model` | | | |
| `totals_by_model_feature[]` | breakdown `model_feature` | | | |
| `totals_by_cli`, `totals_by_copilot_app`, `totals_by_vscode_agent` | breakdown `client` rows (`copilot_cli`, `copilot_app`, `vscode_agent`) | | | Optional objects (upstream `CopilotClientUsageTotals`): `session_count`, `request_count` → INT; `token_usage.prompt_tokens_sum` / `output_tokens_sum` → `prompt_tokens`, `output_tokens` (BIGINT); `last_known_cli_version` → `version_info`. A supplied value that is not a valid count is rejected (`negative_count`), an absent one is NULL. `prompt_count` and `avg_tokens_per_request` are not staged |
| `totals_by_skill`, `_custom_agent`, `_mcp`, `_slash_cmd`, `_plugin` | `fact_usage_family_count` (family, name, count) | | | |
| any other field | `extra_json` (daily) | | | Warn `unknown_field`, load. `totals_by_client` is not in the pinned upstream types and is not staged |

Language names are normalized with the upstream language normalizer before loading (oracle parity).

Observed sample shapes (schema only; staging behavior is unchanged):

- The checked NDJSON file contained 18,570 JSON objects and no malformed or non-object lines.
- `totals_by_client[]` items contain `client` (string), `session_count` and `request_count` (numbers), `token_usage` (object), and `totals_by_model[]`. Client and model `token_usage` objects contain `prompt_tokens_sum`, `output_tokens_sum`, and `avg_tokens_per_request` (numbers). `totals_by_model[]` items contain `model` and `model_selection_mode` (strings), `request_count` (number), and `token_usage`.
- `totals_by_custom_agent[]`, `totals_by_mcp[]`, `totals_by_plugin[]`, `totals_by_skill[]`, and `totals_by_slash_cmd[]` contain their respective name field (`custom_agent`, `mcp`, `plugin`, `skill`, or `slash_cmd`, a string) and `interaction_count` (number).
- `totals_by_feature[]` contains `feature` and numeric activity/LOC counts; `totals_by_ide[]` contains `ide`, numeric activity/LOC counts, and `last_known_ide_version` / `last_known_plugin_version` objects; `totals_by_language_feature[]` contains `language` and `feature` with numeric activity/LOC counts; `totals_by_language_model[]` contains `language` and `model` with numeric activity/LOC counts; `totals_by_model_feature[]` contains `model` and `feature` with numeric activity/LOC counts. The specific activity/LOC field names are `code_generation_activity_count`, `code_acceptance_activity_count`, `loc_suggested_to_add_sum`, `loc_suggested_to_delete_sum`, `loc_added_sum`, and `loc_deleted_sum`; `totals_by_feature[]`, `totals_by_ide[]`, and `totals_by_model_feature[]` also contain `user_initiated_interaction_count`.

### Quarantine rules

| Severity | Error code | Condition |
| --- | --- | --- |
| reject | `missing_user_id` | `user_id` absent, null or not an integer |
| reject | `invalid_day` | `day` unparseable or outside the report window |
| reject | `missing_organization_id` | `organization_id` absent or non-numeric |
| reject | `negative_count` | any count or LOC value that is not a non-negative integer or exceeds its column (INT counts ≤ 2147483647; BIGINT LOC and token sums ≤ 2^53−1); also an invalid supplied client counter |
| reject | `duplicate_key` | superseded for day files by fatal `duplicate_file` (issue #44); kept only until ingestion adopts the new rule |
| reject | `malformed_json` | line is not a JSON object |
| warn | `unknown_field` | top-level field not listed above |
| warn | `unknown_enum_value` | unrecognised feature/IDE/model/client key (added to the dimension with `is_known = 0`) |
| warn | `unresolved_billing_login` | billing username does not resolve to a user ID |
| warn | `extra_nested_item` | nested item with unknown shape |
| warn | `attribute_empty_share` | an enabled directory attribute (department or business area) is empty for more than the threshold share of users |
| fatal | `unsupported_schema` | deprecated root fields (`generated_loc_sum`, `accepted_loc_sum`) or file schema unrecognised |
| fatal | `hash_mismatch` | SHA-256 of the downloaded file differs from the recorded one |
| fatal | `duplicate_file` | the same user key `(organization_id, user_id, day)` appears twice in a day file; the whole file is quarantined |
| fatal | `duplicate_nested_name` | duplicate names inside a nested list of one row; the whole file is quarantined |
| fatal | `smaller_day_blocked` | the incoming day has fewer rows than the stored day and no admin force flag is set; incoming data is quarantined |

A run with fatal issues publishes nothing. A run with rejects publishes the valid rows and reports the counts in `IngestionRun`.

Staging row identity is `(run_id, artifact_id, line_number)`: a report can arrive as several parts under one run, every part restarts at line 1, and `artifact_id` (the `SourceArtifact` of the part) keeps the rows apart. Duplicate detection stays per run, so a user key repeated in another part of the same day is also a `duplicate_file` (see §12).

## 3. ai_credit enterprise billing report → staging/curated

Source: `POST /enterprises/{ent}/settings/billing/reports` then poll and download CSV parts from short-lived signed URLs (never stored or logged). One export at a time per enterprise: HTTP 409 means wait and retry; the run holds an enterprise-scoped applock. Records live 31 days at the source; history reaches back 24 months. Grain: date × username × model (plus organization, cost center, repository, app client).

| CSV column | Column | Type | Null | Status |
| --- | --- | --- | --- | --- |
| `date` | `usage_date` | DATE | no | V |
| `username` | `username` | NVARCHAR(255) | no | V; hashed for deleted users |
| `product`, `sku` | same | NVARCHAR | yes | V |
| `model` | `model` | NVARCHAR(128) | no | V |
| `quantity` | `quantity` | DECIMAL(18,9) | yes | V |
| `unit_type` | `unit_type` | NVARCHAR(32) | yes | V |
| `applied_cost_per_quantity`, `gross_amount`, `discount_amount`, `net_amount` | same | DECIMAL(18,9) | yes | V |
| `total_monthly_quota` | same | DECIMAL(18,9) | yes | V |
| `organization` | `organization_login` (+ resolved `organization_id`) | NVARCHAR | no, '' allowed | V (a name, not an ID) |
| `app_client_id`, `repository` | same | NVARCHAR | '' allowed | **V** (documented by GitHub; empty values are allowed) |
| `cost_center_name` | same | NVARCHAR | '' allowed | V |
| `aic_quantity`, `aic_gross_amount` | same | DECIMAL(18,9) | yes | V |
| `input`, `output`, `cache_read`, `cache_write` | `*_tokens` | BIGINT | yes | V |

Natural key: `(date, organization, username, model, sku, cost_center_name, repository, app_client_id)`; the tables key on a persisted SHA-256 `natural_key` of these text columns because they exceed SQL Server's index key size limits (1700 bytes nonclustered, 900 clustered). Duplicates in one export → reject `duplicate_key`. Unknown columns → warn `unknown_field` (ignored, since CSV has no JSON overflow column). Decimals are never rounded.

Private, owner-run schema-only verification of a local report confirmed the 22 columns listed above, in that order, with 3,242 data rows and a consistent 22-field row width. No row values were retained, and the source report is not included. These are the owner's local verification results; public reviewers cannot independently verify the report's origin or reproduce the check from this repository. Download parts are named `AIUsageReport_<part>_<hash>.csv` (`ai_credit` report type); `download_urls` can contain several parts, each with the same header.

Field semantics from GitHub's billing reports reference ("Billing reports reference", AI usage report): `quantity` is the amount of the SKU used, in the unit named by `unit_type`; `gross_amount - discount_amount = net_amount`; `repository` is the associated repository, if any; `app_client_id` is the client ID of the GitHub App for usage billed directly to an organization and may be empty for usage attributed to a user, GitHub Actions or GitHub-owned apps. Both columns stay nullable/empty-allowed and part of the natural key. The report is summed per date, model and username (plus organization, cost center, repository and app).

Remaining assumptions (A): none for the column set; `unit_type` could differ for other SKUs, so `quantity` is stored with its `unit_type` and never assumed to be a request count.

## 4. Metric definitions

Oracle: the pinned upstream aggregation (`portal/upstream/src/domain`, D-14); our SQL aggregates must equal it on the fixture. All metrics are version 1. Counts are distinct `user_id` over the selected organization and date range.

| Key | Formula (per selected range) | Upstream source |
| --- | --- | --- |
| `total_users` | distinct users with any feature, CLI, App, VS Code agent, coding agent or code review signal | `computeFeatureAdoptionData.totalUsers` |
| `completion_users` | users with `code_completion` interactions or generations > 0 | `featureAdoptionCalculator` |
| `chat_users` | users with a chat feature (taxonomy `isChat`) and interactions or generations > 0 | same |
| `agent_mode_users` | users with an agent feature (taxonomy `isAgent`) | same |
| `ask_mode_users`, `inline_mode_users`, `plan_mode_users` | users with a feature whose chat-mode bucket is `ask`, `inline` or `plan` (not derivable from `chat_users`; the adapter requires them) | `getChatModeBucket` in `featureAdoptionCalculator` |
| `cli_users` | users with `used_cli` on any day | same |
| `app_users` | users with `used_copilot_app` | same |
| `vscode_agent_users` | users with `used_vscode_agent = true` | same |
| `coding_agent_users` | users with `used_copilot_cloud_agent` | `resolveCopilotCloudAgentUsage` |
| `code_review_users` | users with active or passive code review | same |
| `advanced_users` | users with agent feature **or** CLI **or** VS Code agent **or** coding agent | same (see D-22 note) |
| `completion_only_users` | has completion and none of chat, agent, CLI, App, VS Code agent, coding agent, code review | same |
| `ai_credits_used` (daily) | Σ `ai_credits_used` per day; `users` = distinct with value > 0 | `aiCreditsCalculator` |
| `aic_cost` (billing) | Σ `aic_gross_amount` | not in upstream (billing report) |

### Deliberate and discovered differences

| Metric | Difference | Reason |
| --- | --- | --- |
| `advanced_users` | Widens relative to the old portal's chart: includes CLI, VS Code agent and coding agent in addition to agent mode. | D-22 adopts upstream; stakeholders are told the figure rises. Not a difference from upstream. |
| `*_users` over a range | Upstream computes over the loaded file; ours over SQL rows inside the retention window and organization scope. Equal when the fixture covers the range. | Scope |
| `used_copilot_app` | Upstream derives it as the flag OR `totals_by_copilot_app` present OR a `copilot_app` feature row OR `copilot_app` IDE activity; ours applies the same derivation at load. Upstream also appends a synthetic `copilot_app` IDE total; ours does not (no SQL consumer). | Oracle parity for `app_users` |
| `used_coding_agent` | Upstream sets both coding-agent flags from `used_copilot_cloud_agent` only; ours stores the same value in `used_coding_agent` and `used_cloud_agent`, ignoring the source `used_copilot_coding_agent` field. | Oracle parity for `coding_agent_users` |
| Language | Upstream normalizes language names at parse time; ours normalizes at load. | Same function applied in the loader |

No other difference was found while reading the calculators (only the adoption and AI credits paths were read and are checked by `scripts/contracts/oracle`; the remaining calculators are not yet compared).

## 5. Identity keys

- The numeric GitHub user ID is the only user key. `login` and email are mutable attributes; login history is kept in `dim_user_login_history`, including hashed logins of deleted users.
- Soft delete: `state = 'deleted'`, `deleted_at` set; PII is nulled after the retention window; the same ID returning reactivates the row. A recreated EMU account has a new ID and a separate row, linked by Entra object ID.
- SCIM join (D-36): SCIM gives the login (`profileUrl`, else normalised `userName`) and `externalId` (Entra object ID); the sync joins the login to the numeric ID from seats and metrics. Permissions come only from a stored Entra object ID match. SCIM does not return the numeric ID, manager or department; manager and department come from Graph.
- Organizations: `dim_organization` (numeric ID, current login) from `GET /orgs/{org}` for the configured list. Billing names resolve through it; unresolved names load with a warning.

## 6. Suppression and aggregate-only behaviour

- The minimum group size applies to every scope, including department and business area; there is no per-scope exemption. `suppressForScope` in `shared/src/api.ts` is the single rule.
- A group is any dimension slice that returns user counts or per-user-derived values. Groups with fewer than `privacy.min_group_size` users are replaced by `suppressed: true` with null values; the response also reports `minGroupSize`.
- Suppression applies only when names are not visible to the viewer. With `privacy.per_user_detail = on`, a viewer sees named users only inside their own grant scope; a manager sees their own small team.
- No response ships company-wide per-user records to the browser by default (§6.2 step 10).

| Endpoint | Default | With per-user detail on |
| --- | --- | --- |
| Core usage pages | aggregates by org/day/dimension, suppressed | unchanged |
| User list / detail | not available (`per_user_detail_disabled`) | rows only within the viewer's scope, paged |
| AI Credits | aggregates by org/day/model/cost center | per-user rows within scope, paged |
| Budget Lookup | reads `dbo` budget tables read-only; own and own-scope records | same |
| Admin | principals and grants (admin role) | same |
| Feedback | items per visibility; author shown as display name only to admins | same |
| Health | status only, no data | same |

Date ranges are bounded (max 400 days) and page sizes are bounded (max 100, default 50).

## 7. Directory column contract (D-29), versions

The budget Functions (outside this repo) read `dbo.CopilotUserDirectory`, `dbo.ManagerHierarchy` and `dbo.HierarchySyncRun`. The code-derived column sets are v1 (shared/src/directory-contract.ts, `DIRECTORY_CONTRACT_V1`), verified by contract tests. v2 re-keys the directory on the numeric GitHub user ID with login and email mutable and a deletion state; this PR defines v2 and the mapping only. Adopting v2 requires changes in the budget Functions (follow-up issue; D-29 note in the PR).

## 8. Old structure → new portal schema (generic names)

| Old (SQL DDL derived from the code; owner-confirmed correct, since the database is only ever changed by the migration script) | New | Note |
| --- | --- | --- |
| Directory table, PK login, id nullable text | `portal.dim_user` (PK numeric ID) + login history | Conflicts with D-36 key rule; v2 above |
| Directory: email, display name, department, business area, manager | Directory contract v2 columns (unchanged names in v1) | Owned by directory sync |
| Directory: account status, deletion GUID | `dim_user.state`, `deleted_at` | |
| Directory: license/plan, pending cancellation, last activity | not in portal schema; remain in the directory contract | Read by budget Functions |
| Access control (email PK, role, scope, comma lists) | `portal.Principal`, `PrincipalIdentity`, `AccessGrant` | Conflicts with D-5 (email key); one row per grant |
| Manager hierarchy (two emails + login + name) | directory contract v1 / v2 | Email-keyed; kept for budget Functions |
| Hierarchy sync run | `portal.DirectorySyncState` (portal view) + contract v1 | |
| Audit log (two writers) | `portal.AuditLog` (portal only) | The Function app keeps its own |
| Feedback item, vote, comment | `portal.FeedbackItem`, `FeedbackVote`, `FeedbackComment` | |
| Budget entity, allocation, membership, failures | unchanged, read-only | Out of scope (D-34) |
| Table-storage budget tables | out of scope | Legacy |

Conflicts flagged as open questions: email-keyed access and hierarchy tables (D-5, D-36); two writers on the old audit table (D-34); the old directory has a text user ID, nullable; legacy `enhanced` files ignored (D-28).

Token types (owner-confirmed): every GitHub endpoint used (users-1-day report, billing export, seats, `orgs/{org}`, SCIM) is called with a personal access token held in Key Vault.

Schema confirmation (owner): the old database is changed only through its migration script, so the code-derived column sets are authoritative. Cross-check against the live Table Storage export of the old directory (2217 entities): every `CopilotUserDirectory` v1 column exists with the expected types and widths (`GitHubUserId` is a numeric string of up to 9 digits, filled on every row). One property exists only in that export: `DeletionRequestedAt` (string, 19 characters, about 0.5% of rows; `DeletionTemporaryGuid` about 56%). In v2 both are replaced by `DeletedAt` (state, not sentinel).

## 9. Access model (issue #44; D-5, D-17, D-34, D-36)

Types and validator: `shared/src/access.ts`. SQL: `AccessGrant` (`CK_AccessGrant_role_scope`), migrations `20261026000800` to `20261026001100`.

| Role | Allowed scopes |
| --- | --- |
| `user` | `self` |
| `manager` | `self`, `team` |
| `executive` | `department`, `business_area`, `company` |
| `admin` | `company` |

- A grant requires a linked Entra object ID. `AccessGrant.principal_entra_oid` is NOT NULL and a composite foreign key to `Principal (principal_id, entra_object_id)` makes a GitHub-only principal unable to hold a grant.
- One Entra identity maps to one GitHub account and the reverse: unique indexes on `Principal` (both columns) and filtered unique indexes on active `PrincipalLinkState` rows.
- Self, team and company grants have an empty scope value; department and business_area need one that exists in the directory.
- Team scope is resolved from the manager's Entra object ID (`dim_user.manager_entra_object_id`). The manager's email is always stored alongside (`manager_email`) for recognition. The directory contract v2 `Manager` email column stays for the budget Functions.
- Entra disable (D-34 one writer): the directory sync (ingestion) cannot write portal-owned tables, so it appends `PrincipalLinkState.unlinked_at` and a `GrantRevocation` row, and audits to `IngestionAuditEvent`. Soft only, never deletes. The portal reads grants through `portal.v_active_grant`, which hides grants granted at or before a revocation or unlink. A re-enabled user needs new, audited grants.
- Settings `access.break_glass_group_id` and `access.permission_freshness_minutes` are deployment settings (§1); `BreakGlassConfig` is dropped.

### Grant API

`POST /api/admin/grants` (admin only): request `AdminGrantCreateRequest`, response `AdminGrantCreateResponse`, errors `AdminGrantErrorResponse` with codes `scope_disabled`, `invalid_role_scope`, `unknown_scope_value`, `principal_not_linked`. Check order: pair, scope enabled, principal linked, scope value. The admin form loads `AdminGrantFormData` (role/scope matrix, enabled scopes, distinct directory values). All in `shared/src/api.ts`.

## 10. Directory attributes (issue #44 item 6)

The directory sync reads `directory.department_attribute` and `directory.business_area_attribute` through Graph, trims, collapses whitespace and lower-cases the values (`normalizeDirectoryValue`), and writes them to `dim_user.department` and `dim_user.business_area`. An empty attribute setting disables that scope: nothing is read, the grant API answers `scope_disabled`. When an enabled attribute is empty for more than `directory.empty_attribute_threshold_percent` of users, the sync records a `attribute_empty_share` ValidationIssue (`attributeEmptyShareExceeded`). Values longer than the column (100 characters for department, 50 for business area, matching directory contract v2) are a data issue for the sync to report. No company-specific attribute names or values belong in this repository.

## 11. Login history retention (exception to D-12)

`dim_user_login_history` is kept for audit and purged only after `retention.login_history_months` (default 24), measured from `last_seen_day`. This is an explicit exception to the 13-month per-user rule: it holds logins, which are personal data, so only the admin role can read it, and it is never returned in non-admin responses. Writer: ingestion, through `portal.usp_purge_login_history`, which accepts 1 to 60 months (the same range as the setting) and audits each purge to `IngestionAuditEvent` (`login_history.purged`).

## 12. Day replacement guard and Admin issues inbox (issue #44 items 9, 10; §6.2 step 9)

- A day replaced by less data is blocked by default (`evaluateDayReplacement`): the run is quarantined with `smaller_day_blocked`. Only an admin force flag lets it through; that is audited as `day.replace_forced` (detail: `reportDay`, `storedRows`, `incomingRows`, `emptyDayConfirmed`). Forcing an empty (0-row) day also needs a typed confirmation: the admin types the day's date (`confirmDate` must equal the report day), otherwise the day stays quarantined (`empty_day_confirmation_required`). The incoming data stays in staging and the raw blob meanwhile; the run status is `quarantined`.
- A duplicate user key in a day file, or duplicate nested names, quarantines the whole file (`duplicate_file`, `duplicate_nested_name`).
- Inbox, backed by `ValidationIssue` (`issue_type`, `report_day`, `handled_at`) and `IssueAction`. Admin only; every action is audited as `issue.action_applied`.

| Issue type | Actions |
| --- | --- |
| `duplicate_file` | `retry`, `accept_last`, `accept_first`, `reject` |
| `smaller_day` | `force`, `discard` |

Status: `open`, `resolved`, `dismissed` (`reject` and `discard` dismiss). Types: `IssueListRequest/Response`, `OpenIssueCountResponse` (banner), `IssueActionRequest/Response` in `shared/src/issues.ts`. `force` on an empty day needs the day context and the typed date; without context it is rejected. A chosen action only marks the day for reprocessing (an `IssueAction` row); the ingestion Function does the work and sets `handled_at`. Out of scope: comments, assignments, custom rules, arbitrary action types, email or Azure Monitor alerts (issue #37).

## 13. Template configuration keys

The deployment template and the private environment repository supply these as tfvars and app settings; Terraform wiring is a follow-up. Examples are generic; real attribute names stay in the private repository.

```yaml
# retention:
#   per_user_months: 13               # 1 to 36
#   login_history_months: 24          # 1 to 60; audit history, purged only after this age
# privacy:
#   min_group_size: 5                 # floor 5, applies to every scope
# access:
#   break_glass_group_id: ""          # Entra group object ID, or empty
#   permission_freshness_minutes: 5   # 1 to 60
# directory:
#   department_attribute: ""          # example: department. Empty disables the department scope
#   business_area_attribute: ""       # example: onPremisesExtensionAttributes.extensionAttribute1. Empty disables the business_area scope
#   empty_attribute_threshold_percent: 20
```

## 14. Access-model review notes

- Order between grants, directory revocations and unlinks comes from `event_seq` (`AccessGrant`, `GrantRevocation`) and `unlink_seq` (`PrincipalLinkState`), all drawn from the database-wide sequence `portal.seq_access_event`, never from timestamps (which can tie, so they stay `DATETIME2(7)` for display only). `portal.v_active_grant` hides a grant when a revocation or unlink has a higher position; a later re-grant has a higher position again and is visible. An unlink without a sequence is rejected by `CK_PrincipalLinkState_pair`, and the view hides the grant if one ever appears. Writers need UPDATE on the sequence to draw a value.
- Entra columns of `Principal` are not directly updatable. `portal.usp_link_principal_entra` (EXECUTE for the portal writer) fills a missing Entra ID once (dual-provider linking, decision record §13.1); it never reassigns or clears one.
- `validateSettings` rejects a non-object root or a supplied non-object section; omitted sections keep defaults.

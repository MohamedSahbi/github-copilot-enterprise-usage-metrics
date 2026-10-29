# Data contracts (D-47)

Status: proposed with the contracts PR. Companion to [decision-record.md](decision-record.md) (§6, §6.5, §13.6). Types are in `shared/src/`, SQL in `db/migrations/`. A change to any contract lands in `shared/` first, in its own PR.

**Architecture boundary (owner revision 2026-10-25, #66):** the new solution runs independently in a separate database; the old solution is untouched during parallel operation. Historical v1/v2 budget descriptors below do not require compatibility shadow tables in the new database. The live Budget Lookup request/response contract is defined in `shared/src/api.ts` under D-55/#94 and does not use the old database or a SQL fallback.

Verification legend: **V** = verified against a recorded sample or the enterprise docs; **A** = assumption, not verified (listed again in the PR).

## 1. Settings (deployment settings, not SQL rows)

| Setting | Default | Meaning |
| --- | --- | --- |
| `retention.per_user_months` | 13 (1 to 36) | Per-user rows and PII are purged after this window (D-12) |
| `retention.aggregate_months` | unlimited | Aggregates kept indefinitely (D-12) |
| `retention.login_history_months` | 24 (1 to 60) | `dim_user_login_history` is purged only after this maximum age; explicit exception to the per-user rule (§11) |
| `privacy.min_group_size` | 5 (floor 2; app setting `MIN_GROUP_SIZE`) | Groups below this size are suppressed for every scope, including business area (§6.3) |
| `privacy.per_user_detail` | off | Named users in responses (see §6) |
| `staging.retention_days` | 14 | Staged rows of published or failed runs are deleted after this; quarantined runs are kept until an admin acts |
| `access.break_glass_group_id` | empty | Entra group whose members reach admin and health pages when permissions cannot be read (D-17). Empty or a GUID. A setting, not a table |
| `access.permission_freshness_minutes` | 5 (1 to 60) | Maximum age of the permission data before the portal fails closed (D-17) |
| `directory.department_attribute` | empty | Entra attribute (Graph path) that holds the department. Empty = department scope disabled |
| `directory.business_area_attribute` | empty | Entra attribute (Graph path) that holds the business area. Empty = business_area scope disabled |
| `directory.empty_attribute_threshold_percent` | 20 | An enabled attribute that is empty for more than this share of users records the `attribute_empty_share` ValidationIssue |
| `backfillFrom` | omitted | Optional inclusive metrics backfill start; validated at startup/run against `max(2025-10-10, UTC today - 365 days)` through UTC today. Invalid, future, or expired values fail validation, never clamp. Omission does not request historical fetching. Raw imports are not subject to API availability (D-23). |
| `organization.directory_provider` | `entra` | Existing Terraform input, emitted as `DIRECTORY_PROVIDER`; `entra` selects Graph, `csv` selects operator-supplied CSV. No separate provider setting and no automatic switch on Graph failure (D-4). |

`validateSettings(input, today?)` accepts an injectable UTC calendar date for deterministic validation;
production callers omit it. `backfillFromSchema` and `DirectoryProviderSchema` are the canonical Zod
schemas for these additions. The metrics runtime contract reuses `backfillFromSchema`; it does not
change the existing `validateSettings` or backfill schema behavior.

Metrics ingestion has a separate `MetricsRuntimeSettings` contract in
`shared/src/metrics-runtime-settings.ts`. It validates `GITHUB_APP_ID` (positive decimal,
nonsecret), the comma-sourced organization identities, `SQL_SERVER`, `SQL_DATABASE`,
`AZURE_CLIENT_ID`, `RAW_ARCHIVE_ACCOUNT`, `RAW_ARCHIVE_CONTAINER`, and optional `BACKFILL_FROM`.
The GitHub App private key is deliberately absent from the shared contract: Terraform binds the
existing `github-app-private-key` Key Vault secret only to the ingestion app, using that app's
existing Key Vault reference identity and secret-scoped access. `AUTH_GITHUB_ID` remains the
separate portal OAuth identifier.

Terraform requires `github_app_id` for every stack, including deployments that reference existing
SQL or resource groups. Existing deployments must add this nonsecret input to each environment's
private tfvars before applying the updated stack; new stacks set it in their initial tfvars. The
stack does not read or set the private-key value. `backfill_from` is omitted unless a historical
fetch is requested; Terraform validates its static calendar-date form, while runtime validation
enforces the current API-start and rolling 365-day limits.

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
| `ai_credits_used` | `ai_credits_used` | DECIMAL(18,9) | no | Absent/null → exact string `"0"`; numeric JSON tokens preserved losslessly; never rounded |
| `ai_adoption_phase{phase_number,phase}` | `ai_adoption_phase_number`, `ai_adoption_phase` | TINYINT / VARCHAR(64) | yes | Existing mapping |
| `ai_adoption_phase.version` | `ai_adoption_phase_version` | VARCHAR(64) | yes | Preserved as a validated string in staging and daily facts; absent/null remains NULL; reject values that exceed 64 characters or cannot round-trip losslessly under the target SQL collation |
| `totals_by_ide[]` | breakdown `ide` (key_1 = ide) | | | `last_known_ide_version` and `last_known_plugin_version` → `version_info` (compact JSON of the documented string fields, NULL when absent) |
| `totals_by_feature[]` | breakdown `feature` | | | |
| `totals_by_language_feature[]` | breakdown `language_feature` (key_1 language, key_2 feature) | | | No interaction count in source → 0 |
| `totals_by_language_model[]` | breakdown `language_model` | | | |
| `totals_by_model_feature[]` | breakdown `model_feature` | | | |
| `totals_by_cli`, `totals_by_copilot_app`, `totals_by_vscode_agent` | breakdown `client` rows (`copilot_cli`, `copilot_app`, `vscode_agent`) | | | Optional objects (upstream `CopilotClientUsageTotals`): `session_count`, `request_count` → INT; `token_usage.prompt_tokens_sum` / `output_tokens_sum` → `prompt_tokens`, `output_tokens` (BIGINT); `last_known_cli_version` → `version_info`. Supplied counts are validated (`negative_count`); absent/null counts remain NULL. `avg_tokens_per_request` is not staged |
| `totals_by_cli.prompt_count`, `totals_by_copilot_app.prompt_count` | breakdown `prompt_count` | INT | yes | Client keys `copilot_cli` / `copilot_app`; validated range 0..2147483647, zero distinct from NULL |
| `totals_by_vscode_agent.total_user_messages` | breakdown `total_user_messages` | INT | yes | Client key `vscode_agent`; validated range 0..2147483647, zero distinct from NULL |
| `totals_by_skill`, `_custom_agent`, `_mcp`, `_slash_cmd`, `_plugin` | `fact_usage_family_count` (family, name, count) | | | |
| any other field | `extra_json` (daily) | | | Warn `unknown_field`, load. `totals_by_client` is not in the pinned upstream types and is not staged |

Language names are normalized with the upstream language normalizer before loading (oracle parity).

### Restoration schema and compatibility boundary (#120)

Migration `20261026010000` adds nullable `ai_adoption_phase_version VARCHAR(64)` to
`portal.stg_user_daily` and `portal.fact_user_daily_usage`, and nullable `prompt_count INT` and
`total_user_messages INT` to `portal.stg_user_breakdown` and `portal.fact_usage_breakdown`.
Version width is 64 bytes, matching the existing phase label's VARCHAR width; no numeric version
or inferred label is substituted. Both counters use the existing INT activity-count range
0..2147483647, enforced by SQL type and non-negative checks. No defaults, new indexes, or
historic updates are added. All six columns permit NULL; existing rows remain unavailable NULL.

Shared staging row properties are **required and nullable**; daily facts inherit the version
property. The Functions parser and reference mapper validate and preserve supplied source values;
missing/null remains NULL and measured zero remains zero. Before staging, the loader checks phase
version strings against the target database collation and rejects values that cannot round-trip
losslessly through `VARCHAR(64)`. The loader sends staging bulk values by the explicit column
registries, not JavaScript object insertion order, and publishes these fields to their matching
fact columns. Exact-credit VARCHAR transport and SQL-server DECIMAL conversion are unchanged.

**#121** implements source extraction and validation, missing/null/zero distinctions,
staging-to-fact publication, and reference source mapping. Discarded historic values remain unavailable:
no fabricated zeros, replay, backfill or data migration is authorized. Future API consumption and
parity remain separate work with #115/#119 owners; neither #120 nor #121 implements API consumption
or promises historic parity. In particular, #119's feature-backed IDE fix does not recover the
prompt-only oracle case. Scope approval does not authorize merge, migration application outside
throwaway local tests, deployment or activation. The existing restore/rollback and deployment gates
remain in force.

SQL-row `ai_credits_used` is an exact decimal **string** in staging and inherited fact types
(owner-approved correction to the former `number` contract, issue #45). The reference mapper uses
Node 22's JSON reviver source token, including exponent notation, to avoid binary floating-point
conversion. Non-negative values must fit DECIMAL(18,9) exactly or are rejected with `negative_count`;
numeric strings in NDJSON are not accepted as numeric tokens. Conversion to a number happens only
at the display/upstream-oracle boundary; public numeric display DTOs and metric version 1 are unchanged.

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

CSV parsing accepts quoted commas, escaped quotes, multiline cells, LF/CRLF, and a final record
without a newline. Empty physical records are ignored without renumbering source lines. Unclosed,
misplaced, or followed-by-text quotes, duplicate/empty headers, and missing required headers are fatal
`unsupported_schema` errors: no rows or multipart duplicate state are committed from that part.
Wrong-width records are rejected as `malformed_json`. Every supplied decimal must fit
DECIMAL(18,9) exactly (`negative_count` otherwise), canonicalized to plain decimal notation for SQL.
The existing non-negative constraints on quantity, gross amount, and AIC quantity remain; signed
adjustment amounts in the other columns remain supported. Supplied token counts must be non-negative safe
integers, never silently converted to NULL. Empty optional decimals/counts remain NULL.

The reference duplicate key uses a JSON tuple, so embedded delimiters cannot alias other tuples.
SQL keys use concatenated `DATALENGTH(value):value` NVARCHAR frames (UTF-16 byte lengths), ordered as
organization, username, model, cost center, repository, app client, sku; aggregates use organization,
model, cost center. Date (and staging run) stay outside the hash in the unique key. NULL sku still
equals empty sku. Migration `20261026001200` atomically rebuilds the three persisted hash columns
and their unique indexes/primary keys, rehashing existing rows; it is safe to rerun. Schedule a
maintenance window because persisted-column and clustered-key rebuilds rewrite/lock the tables.
Rows rejected by old collisions are not recoverable from SQL: replay their archived sources separately.

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
| `used_copilot_app` | Upstream derives it as the flag OR `totals_by_copilot_app` present OR a `copilot_app` feature row OR `copilot_app` IDE activity; ingestion applies the same derivation at load. The `kind=ide` read model normalizes App rows at organization/user/day grain: feature interactions replace raw App IDE interactions (including measured zero); otherwise positive raw interactions are retained, while non-positive raw interactions use persisted non-NULL `prompt_count` when available and retain the raw value when it is NULL. An absent raw row is synthesized only from a non-NULL client prompt count; a NULL prompt count is not synthesized as zero, and an activation flag alone does not create an App IDE row. These last two cases remain unsupported. Each user's daily source is selected before grouping to prevent double counting. Other IDE rows are unchanged, and the default minimum-group suppression still applies. Client session/request/token counts are not substitutes for prompt counts. Historic NULLs remain NULL in storage; no replay/backfill is included. | `app_users` derivation agrees. Feature-backed IDE recovery was compared against the strict five-user oracle in #123. Prompt fallback from non-NULL persisted counts is covered by focused real-SQL regressions; NULL-prompt rows without raw activity and activation-only rows remain unsupported. The pinned upstream parser's per-user precedence is in `portal/upstream/src/domain/metricsParser.ts` (`addCopilotAppClientTotal`). A one-user prompt-only result remains suppressed and is not a visible API parity expectation. |
| `used_coding_agent` | Upstream sets both coding-agent flags from `used_copilot_cloud_agent` only; ours stores the same value in `used_coding_agent` and `used_cloud_agent`, ignoring the source `used_copilot_coding_agent` field. | Oracle parity for `coding_agent_users` |
| Language | Upstream normalizes language names at parse time; ours normalizes at load. | Same function applied in the loader |

The SQL/upstream oracle coverage and its known limits are tracked in `scripts/contracts/oracle/coverage.md`. The fixture's one-user prompt-only `copilot_app` fallback is suppressed by the API's minimum group size; a separate five-user feature-backed comparison remains strict against the SQL reconstruction merged in #123.

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
| Budget Lookup | optional read-only user-budget module; authenticated self or authorized numeric target; Budget-only self detail exception, other users need scope AND detail enabled; live GitHub reads, no SQL/old-database fallback (D-55, §17) | same |
| Admin | principals and grants (admin role) | same |
| Feedback | items per visibility; author shown as display name only to admins | same |
| Health | status only, no data | same |

Date ranges are bounded (max 400 days) and page sizes are bounded (max 100, default 50).
Both date boundaries must be real ISO calendar dates; rollover dates such as `2025-02-31` are invalid.

## 7. Directory contracts and historical budget descriptors (D-29, D-34)

**New runtime:** `portal.dim_user` is keyed on the numeric GitHub ID; login/email are mutable attributes. Its manager Entra ID, recognition email, department and business area support the current hierarchy/scopes. Reuse `portal.DirectorySyncState` and the existing link/revocation model. One logical `ingestion` component is the sole writer of `dim_user` and login history; directory sync owns directory attributes and hierarchy/link/revocation state through it. Metrics and directory must not become independent writers of shared rows. #69 inventories missing row/input contracts and #70 adds only justified persistence deltas; neither must recreate the old directory shape. A partial run must not advance successful directory state.

The component SQL boundary keeps that single logical writer while separating runtime permissions. `portal_directory_ingest` can write the current directory identity/profile, manager-resolution marker, ingestion-run and sync-state surfaces. `portal_metrics_ingest` retains the metrics run/staging/dimension/history/fact/checkpoint surfaces, but writes `dim_user` observations only through `portal.usp_write_metrics_users(@run_id)`. The procedure projects only staged numeric user ID, login and usage day; it requires the caller's SERIALIZABLE publication transaction and preserves its day lock. Component roles are not identity mappings: neither narrows an identity that still inherits `portal_ingest` or another role. Preflight and later runtime mapping are separate operational gates. Directory link/revocation/audit writers outside the current component consumer require their own reviewed permission extension; no access to those portal-owned surfaces is granted here.

Under D-47, the contract lands before its Functions consumer. The metrics user writer now calls the shared executable command through the caller's transaction, before the unchanged login-history write; it no longer directly updates or inserts `dim_user`. Hosted integration tests exercise the real day loader with a separate login in only `portal_metrics_ingest`. The legacy `portal_ingest` permissions remain unchanged until a subsequent small hardening migration PR removes its direct `dim_user` writes. Deployments must quiesce consumers and coordinate the reviewed migration/package/role switch; the one-time legacy Blob import uses only the narrow metrics role after this switch. Runtime isolation through the legacy role is not established, and deployment remains separately authorized.

**Historical/external reference:** the old budget Functions (outside this repo) read `dbo.CopilotUserDirectory`, `dbo.ManagerHierarchy` and `dbo.HierarchySyncRun` in their own database. The code-derived v1 descriptors (`shared/src/directory-contract.ts`, `DIRECTORY_CONTRACT_V1`) and tests document that old contract. v2 describes a proposed numeric-GitHub-ID re-keying of that external directory, not the `portal.dim_user` SQL row shape. These executable descriptors/tests remain unchanged here. Old budget consumers do not adopt v2 as part of independent Phase 2 operation; #43 is a deferred integration decision, not a new-directory dependency.

No v1-compatible shadow tables, runtime old-database comparison access or old-system changes are required. `github_license_type` remains nullable/unsourced wherever retained; do not add `consumed-licenses` (D-38). Reconciliation still needs explicitly authorized evidence with provenance, coverage and differences (#79/#80), not an assumed live comparison identity. Final migration/source access remains a separately approved end-stage operation.

## 8. Old structure → new portal schema (generic names)

| Old (SQL DDL derived from the code; owner-confirmed correct, since the database is only ever changed by the migration script) | New | Note |
| --- | --- | --- |
| Directory table, PK login, id nullable text | `portal.dim_user` (PK numeric ID) + login history | New database's stable-ID runtime; not an adoption of the external v2 table descriptor |
| Directory: email, display name, department, business area, manager | `portal.dim_user` attributes and manager Entra ID/recognition email | Owned by directory sync through ingestion |
| Directory: account status, deletion GUID | `dim_user.state`, `deleted_at` | |
| Directory: license/plan, pending cancellation, last activity | Historical/external budget descriptors; not implicitly required in new portal rows | #69 must justify any new runtime field; license type stays unsourced/nullable wherever retained |
| Access control (email PK, role, scope, comma lists) | `portal.Principal`, `PrincipalIdentity`, `AccessGrant` | Conflicts with D-5 (email key); one row per grant |
| Manager hierarchy (two emails + login + name) | Current manager-ID relationships on `portal.dim_user` | Old email-keyed hierarchy remains untouched; no compatibility copy required |
| Hierarchy sync run | `portal.DirectorySyncState` in the new database | Old `HierarchySyncRun` stays with old consumers; never mark a partial new sync successful |
| Audit log (two writers) | `portal.AuditLog` (portal only) | Old audit table unchanged; copy only portal-originated history during final approved migration |
| Feedback item, vote, comment | `portal.FeedbackItem`, `FeedbackVote`, `FeedbackComment` | |
| Budget entity, allocation, membership, failures | Old system unchanged | Budget Lookup reads GitHub live under D-55; no old-database access or new budget tables. Budget and cost-center writes remain out of scope |
| Table-storage budget tables | out of scope | Legacy |

Historical mapping concerns: old email/login keys and two-writer audit do not justify reproducing those structures in the separate new database. Stable-ID access/hierarchy and internal single-writer rules remain (D-5, D-34, D-36); legacy `enhanced` files remain ignored (D-28). The mapping is not authority to extract or migrate old data; final migration takes place at the end under a separately approved plan.

Historical source token types (owner-confirmed): every GitHub endpoint used by the old solution (users-1-day report, billing export, seats, `orgs/{org}`, SCIM) is called with a personal access token held in Key Vault. This does not supersede the new solution's D-9/D-37 credential boundary or #64/#67 gates.

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
- Team scope is resolved from the manager's Entra object ID (`dim_user.manager_entra_object_id`). The manager's email is always stored alongside (`manager_email`) for recognition, never as an authorization key. The historical v2 `Manager` email descriptor is not a new runtime dependency.
- Entra disable (D-34 one writer): the directory sync (ingestion) cannot write portal-owned tables, so it appends `PrincipalLinkState.unlinked_at` and a `GrantRevocation` row, and audits to `IngestionAuditEvent`. Soft only, never deletes. The portal reads grants through `portal.v_active_grant`, which hides grants granted at or before a revocation or unlink. A re-enabled user needs new, audited grants.
- Historical exact-grant conflicts are checked only by `portal.usp_has_revoked_grant_conflict` (migration `20261028042100`), a denial-only contract that accepts tenant ID, Entra object ID, role, scope and scope value and returns only a `BIT` conflict status for an exact `AccessGrant` row with `revoked_at IS NOT NULL`. Text dimensions are byte-exact (case- and trailing-space-sensitive). Inputs exceeding the stored bounds (12 bytes for role, 16 bytes for scope, 128 UTF-16 code units for scope value) are rejected, never truncated into a match; callers must bind full-width inputs so validation can see overflow. `GrantRevocation` is identity-lifecycle evidence, not per-grant evidence. Callers must first use `portal.v_active_grant` for effective grants, then invoke this contract within their existing SERIALIZABLE transaction while holding the existing transaction-owned exclusive `ingest:directory` lock; the procedure fails closed without either precondition and takes no transaction or lock of its own. It cannot grant access or replace the active-grant view. Only `portal_writer` receives object-level `EXECUTE`; no grant-history `SELECT` permission is added.
- Settings `access.break_glass_group_id` and `access.permission_freshness_minutes` are deployment settings (§1); `BreakGlassConfig` is dropped.

### Grant API

`POST /api/admin/grants` (admin only): request `AdminGrantCreateRequest`, response `AdminGrantCreateResponse`, errors `AdminGrantErrorResponse` with codes `scope_disabled`, `invalid_role_scope`, `unknown_scope_value`, `principal_not_linked`. Check order: pair, scope enabled, principal linked, scope value. The admin form loads `AdminGrantFormData` (role/scope matrix, enabled scopes, distinct directory values). All in `shared/src/api.ts`.

## 10. Directory attributes (issue #44 item 6)

The directory sync reads `directory.department_attribute` and `directory.business_area_attribute` through Graph, trims, collapses whitespace and lower-cases the values (`normalizeDirectoryValue`), and writes them to `dim_user.department` and `dim_user.business_area`. An empty attribute setting disables that scope: nothing is read, the grant API answers `scope_disabled`. When an enabled attribute is empty for more than `directory.empty_attribute_threshold_percent` of users, the sync records a `attribute_empty_share` ValidationIssue (`attributeEmptyShareExceeded`). Values longer than the runtime columns (100 characters for department, 50 for business area) are a data issue for the sync to report; the historical external directory descriptors are not the runtime width authority. No company-specific attribute names or values belong in this repository.

### 10.1 Runtime directory inventory and input delta (#69)

The inventory below is against the existing new-database migrations and `shared/src/rows.ts`,
not the historical budget descriptors. No new SQL columns, tables, statuses, tenant foreign keys,
principal identity updates or old-consumer compatibility are required by this PR.

| Required field / capability | Existing contract or explicit delta |
| --- | --- |
| Numeric GitHub ID, mutable login | `DimUserRow.user_id`, `login`; directory input requires a positive safe integer ID, never an email/login identity key |
| Entra identity | `DimUserRow.entra_object_id`; canonical directory input requires a GUID. Unmapped metrics users remain supported by the existing nullable SQL field; they are not fabricated directory matches |
| Email, display name | Existing nullable `email` (320 UTF-16 units), `display_name` (255); optional input |
| Manager identity and recognition | Existing nullable `manager_entra_object_id`, `manager_email` (320); no email-based manager identity matching |
| Department, business area | Existing nullable columns (100/50); canonical input normalizes values using `normalizeDirectoryValue` |
| GitHub account state | Existing `active`, `deleted`, `suspended`; no new `AccountStatus` taxonomy. Sync sets `deleted_at` when transitioning to deleted, and owns reactivation/PII retention |
| Explicit Entra disable evidence | New transient `entra_account_enabled` boolean in canonical input, not a SQL column. Kept separate from GitHub `state`; false supplies disable evidence to the existing unlink/revocation workflow, never permission to grant |
| Observation/deletion/purge timestamps | Existing `first_seen_day`, `last_seen_day`, `deleted_at`, `pii_purged_at`, `updated_at`; supplied by the ingestion lifecycle, not CSV overrides |
| Login history | Existing SQL table; missing shared `DimUserLoginHistoryRow` and column registry added, no DDL |
| Link, unlink and revocation ordering | Existing `PrincipalLinkStateRow`, `GrantRevocationRow`, `UnlinkReason`, sequence-based ordering and `IngestionAuditEventRow`; no replacement lifecycle model |
| Source freshness | Existing SQL `DirectorySyncState`; missing shared `DirectorySyncStateRow` and registry added with exact existing `scim`, `graph`, `csv`, `seats` values and nullable timestamps/error code |
| Old job title, manager name, seat-plan/activity/cancellation fields | Historical descriptors only; no target runtime consumer requires a duplicate column in this issue |
| `github_license_type` | Remains nullable/unsourced in historical descriptors; absent from `dim_user`. No consumed-licenses calls or inferred license values |

One logical **ingestion** component is the sole SQL writer of `dim_user` and login history.
Directory sync owns directory attributes, hierarchy and link/revocation lifecycle through it;
metrics observations cannot overwrite these fields. Principal Entra columns remain immutable with
the existing one-time linking procedure and tenant FK unchanged. Permissions never come from CSV
emails, logins, provider choice or account state alone.

`DirectoryUserSchema` (Zod, inferred `DirectoryUser`) is the normalized adapter output.
Graph/SCIM/seats wire schemas belong beside future Functions adapters unless reused by another
package; no speculative response schemas are introduced here. The inline synthetic fixture in
`ingestion-contracts.test.ts` validates this shared output. Verified AI Credits fields, exact-decimal
strings, mapping and numeric display DTOs are unchanged.

### 10.1.1 Per-user manager resolution evidence (D-47)

Migration `20261027092500` adds two required properties to `DimUserRow` and its
`TABLE_COLUMNS` registry:

| Column | SQL type | Meaning |
| --- | --- | --- |
| `manager_resolved` | `BIT NOT NULL DEFAULT (0)` | Whether this user's latest manager/profile attempt completed authoritatively, including an authoritative no-manager result |
| `manager_checked_at` | `DATETIME2(0) NULL` | UTC time of that user's latest manager/profile attempt; NULL means no recorded attempt |

Directory sync owns both fields through the single ingestion writer. On a successful check it
sets the flag true and records the attempt time, with the current manager identity/recognition
attributes (or NULL for an authoritative no-manager result). On that user's failed or incomplete
attempt it sets the flag false and records the attempt time while retaining the stored manager
adjacency. An attempt timestamp alone is not evidence of success. Metrics observations must not
set or refresh these fields.

The migration preserves all existing attributes and relationships. Preexisting users and new
metrics-only rows start with false/NULL; no historic backfill fabricates resolution. The timestamp
has no default. This is a persistence/row contract only: `DirectoryUserSchema`, `DirectoryUser`
and the CSV headers remain unchanged; evidence is maintained by the sync, not supplied in CSV.

Team eligibility requires positive evidence for each traversed user-to-manager edge:
`manager_resolved = 1` and a non-NULL timestamp within the existing configurable directory stale
threshold (default 36 hours), allowing at most the existing 500 ms SQL timestamp-rounding
tolerance into the future. Missing, stale, or later timestamps do not qualify. Only eligible
edges participate in direct/indirect team traversal; unaffected users' fresh resolved edges
remain eligible when another user's attempt makes source-level sync status incomplete.
Source-level state never substitutes for per-user evidence, and a retained relationship alone
does not establish eligibility.

Under D-47 this contract merges before the separate consumer work: ingestion evidence writes,
team-grant filtering and every recursive SQL edge gate. This prerequisite PR does not implement
those consumers, change CSV input, or authorize deployment, backfill, migration application,
or access to live directory services.

### 10.2 CSV directory contract

`parseDirectoryCsv(Uint8Array)` validates the complete file and returns `DirectoryUser[]`, or throws
`DirectoryInputError` without returning partial rows. This is input validation, not a sync/publisher
or authorization implementation.

- Encoding: strict UTF-8, optional initial UTF-8 BOM; malformed bytes, UTF-16/32 and NUL characters
  are rejected. No lossy replacement or guessed encoding.
- Exact, case-sensitive headers, in any order: required `user_id`, `entra_object_id`, `state`,
  `entra_account_enabled`; optional `login`, `email`, `display_name`, `manager_entra_object_id`,
  `manager_email`, `department`, `business_area`. Empty, duplicate, unknown or missing headers fail.
- Cells are trimmed. Optional omitted/empty cells become null; nonempty strings must fit the
  existing SQL widths. IDs use decimal digits (positive safe integer) and GUIDs. `state` uses the
  existing three lowercase values. `entra_account_enabled` accepts only literal `true`/`false`;
  missing evidence is not inferred from GitHub suspension, missing rows or failed provider reads.
- Commas, doubled quotes, quoted multiline cells, LF/CRLF and no final newline are supported.
  Empty physical records are ignored, preserving physical line numbers; wrong-width records and
  malformed quoting fail. A header-only file parses as an empty snapshot, not evidence of success,
  deletion or revocation. Completeness and lifecycle actions remain the sync's responsibility.
- Duplicate numeric IDs or Entra GUIDs (case-insensitive) reject the entire current-identity
  snapshot. Historical/recreated-account rows belong in SQL/history, not duplicate current mappings.
- Typed errors expose only `code` and nullable 1-based physical `lineNumber`:
  `invalid_encoding`, `invalid_csv`, `invalid_header`, `invalid_row`, `duplicate_identity`.
  Messages retain no row, field value or Zod error payload. Future ingestion must record these as
  failed input, never advance `DirectorySyncState.last_success_at`, and use privacy-safe audit
  metadata (#50 L5); they are not new `ValidationIssue` SQL enum values.

Hierarchy completeness/cycle checks, source disappearance, pagination failures and link/revocation
transactions remain dependent sync behavior. No implicit fallback on Graph error or missing-row
disable is authorized. Source-specific evidence gates (#65/#67) remain in place.

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
#   min_group_size: 5                 # floor 2, applies to every scope
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

## 15. Core-view API and DTO contract

The portal-owned TypeScript request and response types live in `shared/src/api.ts`. They describe the approved core-view boundary; they do not by themselves add routes or query behavior. Existing reporting periods remain `last_7_days`, `last_28_days`, `last_90_days`, and a completed `calendar_month`. The existing page-size, error-envelope, correlation-ID, and cache-control conventions remain in force. No arbitrary date range is introduced.

### Scope selection and permitted options

`CoreViewScopeSelection` describes the selectable scopes. `self`, `team`, and `company` carry no caller-provided root or value; `department` and `business_area` carry only a value. A selector is a narrowing request, never an authorization grant. Authorization is resolved on the server from the caller's existing principal and grants (D-5, D-17). Team is the caller's current direct-and-indirect reporting tree (D-16), never a caller-selected root.

The existing usage overview, breakdown, and users-summary requests compose the fixed `UsagePeriodRequest` with an optional `CoreViewScopeSelection` as `ScopedUsagePeriodRequest`. The canonical query encoding is `scope=self`, `scope=team`, or `scope=company` without `value`; `scope=department&value=<value>` or `scope=business_area&value=<value>` carries exactly one non-empty value. `parseCoreViewScopeSelection` rejects a missing or unknown discriminator, a value without a scope, a value for self/team/company, a missing value for department/business_area, and repeated scope or value parameters with `invalid_request`. `serializeCoreViewScopeSelection` emits the discriminator before the optional value, using `URLSearchParams` encoding. An omitted selection emits no scope parameters and preserves existing request behavior. Fixed periods, calendar-month values, and `organizationIds` retain their existing rules.

The option set is derived from current directory values among the SQL `AuthorizedUsers` population, then intersected with current directory options. Per-option population counts come from that same authorized population; `intersectCoreViewScopeOptions` requires those counts, applies the configured minimum (default 5, with the §6 floor), and returns only option values, never counts. It omits values below the minimum and returns an unavailable result with no options if authorization, directory options, or required counts are unavailable or incomplete. A company grant may narrow to a department or business area only by filtering that same authorized population; selecting a value never expands it. Empty available options are distinct from unavailable options. These options are presentation data and must never be used as the SQL authorization predicate.

### Availability and independently disclosive cohorts

`CoreViewMetric<T>` and `CoreViewCohort<T>` distinguish four states:

| `availability` | Meaning | Wire value |
| --- | --- | --- |
| `available` | A metric was measured; zero is a valid measured value. | Exact typed value; cohort count is visible only when permitted by §6. |
| `not_reported` | The source did not report the field or supplied NULL. | `value: null`; never substitute zero. |
| `unavailable` | Required source data was discarded or is not persisted. | `value: null`, reason `source_discarded`; never infer from another metric. |
| `suppressed` | The cohort is below the applicable privacy minimum. | `userCount: null`, `value: null`; hide labels and all dependent values. |

Every separately disclosive cohort has its own wrapper and boundary: daily participation and peak-day counts; top-decile subset counts, metrics and shares; each top-N model, client, language, version and phase entry; CLI totals; IDE/CLI overlap; and each feature-adoption count. A top-N key/label is nested inside the cohort value so a suppressed entry does not reveal its label. Apply the configured minimum group size (default 5) consistently, as specified in §6; do not use a visible parent count to expose a smaller child cohort.

Derived values require all their inputs to be available. Suppressed inputs propagate suppression; discarded inputs propagate unavailability; source-not-reported inputs remain not reported. Never recompute a statistic from only the visible subset or infer a value from a hidden total. `deriveCoreViewMetric` applies this dependency rule before invoking the calculation. The same rule applies to peak-day selection, top-decile shares, IDE/CLI overlap percentages and any future derived statistic.

### Metric sources and unavailable fields

The core-view DTOs use curated SQL only (D-11): `portal.fact_user_daily_usage` for daily usage, user-level feature flags and exact AI-credit facts; `portal.fact_usage_breakdown` for feature, model, client, language and IDE cohorts; and current `portal.dim_user` rows for identity attributes and scope values. The source mappings and adoption definitions in §§2 and 4 remain authoritative. Upstream charts and calculators remain read-only presentation/oracle dependencies (D-14, D-15, D-22); do not edit the submodule or derive authorization from upstream data.

`CoreViewMetrics` separates daily participation, peak-day data, top-decile subsets and shares, top-N entries, CLI totals, IDE/CLI overlap and feature-adoption cohorts. Each metric is independently available, not reported, unavailable or suppressed. It does not expose a direct client `prompt_count` metric: the nullable value is persisted in client breakdown rows and used for the Copilot App `kind=ide` fallback, but is not exposed by the client API DTO or treated as a discarded source. `ai_adoption_phase.version` and VS Code agent `total_user_messages` remain unavailable with reason `source_discarded` until their source fields are restored. Do not represent a missing source as measured zero, infer it from another field, or present it as a suppressed cohort.

### Exact AI-credit values and arithmetic

Source-row credits retain the canonical exact `DECIMAL(18,9)` range. SQL aggregate sums use `DECIMAL(38,9)` and may have up to 29 integer digits; the source-row bound does not apply to a grouped sum. Source and aggregate wire values are decimal strings. Never transport credits through a JavaScript `number` or call `Number(...)` before API serialization.

Derived averages and percentages use exact decimal intermediates and round only the final result to scale 9 using half-up rounding. A zero denominator yields `null`. An overflow raises the typed `DecimalOverflowError` (`decimal_overflow`) and the API returns a typed error envelope with no partial data or success-shaped response. `exactDecimal38_9`, `averageDecimal`, and `percentageDecimal` implement the bounded decimal contract; their inputs and outputs are decimal text.

The existing `UserUsageRow.aiCreditsUsed` and `/api/users` response use this same string contract. In `getUserUsage` only, convert `SUM(f.ai_credits_used)` to `VARCHAR(40)` in SQL before the `mssql` driver can round `DECIMAL(38,9)` to a JavaScript number, then return that string unchanged. The existing users table may convert it to a number only in its display formatter, retaining the current `en-US` formatting with at most one fractional digit. This does not change route authorization, periods, paging, filters, response metadata, or the separate `kind=ide` query.

## 16. Metrics reconciliation comparison contract (#79, D-10, D-29, D-34, D-47)

Contract code: `shared/src/reconciliation.ts`. This section covers the **metrics per-day slice only**. Directory comparison needs its own contract PR once the legacy directory evidence source and its access are decided; #79's directory criterion stays open until then. The implementation (reading SQL, computing checks, writing reports) is separate follow-up work that depends on this contract and on the legacy raw-metrics import.

### Evidence kind and its limit

The only accepted evidence kind is `legacy_raw_ndjson_manifest`: a manifest an operator computes from one legacy raw users-1-day NDJSON file (`{YYYY}/{MM}/raw/UsageMetrics-{dd-MM-yyyy}.json`) for one `(organization_id, report_day)`. Because the one-time import loads those same bytes, a match proves **load fidelity** (legacy bytes → archived artifact → published facts). It does **not** prove that the new metric definitions equal what the legacy portal displayed; the upstream test oracle (§4) covers definitions. Legacy enhanced files, legacy SQL totals or any live source are not accepted until a later contract adds them.

The manifest is untrusted operator input, validated by a strict schema (`parseEvidenceManifest`). It is a file supplied to the run: there is no runtime cross-database reader, no old-system write, no cutover and no source-access authorization. `approvalRef` is an opaque reference to the owner's separate approval, held in the private evidence location; the contract does not grant or check access. An invalid manifest is reported as incomplete evidence, never as a match (`evidenceAvailabilityCheck` derives the `evidence_available` check from the parse result only).

The manifest is an **operator attestation, not independent proof**: the contract validates shape and bounds, not truth. The implementation must produce it with a tool that computes every claim from the legacy raw bytes, and should also recompute the new-side comparison inputs (counts, totals) from the archived blob of the loaded artifact, so a mistaken or forged manifest alone cannot yield a match. Private evidence handling stays an owner decision.

| Manifest field | Notes |
| --- | --- |
| `schemaVersion`, `evidenceKind`, `organizationId`, `reportDay` | `schemaVersion` is `1`; the day must be a real calendar date |
| `availability` | `available`, `unavailable`, `unauthorized` or `incomplete`. Only `available` may carry `artifact`, `totals` or `perUser` |
| `provenance` | Generic `sourceLabel`, `retrievedAt`, `toolVersion`, and `approvalRef` (required when `available`) |
| `artifact` | `sha256` (lowercase hex), `sizeBytes`, `nonEmptyLines` (same definition as `SourceArtifact.row_count`), `jsonObjects`, `distinctUserKeys`, `duplicateUserKeys` |
| `totals` | Sums of the seven additive daily measures (integers) and `ai_credits_used` as a canonical exact decimal string (never a JavaScript number) |
| `perUser` (optional, **private**) | Per-user measures keyed by numeric `user_id`; allowed only when there are no duplicate keys and the count equals `distinctUserKeys` |

### Checks and outcomes

Required checks: `evidence_available`, `run_published`, `lineage_sha256`, `lineage_size`, `row_count`, `rows_accounted`, `distinct_users`, `totals`. `per_user` runs only when the manifest carries per-user rows. The new side is read from the new database only: the current published `IngestionRun`, `SourceArtifact`, `ValidationIssue` counts and `portal.fact_user_daily_usage` (`MetricsDayObserved`).

| Outcome | Meaning |
| --- | --- |
| `matched` | Legacy and new values are equal |
| `explained` | Differ, and new-side evidence supports a fixed explanation code. Initial allowlist: `quarantined_rejects` (the difference is exactly the rows rejected with reject-severity `ValidationIssue` rows), valid only for `distinct_users`, `totals` and `per_user` |
| `unexplained` | Differ without a permitted explanation. An `explained` outcome with a missing or non-permitted explanation counts as `unexplained` |
| `incomplete` | Evidence or new-side data is partial: no current published run, a quarantined or fatal day, a missing artifact, or an invalid manifest |
| `unavailable` | The evidence is missing, unavailable or unauthorized |

Day status precedence is `unavailable` > `incomplete` > `unexplained` > `explained` > `matched` (`deriveDayStatus`). A day is `matched` only when every required check is present and matched. A missing required check or an empty result list is `incomplete`. `rows_accounted` is evaluated only for published runs (a quarantined run is already `incomplete` through `run_published`). Duplicate check names make a day `incomplete`. A public summary must include an `evidence_available` check for every day, including days synthesized as unavailable, and `differingCount` is 0 only for `matched` and at least 1 for `explained` or `unexplained`. A requested range (`deriveRangeCoverage`) lists every requested day; a day without a result is `unavailable`, so a partial range is never matched. Independence of the two solutions does not waive parity evidence, and nothing here authorizes automatic cutover.

### Public and private output

- **Public summary** (`MetricsRangeReconciliationSummary`, gated by `assertPublicSummary`): strict schema with the range, per-day status, per-check outcome/explanation/differing count and aggregate counts only. It never contains user IDs, logins, emails, organization IDs, hashes, blob locators or approval references. Any extra key fails validation.
- **Private detail** (`MetricsDayReconciliationDetail`): per-check legacy/new values, hashes and per-user differences keyed by `user_id`. It goes only to an owner-approved private evidence location, never to logs, PR text or public artifacts. The location is an owner decision and is not chosen by this contract.
- Logs carry run IDs, correlation IDs and counts only (D-51).

### Out of scope

Directory comparison, cutover, source-access approval or extraction procedure, final data migration, old directory or `dbo` writes, runtime cross-database grants, API/report consumer authorization (L3/L4) and deployment.

## 17. Budget Lookup MVP contract

Owner-approved #137 narrows the D-55 contract before #95 implements a client,
route, page, module wiring or health check. The existing `BudgetLookupRequest`
and `BudgetLookupResponse` in `shared/src/api.ts` are the MVP boundary.
`DeferredBudgetLookupResponse` and the older center/source descriptors are
historical/deferred types, not supported request or success-response branches.
No shared SQL, directory, Functions or metrics contract changes.

### Request and target authorization

`GET /api/budget-lookup` normalizes to `{target:"self"}`; exactly one
`userId=<positive-safe-integer>` normalizes to `{target:"user",userId}`.
The `target` discriminator is internal, not a URL authority field.
`parseBudgetLookupRequest` rejects duplicate/extra keys, scope/root/login/email,
cost-center names, empty IDs, fractions, exponent/hex notation and unsafe IDs.
`validateBudgetLookupRequest` validates the strict normalized form.

Before any credential/source access require an authenticated active, uniquely
linked Entra-keyed principal, a valid current portal data grant and fresh,
complete identity/population evidence. Self derives only from that immutable
principal; a numeric target equal to resolved self receives the same treatment.
Self-only Budget amounts are available even with `PER_USER_DETAIL_ENABLED=false`.
This is not a metrics waiver or module-only entitlement.

Every other target needs BOTH `PER_USER_DETAIL_ENABLED=true` and membership in the
existing server-resolved authorized population. Manager population is their current
caller-rooted direct/indirect team; executives/admins use only actual grants.
No role-global bypass, caller hierarchy root, email/login grant or break-glass
data entitlement. Module visibility never authorizes data.

`validateBudgetLookupTarget` is a pure contract validator over trusted server
facts, NOT a replacement for the existing principal/grant/directory resolver.
Only that resolver may construct `access.state="authorized"` with a uniquely
mapped self and complete current authorized numeric population. Unavailable/
stale evidence maps to `permissions_unavailable`, denied/unlinked/no-grant to
`forbidden`, signed out to `unauthenticated`. The validator checks target
membership/detail gates and the module flag; it performs no database/network IO.

### Supported definitions, effective allocation and USD

Only `budget_type=BundlePricing`, singular `budget_product_sku=ai_credits`,
and `budget_scope=user` or `multi_user_customer` are supported.
`budgetLookupSourceClassificationSchema` checks these fields only: it does not
prove applicability, identity, permissions or pagination. Unknown/other scopes
are not aliases; cost-center per-user defaults and shared enterprise pools are
outside MVP. Plural SKU-only/ambiguous variants are not documented guarantees
and cannot substitute for the exact singular classification.

Response data has `userId`, `budgets`, `effectiveBudget`, `amountUnit:"USD"` and
`cycle:"calendar_month_utc"`. Each record has stable `id`,
`kind:"individual"|"default_per_user"`, exact-decimal `amount`, `consumedAmount`
and `expiresAt` (nullable date for individual; null for default). Consumption is
`{status:"reported",amount,unit:"USD"}` or `{status:"not_reported"}`. Zero is a
reported value, never a substitute for missing data. No roster, recipient list,
raw source login or cost-center descriptor reaches this DTO.

Effective allocation is `{status:"reported",budgetId,amount,consumedAmount}` only
when its ID identifies a validated supported record. Absent source metadata is
`{status:"not_reported"}`; an effective allocation outside the supported collection
is `{status:"outside_mvp"}` with no leaked ID/amount. Complete empty supported
definitions do not prove that no budget of any kind applies. Return separate
definitions, never sum overlaps, select newest/largest, synthesize precedence or
stamp effective consumption onto every record. `override_budget_id` is internal
source evidence, not local fallback authority. `budgetLookupDataSchema` validates
the strict browser shape, unique IDs, effective-ID coverage, expiry dates and
canonical exact decimals; it cannot prove source attribution.

The owner explicitly attested supported budget/effective/user-state amounts
(including `consumed_amount` and `target_amount`) are USD and directed direct
USD display with **no currency or AI-credit conversion**. Preserve lossless
numeric JSON tokens before `exactDecimal18_9`; never round-trip via JavaScript
Number. This is owner-attested source semantics, **not independent REST
field-unit proof**: the schema's generic consumption descriptions do not specify
USD versus credit units. No unit-based withholding or conversion is introduced.

Calendar-month UTC reset and individual expiration are different events.
Do not invent response-derived date bounds or claim full-month coverage for
mid-cycle creation. GitHub creates universal user states after activity, so a
missing user state neither proves zero consumption nor absence of the default.

### GET-only source and credential boundary

Use the fixed GitHub API host and version `2026-03-10`, deployment enterprise,
server-resolved current target login, encoded parameters and
`Accept: application/vnd.github+json`. No caller URL, enterprise or login.

1. Complete the authorization/module/freshness checks above.
2. `GET /enterprises/{enterprise}/settings/billing/budgets?user={resolved-login}&per_page=1`
   and read only the GitHub-reported `effective_budget` (`id`, `budget_amount`,
   `consumed_amount`). If the response names a top-level `user`, it must match.
   No other returned record is exposed. No effective budget means no budgets.
3. `GET .../budgets/{effective_budget.id}` to classify that one budget. A
   supported `user` budget is the individual budget, a supported
   `multi_user_customer` budget is the default per user; anything else is
   `outside_mvp`, and a 404 leaves only the effective figure. The by-ID
   response has no spend, so the record carries the effective `consumed_amount`.
4. `.../budgets/{budget_id}/user-states?user={resolved-login}` stays a follow-up.

This is the same pair of reads the original `Lookup-BudgetCostCenter` function
runs in production (owner revision 2026-10-29, PR #241); it replaced the earlier
scoped-list paging, which GitHub's list example does not back up.
The list `user` filter selects consumption details, not necessarily budgets or
membership. Exclude unmatched records; ambiguous identity/applicability is an
error. Never infer membership, numeric identity or an effective fallback from
consumption. No cost-center, team, Graph, write or old-database calls.

Use separate Key Vault secret `budget-lookup-key`, not ingestion/directory
credentials. The owner attests an existing budget-read PAT. Official docs require
classic PAT `manage_billing:enterprise` and source access for its user; fine-grained
PATs are unsupported. This upstream scope is broader than read-only: adapter
GET-only allowlisting enforces read-only behavior. GitHub App enterprise-billing
permission is not generally available; metrics-App success proves nothing about
it. This contract provisions no secrets, permissions or deployment resources.

### Completeness, errors and retention

Every raw budget/user-state page must supply explicit boolean `has_next_page`
and stable nonnegative safe-integer `total_count`, even though some published
budget response properties are optional. Missing evidence fails visibly, not
defaults. Count raw records before filtering; continue to explicit completion
and match totals. Reject repeated IDs/pages (user-state keys are exact logins),
conflicting duplicates/metadata, malformed decimals and ambiguous identities.
`validateBudgetLookupPage` validates normalized completion metadata and raw keys,
with 100 records/page and `BUDGET_LOOKUP_MAX_PAGES=100`; it does not fetch pages.
Its progress is trusted internal state, never caller input. No partial result
may be returned before completion. Bound the entire cancellable source sequence
by `BUDGET_LOOKUP_TIMEOUT_MS=10_000` across all provider calls (not per page) in
#95; source mutation/inconsistent totals fails this read rather
than pretending transactional snapshot consistency.

`BudgetLookupErrorResponse` extends the existing correlation-ID error envelope
only for Budget; unrelated API codes remain unchanged:

| Condition | HTTP | Code |
| --- | --- | --- |
| Missing credential, provider auth/network/5xx failure | 503 | `budget_source_unavailable` |
| Overall cancellable deadline | 504 | `budget_source_timeout` |
| Malformed/ambiguous source, precision/overflow or conflicting metadata | 502 | `budget_source_invalid` |
| Missing/inconsistent completeness, repeated pages or page limit | 502 | `budget_source_incomplete` |
| Provider rate limit | 429 | `rate_limited` (only validated sanitized retry metadata) |

Keep existing 400 `invalid_request`, 401 `unauthenticated`, 403 `forbidden`/
`per_user_detail_disabled`, 404 `module_disabled`, and 503
`permissions_unavailable`. Provider 401/403 is not caller denial or no-budget.
No source failure, timeout or truncation can construct empty success.

No result cache (TTL=0), budget persistence, snapshots, request/approval tracking
or new audit table. Fresh permission/identity checks each request; private/no-store
responses with correlation IDs. D-51 redacted operational event/code/correlation
logs remain; exclude source bodies, logins, amounts, recipients and credentials.
No implicit new retention policy or assertion that hosting telemetry does not exist.

### Evidence provenance and deferred implementation

- [REST budgets, version 2026-03-10](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets?apiVersion=2026-03-10).
- [Pinned OpenAPI](https://github.com/github/rest-api-description/blob/bb754941722779d8a5b3a2f25a5fbb7ce794e1ea/descriptions/ghec/ghec.2026-03-10.json).
  Response enums omit `BundlePricing` despite create docs describing it; do not
  replace it with `ProductPricing` or infer classification from names.
- [Copilot budgets](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets):
  user limits cover pool and metered consumption; monthly reset and activity-created
  universal user states. Documented precedence explains upstream behavior but
  does not authorize locally computing the effective budget.
- [Billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
  distinguishes dollar budgets and AI-credit usage; owner-attested USD fields
  above are not an independent authenticated replay.
- [Billing cycles](https://docs.github.com/en/billing/concepts/billing-cycles#billing-cycles-for-metered-products):
  month starts 00:00:00 UTC on day 1, regardless of invoice date.

No live source or credential validation is required or performed for this
contract. #95 must later test the actual adapter's lossless decode, applicability,
authorization-before-IO, complete sequence, deadline cancellation and no-fallback
errors with mocked GitHub and synthetic personas. Pure contract checks here do
not prove those runtime behaviors or module health. UI/browser/axe evidence stays
with that feature; no budget or request automation is authorized.

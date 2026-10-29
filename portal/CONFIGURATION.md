# Authentication and access configuration

The portal reads only the new portal database. Configure the following app settings through the private deployment repository's typed Terraform inputs and Key Vault. The public Terraform example contains synthetic IDs only; `.env.example` contains placeholders, not usable credentials. Never enable test sign-in in a deployment.

| App setting | Meaning |
| --- | --- |
| `AUTH_SECRET` | NextAuth JWT encryption secret, supplied through a Key Vault reference |
| `AUTH_URL` | Canonical HTTPS portal origin; Terraform defaults to the App Service `azurewebsites.net` hostname. Set `portal_public_url` for a custom domain, not an `/api/auth` path. Register both provider callbacks against this origin. |
| `AUTH_TRUST_HOST` | Set `true` only behind a trusted ingress that controls forwarded host/protocol headers; omitted when false so the literal string `"false"` cannot enable trust |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Entra app client ID |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Entra client secret, Key Vault reference |
| `ENTRA_TENANT_ID` | Allowed tenant; sign-in requires this tenant and an immutable Entra object ID |
| `AUTH_GITHUB_ID` | Separate sign-in OAuth app client ID |
| `AUTH_GITHUB_SECRET` | Sign-in OAuth app secret, Key Vault reference; not an ingestion or directory credential |
| `MODULE_UPSTREAM_VIEWS` | `false` by default (Safe Alpha: Overview and Copilot Impact tables). `true` renders every upstream view from the curated SQL facts for the selected scope over the last 28 days. Each day, IDE, version, feature, language, model, usage type and adoption phase with fewer users than `MIN_GROUP_SIZE` is hidden, and a scope left below it shows no metrics, unless it is the viewer's own data or `PER_USER_DETAIL_ENABLED=true`; without per-user detail, logins are replaced by placeholders and Users/User Details stay hidden |
| `MIN_GROUP_SIZE` | Minimum distinct users a group needs before any view shows it; `5` when unset, at least `2`. Set it with the Terraform variable `min_group_size` |
| `MODULE_BUDGET_LOOKUP` | Optional Budget Lookup visibility flag; `false` by default, never grants data access |
| `BUDGET_LOOKUP_KEY` | Separate owner-provided classic PAT with `manage_billing:enterprise`; Key Vault reference wired only when Budget Lookup is enabled |
| `ENTERPRISE_SLUG` | Configured enterprise whose live individual/default-per-user AI-credit budgets are read |
| `SQL_SERVER`, `SQL_DATABASE` | New database FQDN and name; encrypted SQL connection using `DefaultAzureCredential` |
| `AZURE_CLIENT_ID` | Portal user-assigned managed identity client ID |
| `ACCESS_BREAK_GLASS_GROUP_ID` | `access.break_glass_group_id`; empty disables break-glass; a nonempty invalid GUID fails startup |
| `ACCESS_PERMISSION_FRESHNESS_MINUTES` | `access.permission_freshness_minutes`; default 5; must be an integer from 1–60; invalid values fail startup |
| `ACCESS_NO_ACCESS_MESSAGE` | No access page message; generic default |
| `ACCESS_REQUEST_URL` | Optional HTTPS request-access link; empty hides it |
| `ACCESS_CONTACT` | Optional plain-text contact; empty hides it |
| `DIRECTORY_PROVIDER` | `entra` (default: requires fresh scim, graph and seats state) or `csv` (requires csv state) |
| `DIRECTORY_DEPARTMENT_ATTRIBUTE`, `DIRECTORY_BUSINESS_AREA_ATTRIBUTE` | Attribute paths; empty disables the corresponding grant scope |
| `STALE_DATA_THRESHOLD_HOURS` | Maximum age of each required directory source, default 36; missing success timestamps, or timestamps more than 500 ms in the future (maximum `DATETIME2(0)` rounding error, not general clock skew), deny elevated grants |
| `PER_USER_DETAIL_ENABLED` | `false` by default; server-derived `namesVisible`, never a request parameter |

The Terraform stack wires `SQL_SERVER`, `SQL_DATABASE`, and the portal `AZURE_CLIENT_ID` from the selected SQL resources and managed identity. It provides Key Vault references for `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and `AUTH_GITHUB_SECRET`; when `modules.budget_lookup` is enabled it also references the separately operator-created `budget-lookup-key`. Create values separately in Key Vault using the names in the `secret_names` output. Terraform plan/apply does not query secret names or values: operators must verify expected names, component-identity access, and resolved Key Vault reference status through the approved deployment route before releasing portal code. Never expose secret values during these checks. The portal identity receives only portal sign-in secrets and the optional Budget Lookup key. The GitHub sign-in OAuth secret belongs to its separate sign-in app and must not reuse ingestion or directory credentials; the portal cannot read ingestion or directory secrets.

Budget Lookup uses the classic PAT only for fixed-host GitHub `GET` requests. Its `manage_billing:enterprise` permission is broader than read-only; the server-side client enforces the GET-only endpoint allowlist. It is not the GitHub App, metrics, or directory credential. If the setting is absent or unusable, lookups fail visibly; there is no SQL or legacy-database fallback.

The server-only `readBudgetLookupHealth()` seam is for Admin composition only
after the existing HEALTH authorization. It reports credential presence, never
the credential, and the last observed source permission result from an authorized
Budget Lookup GET (200 allowed; 401/403 denied). This is historical and local to
one process instance, not proof of current permission or cross-instance health.
Absence, process restart, and other instances mean unknown. Other failures retain
the prior observation and its original timestamp. Reading health never probes
GitHub; the public `/api/health` is unchanged. Admin presentation is delivered
separately after this seam merges.

OAuth callbacks are `/api/auth/callback/microsoft-entra-id` and `/api/auth/callback/github`. Configure Entra to emit group object IDs in its signed ID token for break-glass. Group overage/missing claims do **not** trigger Graph calls and do not grant break-glass. Only matching-tenant Entra sign-in can use it, for admin and health surfaces only. Group evidence expires at the configured permission-freshness interval; sign in again to renew it. It never grants data or feedback access.

JWT sessions last eight hours but contain identity, not grants. Every protected request reads `portal.v_active_grant` again; no cached permission can outlive the freshness setting. SQL failures produce Service unavailable, never a request-access suggestion or admin bootstrap. The No access page is only for a completed permission lookup with no usable grant. Unlinked GitHub sign-in has no grants. Existing one-to-one links are consumed; creating or changing links is not exposed by this issue.

Team scope requires each report's own `manager_resolved = 1` and a non-NULL
`manager_checked_at` within `STALE_DATA_THRESHOLD_HOURS` (default 36), allowing
the existing 500 ms SQL rounding tolerance into the future. Missing, unresolved
or stale edges and paths through them are excluded; unaffected fresh report
paths remain available even if another user's read makes source sync incomplete.
The SQL readers recheck edges for each query, and a team grant with no eligible
direct reports is not usable. Self access is unchanged. Admin/executive grants
retain their existing configured-source freshness policy.

`validateServerGrant` resolves principal existence and directory values on the server before calling the shared validator. Future admin mutation routes must authorize the actor separately; it is not an authorization bypass. `canAccess` is the single surface gate, including restricted break-glass. Admin pages are delivered separately.

Core reporting pages read the existing scoped usage aggregates server-side and request fixed periods. Production never reads synthetic fixtures or NDJSON. The current API-backed views are Overview, Copilot Adoption, Languages, Model Usage, CLI Adoption, Copilot Impact, the Clients aggregate breakdown, and Users when names are visible. In guarded E2E test-auth runs, unsupported views can use synthetic fixtures; in production they show **Data unavailable** instead. This currently applies to the full Executive Summary and Clients views, Client Versions, AI Adoption Phases, User Details, and scope selections the API cannot safely narrow. Follow-up #115 tracks the missing core-view DTOs, authorized business-area/department/team narrowing, and gated per-user detail.

Production sign-in requires a canonical URL even when forwarded-host trust is disabled. The pinned Auth.js v5 infers `trustHost` from an explicit `AUTH_URL`; NextAuth rewrites the request origin to that URL rather than deriving it from forwarded headers. Leave `AUTH_TRUST_HOST` omitted for the normal App Service hostname. Configuring `AUTH_URL` does not provision custom-domain bindings or OAuth app registrations.

## Local browser verification

Run `npm run stack:up`, then `npm run test:e2e`. Playwright seeds only synthetic access rows and runs the local dev server with the four-persona credentials provider. The provider is guarded by `E2E_TEST_AUTH=1` and startup refuses that flag with `NODE_ENV=production`; the old unsigned persona-cookie API is removed.

For a real local SQL outage, run `E2E_SQL_OUTAGE=1 LOCAL_SQL_PORT=1 npm run test:e2e` after the normal server exits. This uses a refused loopback connection, not a production target or an outage-shaped successful response. Screenshots are saved under `test-results/screenshots/`. A production build is checked separately without the test flag (D-41 forbids production-mode test sign-in, including local builds).

# Feature parity checklist

Draft from the current portal's navigation, pages, and API routes. The owner confirms each row before Phase 3; each confirmed row becomes at least one E2E test. "Target" says where the feature lives in the new design.

| # | Feature (current) | Target | Keep? | E2E test |
| --- | --- | --- | --- | --- |
| 1 | Sign-in page (Entra ID, GitHub) | Core shell | Yes | Signed-out redirect; both providers offered |
| 2 | Unauthorized page | Core shell: No access page with configurable message and link | Yes | No-access persona |
| 3 | Service unavailable state | Core shell (new) | Yes | SQL down simulated |
| 4 | Scope selector (business area, department, team) | Core | Yes | Manager sees only reports; member sees self |
| 5 | Overview | Core (upstream charts) | Yes | Renders with fixture data |
| 6 | Executive Summary | Core (upstream `ExecutiveSummaryView` via adapter) | Yes | Renders with fixture data |
| 7 | Users list | Core; per-user only when deployment allows | Yes | Hidden in aggregate-only mode |
| 8 | User Details | Core; per-user only when deployment allows | Yes | Scope enforced |
| 9 | Languages | Core | Yes | |
| 10 | Clients / Client Versions | Core (upstream Clients and Client Versions views via adapter) | Yes | Both pages render with fixture data |
| 11 | Copilot Impact | Core | Yes | |
| 12 | Copilot Adoption (incl. Feature Adoption, upstream categories) | Core | Yes | New categories visible |
| 13 | Model Usage | Core | Yes | |
| 14 | CLI Adoption | Core | Yes | |
| 15 | AI Adoption Phases | Core (upstream AI Adoption Phases view via adapter) | Yes | Phase counts match fixture |
| 16 | AI Credits view and billing charts | AI Credits module | Yes | Hidden when module off |
| 17 | Budget Lookup (self and scoped users; live GitHub budgets) | MVP: individual + default-per-user AI-credit budgets; center lookup deferred (#137, D-55); no SQL/old-database fallback | Yes | Source-reported effective and separate USD definitions; self detail exception, other users require scope + detail opt-in; mocked GitHub E2E; hidden when module off |
| 18 | Administration: access grants | Admin | Yes | Grant and revoke; audit written |
| 19 | Administration: hierarchy view and manual sync | Admin; "Sync now" triggers the directory sync job, admin-only and audited | Yes | Non-admin denied; trigger writes audit |
| 20 | Administration: audit view | Admin (`portal.AuditLog`) | Yes | |
| 21 | Administration: upstream sync status | Admin: read-only panel with pinned upstream commit and portal release version | Replace | Panel shows pinned commit |
| 22 | Feedback: submit, list, vote, comment, screenshots | Feedback module | Yes | Screenshot visibility checks parent |
| 23 | Feedback: webhook and work-item adapters | Deferred to post-beta; the admin-editable work-item URL field stays in the Feedback module | Deferred | Admin sets work-item URL |
| 24 | Health endpoint | Core (`/api/health`, extended) | Yes | Smoke |
| 25 | Portal-only charts (decision record §4.1) | See "Portal-only chart decisions" below | Decided | Each kept chart renders with fixture data |

All rows were reviewed by the owner on 2026-10-25 (issue #84).

## Portal-only chart decisions

A re-check against upstream at `00608a2` (2026-10-20) found that upstream now ships 11 of the 17 charts listed in decision record §4.1: `AdoptionTrendChart`, `ClientActivityChart`, `CloudAgentAdoptionChart`, `CloudAgentsUsageChart`, `CodeReviewAdoptionChart`, `DayClientDistributionChart`, `FeatureAdoptionRadarChart`, `LanguageDailyChart`, `UserActivityByLanguageAndFeatureChart`, `UserActivityByModelAndFeatureChart`, `UserSummaryChart`. These come from upstream through adapters, as for any upstream chart.

| Chart | Decision | Where |
| --- | --- | --- |
| `BillingCostTrendChart` | Keep (enterprise billing) | AI Credits module, next to upstream `AiCreditsView` |
| `BillingModelCostChart` | Keep (enterprise billing) | AI Credits module |
| `BillingTopUsersChart` | Keep (enterprise billing; per-user only when the deployment allows) | AI Credits module |
| `BillingBusinessAreaChart` | Keep (enterprise billing by Entra business area) | AI Credits module |
| `AgentModeHeatmapChart` | Keep | Owned chart on Copilot Adoption |
| `BillingUserCostChart` | Drop (unused in the original portal) | None |

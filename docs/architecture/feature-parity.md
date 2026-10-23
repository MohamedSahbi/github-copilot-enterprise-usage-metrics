# Feature parity checklist

Draft from the current portal's navigation, pages, and API routes. The owner confirms each row before Phase 3; each confirmed row becomes at least one E2E test. "Target" says where the feature lives in the new design.

| # | Feature (current) | Target | Keep? | E2E test |
| --- | --- | --- | --- | --- |
| 1 | Sign-in page (Entra ID, GitHub) | Core shell | Yes | Signed-out redirect; both providers offered |
| 2 | Unauthorized page | Core shell: No access page with configurable message and link | Yes | No-access persona |
| 3 | Service unavailable state | Core shell (new) | Yes | SQL down simulated |
| 4 | Scope selector (business area, department, team) | Core | Yes | Manager sees only reports; member sees self |
| 5 | Overview | Core (upstream charts) | Yes | Renders with fixture data |
| 6 | Executive Summary | Core | Confirm | |
| 7 | Users list | Core; per-user only when deployment allows | Yes | Hidden in aggregate-only mode |
| 8 | User Details | Core; per-user only when deployment allows | Yes | Scope enforced |
| 9 | Languages | Core | Yes | |
| 10 | Clients / Client Versions | Core | Confirm | |
| 11 | Copilot Impact | Core | Yes | |
| 12 | Copilot Adoption (incl. Feature Adoption, upstream categories) | Core | Yes | New categories visible |
| 13 | Model Usage | Core | Yes | |
| 14 | CLI Adoption | Core | Yes | |
| 15 | AI Adoption Phases | Core | Confirm | |
| 16 | AI Credits view and billing charts | AI Credits module | Yes | Hidden when module off |
| 17 | Budget Lookup (user, manager, cost center) | Budget Lookup module (read-only) | Yes | Hidden when module off |
| 18 | Administration: access grants | Admin | Yes | Grant and revoke; audit written |
| 19 | Administration: hierarchy view and manual sync | Admin (sync now triggers directory sync) | Confirm | |
| 20 | Administration: audit view | Admin (`portal.AuditLog`) | Yes | |
| 21 | Administration: upstream sync status | Admin: shows pinned upstream commit and release | Replace | |
| 22 | Feedback: submit, list, vote, comment, screenshots | Feedback module | Yes | Screenshot visibility checks parent |
| 23 | Feedback: webhook and work-item adapters | Feedback module, optional settings | Confirm | |
| 24 | Health endpoint | Core (`/api/health`, extended) | Yes | Smoke |
| 25 | Portal-only charts (decision record §4.1) | Owned pages | Decide per chart | |

Rows marked **Confirm** or **Decide** need the owner's answer before Phase 3.

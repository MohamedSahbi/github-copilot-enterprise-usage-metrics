# Upstream oracle coverage

`scripts/contracts/oracle/upstream-oracle.int.test.ts` runs the pinned upstream calculators on
`fixtures/synthetic/users-1-day.ndjson`, loads that same fixture into the local curated SQL
tables through the test-only seed, and compares the SQL usage API functions with upstream output.
The integration CI job runs this test through `npm run test:integration`.

## Covered merged API metrics

| API surface | Compared with upstream |
| --- | --- |
| Usage overview series | Daily active users, interactions, code generations, code acceptances, LOC added and LOC deleted |
| Usage overview adoption | All 14 `AdoptionSummary` fields |
| Breakdown: feature, model and IDE | Dimension key, user-initiated interactions and distinct users; IDE parity covers persisted dimensions and a separate feature-backed Copilot App cohort |
| Breakdown: client | Client key and distinct users; the SQL DTO's interaction field is asserted to remain zero because ingestion stores zero for client rows |
| Breakdown: language | Dimension key and distinct users |
| Users | Per-user active days, user-initiated interactions and AI credits used |

The test uses the synthetic fixture's two organization IDs to isolate its SQL reads and invokes
the SQL usage functions directly. `getUsageBreakdown` applies `suppressForScope(..., false)`;
`namesVisible: true` does not bypass that aggregate suppression. The requested `minGroupSize: 1`
is clamped to the shared minimum of five, so groups below five users remain suppressed. The
fixture's one-user `copilot_app` prompt fallback is not a visible parity assertion: the API cannot
return that group visibly, and ingestion does not preserve its `prompt_count`. The oracle separately
generates a five-user feature-backed scenario, runs the pinned upstream parser/calculator over those
exact lines, and compares the visible SQL IDE aggregate; a one-user feature-backed scenario checks
that suppression remains in force.

Language `UsageBreakdownRow.interactions` values are not treated as an upstream parity metric:
the ingestion mapper stores zero for that breakdown kind, and the upstream language calculators
expose different measures. The client breakdown's dimension keys and distinct users are compared
with upstream client-presence data. Its `interactions` field is asserted to remain zero because the
mapper stores zero; it cannot stand in for client telemetry. Client sessions, requests, tokens and
versions remain uncovered by the current API response. AI-credit user totals use a nine-decimal
comparison because the SQL `DECIMAL(18,9)` and upstream JavaScript number paths encode decimal
values differently.

Upstream `portal/upstream/src/domain/metricsParser.ts` synthesizes a `copilot_app` IDE row from
feature interactions when those feature rows exist; otherwise it can use
`totals_by_copilot_app.prompt_count`. The checked fixture has five app rows for one distinct user,
each with `prompt_count: 2`, and no app feature or raw app IDE rows. Its upstream result
`{key: "copilot_app", interactions: 10, userCount: 1}` therefore uses the prompt-count fallback.
That field is not staged by `functions/src/metrics/day-parser.ts` or persisted in curated SQL, and
the one-user group is below the enforced minimum of five; it is not valid evidence for a visible
API parity expectation. The IDE check compares the remaining persisted dimensions, and the prompt
fallback gap stays explicit in the source-field inventory below.

The distinct feature-backed path is covered with five fixture users whose app-feature interaction
counts are `[10, 0, 3, 2, 4]`. The pinned parser/calculators derive the expected visible aggregate
`{key: "copilot_app", interactions: 19, userCount: 5}` from those exact synthetic lines; the SQL
comparison maps those same lines through the production staging mapper and inserts the mapped
feature rows into the isolated curated test database. The API's matching feature-backed-to-IDE
reconstruction was merged in #123; #119 remains open for the unavailable prompt-count fallback.
The source fixture is
`users-1-day.ndjson` (SHA-256
`9c9604204b083021db929f4950dfe29ea3b54a5c7b252ec5ca69b1c844b609d4`); the generated rows remove
the prompt-only and raw IDE inputs and add only the feature values above. Upstream's parser gives
feature rows precedence over raw app IDE counts (including a zero feature value). #123 implements
that bounded SQL reconstruction but does not restore `prompt_count`, which remains unavailable
for the original one-user fallback. Neither source gap nor suppression is treated as a reason to
weaken parity or expose a small cohort.

## Not covered by the current API DTOs

This is an inventory of upstream page metrics that must wait for an approved and merged API
contract; it is not a claim that those metrics are equivalent or intentionally zero.

| Upstream page/output | Missing or incomplete API coverage |
| --- | --- |
| Executive Summary and AI Adoption Phases | No current response DTO or SQL aggregate fields |
| Client / Client Versions | The generic client DTO/query does not expose persisted `key_2`, client session/request/token/version counts, IDE totals, version analysis or daily IDE user fields; current client key and distinct-user coverage does not imply those measures are covered |
| Languages | No generation, acceptance, LOC, language-feature impact or daily language series fields |
| Model Usage | No vendor/category breakdown, daily model-usage series or model feature detail fields |
| CLI Adoption | No session, token or daily adoption-trend fields |
| Copilot Impact | No impact, mode-impact or joined-impact response fields |
| User Details | No user-detail route or detail DTO; `/api/users` exposes only the current paged summary |
| Skill, custom-agent, MCP, slash-command and plugin families | No current core usage response fields |

Any new endpoint or DTO coverage must be coordinated with the API implementation and its separate
contract change. Do not expand the shared DTOs or infer unsupported metrics in this oracle.

## Source fields not preserved for parity

These are upstream-supported inputs that the current curated SQL mapping does not retain. They are
not zero-valued parity assertions and must not be replaced with a similar-looking count:

| Upstream input | Current SQL mapping | Consequence |
| --- | --- | --- |
| `ai_adoption_phase.version` | `functions/src/metrics/day-parser.ts` emits only phase number and name; curated fact rows have no version column | Adoption-phase version is unavailable |
| CLI and Copilot App `prompt_count` | The ingestion parser stages client sessions/requests/tokens/version, but not `prompt_count` | CLI/app prompt metrics cannot be compared |
| VS Code agent `total_user_messages` | Not mapped into curated facts | VS Code agent message metrics cannot be compared; session counts are not a substitute |
| `enterprise_id` | Retained in staging, omitted from curated fact rows | Enterprise-level upstream metrics are unavailable from the SQL API |

Evidence is in `functions/src/metrics/day-parser.ts`, `shared/src/rows.ts`,
`functions/src/metrics/day-loader.ts`, and `docs/architecture/data-contracts.md` §§3–4; upstream
consumers include `portal/upstream/src/domain/calculators/aiAdoptionPhaseCalculator.ts`,
`cliUsageCalculator.ts`, and `vscodeAgentUsageCalculator.ts`. These gaps are recorded for future
contract and ingestion work, not silently filled or treated as accepted parity.

Negative `ai_credits_used` values are rejected by the ingestion parser and SQL schema as a
non-negative domain constraint. Although the upstream parser accepts finite numeric values, this
is not treated as source restoration or silently compared as parity.

---
description: "Use when writing, fixing, or reviewing tests: unit, contract, integration, Playwright end-to-end, smoke tests, fixtures, or the test oracle."
applyTo: "**/*.test.ts,**/*.test.tsx,e2e/**,tests/**,fixtures/**"
---

# Testing (D-39 to D-43)

## Layers

- **Unit (Vitest):** pure logic only. Colocated `*.test.ts`.
- **Contract:** shared DTOs, the directory column contract read by the PowerShell budget Functions, and the upstream test oracle. Never edit oracle fixtures to make a test pass.
- **Integration (Vitest):** real SQL Server container and Azurite; GitHub, Graph, and SCIM via recorded responses in `fixtures/`. No live network calls in tests.
- **E2E (Playwright, `e2e/`):** run against a local build seeded from fixture NDJSON with test sign-in personas (admin, manager with reports, member, no-access, unlinked GitHub user).
- **Smoke (Playwright, `e2e/smoke/`):** deployed environments only; unauthenticated paths and `/api/health` only.

## Rules

- **Test first for logic and bug fixes.** Calculators, authorization rules, ingestion transforms, mapping rules, and every bug fix: write the test, run it, and see it fail for the expected reason before writing the code. A test that passes immediately proves nothing; fix the test. UI wiring, Terraform, and configuration are exempt.
- Each test should fail if a specific production change were reverted; name that change to yourself before writing the test. Assert on real behaviour, not on mocks.

- Every behaviour change has a test; every authorization rule has an allowed and a denied case.
- Cover empty, partial, malformed, and error responses for every external API.
- E2E tests assert no console errors and run axe on each page they visit.
- Use role-based Playwright locators (`getByRole`, `getByLabel`); no CSS selectors tied to styling.
- Tests are independent and order-free; reset the database between integration tests.
- Fixtures are anonymized; never commit production data, tokens, or real user names.
- The test sign-in provider is only for tests (`E2E_TEST_AUTH=1`); never reference it from application code paths outside its guarded module.
- A new test you wrote that exposes a defect outside the current scope is marked `test.fixme` with the issue number (see `report-bug`). Never mark an existing test `fixme`: if an existing test fails and this change did not cause it, create a `severity:high` issue, stop, and tell the owner.

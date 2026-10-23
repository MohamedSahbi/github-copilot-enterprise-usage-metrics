---
name: smoke-test
description: 'Run or extend post-deployment smoke tests and the health endpoint. Use after a deploy, when promotion is blocked by a failing smoke test, or when adding a module that needs a health check.'
---

# Smoke tests (D-43)

## What smoke tests check

- `GET /api/health`: SQL reachable, last successful ingestion age under the threshold, per-module status (secret present, permission OK, last run OK). Never returns secrets or user data.
- Root URL redirects to sign-in when signed out.
- A data API route returns 401 without a session.
- The No access page renders its configured message and link.

Smoke tests never sign in and never use `E2E_TEST_AUTH`.

## Run

`npm run test:smoke -- --base-url=<environment URL>`. The deploy workflow runs this after each deployment; failure blocks promotion to the next environment.

## Add a check for a new module

1. Add the module's status to `/api/health` (see the `add-optional-module` skill).
2. Add an assertion in `e2e/smoke/health.spec.ts` that the module reports healthy when its flag is on and is absent when off.

## When a smoke test fails

1. Read `/api/health` output and Application Insights for the deployment.
2. Classify: configuration (missing secret or permission), infrastructure (network, SQL), or code regression.
3. Report the cause and the fix; do not disable the test.

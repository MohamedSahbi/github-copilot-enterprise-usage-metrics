#!/usr/bin/env bash
# Single entry point for CI: lint, typecheck, unit tests, build, Playwright E2E (D-26).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run lint
npm run typecheck
npm test
npm run build
trap 'npm run stack:down' EXIT
npm run stack:up
npm run test:e2e
# Mitigation: retained traces show Turbopack HMR reload churn in this serial secondary phase; root cause is unproven.
E2E_DEV_BUNDLER=webpack E2E_PORT=3101 E2E_PER_USER_DETAIL_ENABLED=1 npm run test:e2e -- --grep "member cannot read a different user's details outside its self grant"

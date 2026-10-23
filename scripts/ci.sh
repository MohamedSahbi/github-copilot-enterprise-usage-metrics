#!/usr/bin/env bash
# Single entry point for CI: lint, typecheck, unit tests, build, Playwright E2E (D-26).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e

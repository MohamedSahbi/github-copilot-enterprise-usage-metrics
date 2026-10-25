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

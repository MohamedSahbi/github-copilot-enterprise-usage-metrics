#!/usr/bin/env bash
# Single entry point for CI: lint, typecheck, unit tests, build, Playwright E2E (D-26).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run lint
npm run typecheck
npm test
npm run build
# Pass the same explicit local target to fixture mutation tests and the stack.
export LOCAL_SQL_PORT="${LOCAL_SQL_PORT:-14330}"
SQL_CONNECTION_STRING="$(node_modules/.bin/tsx -e 'import { assertExplicitLocalConnection, localConnectionString } from "./scripts/stack/config"; const connection = process.env.SQL_CONNECTION_STRING ?? localConnectionString(process.env); assertExplicitLocalConnection({ ...process.env, SQL_CONNECTION_STRING: connection }); process.stdout.write(connection);')"
export SQL_CONNECTION_STRING
trap 'npm run stack:down' EXIT
npm run stack:up
npm run test:e2e
E2E_PORT=3101 E2E_PER_USER_DETAIL_ENABLED=1 npm run test:e2e -- --grep "per-user detail URLs remain unavailable regardless of deployment detail access"

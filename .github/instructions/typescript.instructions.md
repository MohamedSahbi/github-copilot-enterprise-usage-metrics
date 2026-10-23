---
description: "Use when writing or reviewing TypeScript or TSX in the portal, functions, or shared packages."
applyTo: "portal/src/**/*.ts,portal/src/**/*.tsx,functions/**/*.ts,shared/**/*.ts"
---

# TypeScript conventions

- `strict` mode; no `any` without a one-line reason. Prefer `unknown` plus validation at system boundaries (HTTP input, GitHub/Graph responses, NDJSON rows).
- Validate external data with a schema library chosen in Phase 1 and infer types from the schema.
- Shared contracts (SQL row shapes, API DTOs, module flags) live in `shared/`; do not duplicate them.
- Use `@azure/identity` (`DefaultAzureCredential` or a managed identity credential) for Azure, Graph, and SQL tokens. No connection-string secrets.
- Parameterise every SQL query. Never build SQL with string concatenation.
- Errors: throw typed errors at boundaries; never treat a timeout or HTTP failure as "no data".
- Tests: Vitest, colocated `*.test.ts`. Mock network and SQL at the boundary, not internal functions.
- Keep functions small; no helpers or abstractions for one-time use.

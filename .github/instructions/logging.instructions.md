---
description: "Use when adding logging, telemetry, error handling, or correlation IDs in the portal or functions."
applyTo: "portal/src/**/*.ts,functions/**/*.ts,shared/**/*.ts"
---

# Logging and telemetry (D-51)

- Use the shared logger from `shared/`; structured JSON fields, never string-concatenated messages with data.
- Every HTTP request and timer run gets a correlation ID; pass it to SQL calls, GitHub/Graph calls, and the `IngestionRun` record, and include it in error responses.
- Never log tokens, secrets, connection strings, request headers with credentials, emails, names, or UPNs. Log numeric GitHub user IDs or Entra object IDs only when needed for troubleshooting.
- Log levels: `error` for failures needing action, `warn` for degraded but handled, `info` for run start/end with counts, `debug` off in production.
- Ingestion runs log: run ID, source, day, rows read/staged/curated/quarantined, duration, outcome.
- Do not log full API payloads or NDJSON rows.

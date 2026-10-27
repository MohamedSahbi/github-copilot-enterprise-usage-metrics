# Ingestion Functions

`src/index.ts` retains the metrics loader/parser library exports.

## Fixture-backed directory sync

`src/directory/handler.ts` exports `createDirectoryHandler`, an invocation
callback that runs the actual directory use case with injected configuration,
transports, clock and writer. `src/directory/runtime.ts` composes it through
`createDirectoryRuntimeHandler(process.env)`, validating the existing deployment
bindings before accepting an invocation. It uses the directory-only resolved
Key Vault PAT for GitHub, the configured user-assigned managed identity for
Graph/SQL, bounded same-origin HTTP requests and an explicitly configured SQL
pool. Imports do not contact services; unit tests override all side-effect
boundaries.

It is **not** a registered timer or deployable
Function App entrypoint. No schedule, credential acquisition, host configuration
or deployment is enabled by this slice. The operator supplies NCRONTAB at
deployment with no default; runtime registration and packaging are
coordinated separately with #72; live Graph endpoint support and application
permissions remain gated by #67. A configured CSV provider additionally requires
an explicitly supplied byte reader; no CSV location/deployment setting has been
approved, so an absent reader fails closed rather than switching to Graph.

The GitHub transport receives relative SCIM/seats paths; the Graph transport
receives relative `/v1.0/users/{object-id}` profile/manager paths. Both return
status and parsed, untrusted body data. The directory path never falls back to
SCIM `userName`, expands to the whole tenant, or calls consumed licenses.
Provider exceptions and response bodies are not included in logs/errors.

The owner accepted the risk that the production transport treats a Graph direct
manager 404 as no manager only when its JSON error code is exactly
`Request_ResourceNotFound`. This relies on observed endpoint behavior:
[Microsoft documents app-only access to the manager relationship as unsupported](https://learn.microsoft.com/graph/api/user-list-manager?view=graph-rest-1.0).
Other 404 codes, absent/unparseable error bodies, non-404 failures, missing
manager recognition email and malformed responses remain incomplete reads;
they preserve the cached relationship and prevent successful freshness
advancement. Synthetic fixtures exercise the exact-code allow case and these
fail-closed alternatives; they do not prove Graph application-auth support,
least privilege or consent.

Each persisted user has `manager_resolved` and `manager_checked_at` evidence from
the merged directory row contract. A failed profile/manager read, or an unmapped
licensed seat in a complete collected population, marks that user's evidence
unresolved without deleting the cached relationship. Successful users in the
same partial run retain their own successful evidence; source-level success
still advances only for a complete run. An incomplete population collection
cannot identify every affected user, so it does not refresh their evidence.
Existing evidence then expires at the configured directory stale threshold.

Portal team scope traverses only edges with positive, current per-user evidence:
resolved and checked within `STALE_DATA_THRESHOLD_HOURS` (default 36), with the
existing 500 ms SQL timestamp-rounding allowance. An ineligible edge also blocks
its downstream path; fresh sibling paths remain visible. Missing evidence denies
that edge. Team grants are usable only when at least one eligible direct report
exists, and both SQL scope readers recheck every edge. Self grants and the
existing admin/executive freshness policy are unchanged. Metrics observations
do not write these markers; SQL permission remediation and runtime activation
remain separate deployment gates.

`src/ingestion/user-writer.ts` is the shared logical user-write boundary:
metrics retain their existing login/date/history writes; directory writes only
its current attributes and hierarchy, without changing metric observation dates
or login history. `createDirectorySqlWriter` receives a transaction factory over
an already connected, explicitly configured **new-solution** database pool.
It writes the directory run, valid profiles and source freshness atomically.
Incomplete runs retain previous successful source timestamps and never perform
principal linking, unlinking or grant revocation; those lifecycle changes belong
to #76.

The state update condition rejects snapshots whose start falls in the same
second as, or before, an existing attempt. Existing SQL timestamps have
second precision, so equal-second ordering is deliberately fail-closed. The
conditional state update and all row writes share the directory application
lock and transaction; a rejected snapshot rolls back and fails the invocation.

Unresolved licensed seats produce a structured aggregate warning with the fixed
`unmapped_licensed_profiles` code and count. SCIM profiles without seats do not
produce that warning solely because they lack a seat. Logs contain correlation
metadata and aggregate status only, never profile payloads or user identifiers.
Admin-facing warning UI/API is deferred to
[#142](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/142).

The provider imports Zod directly. Eventual isolated runtime artifacts must
include explicit Zod and MSSQL dependency closure and the referenced shared
source modules; workspace hoisting is not a deployment contract.

Pure synthetic checks (no SQL, containers or live requests):

```sh
npx vitest run --config vitest.config.mts --project unit \
  functions/src/directory/providers.test.ts \
  functions/src/directory/sync.test.ts \
  functions/src/directory/sql-writer.test.ts \
  functions/src/directory/handler.test.ts \
  functions/src/directory/runtime.test.ts \
  functions/src/ingestion/user-writer.test.ts --maxWorkers 1
```

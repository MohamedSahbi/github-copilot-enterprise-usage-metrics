# Metrics acquisition

Issue #74's fixture-only readiness exception permits offline implementation.
It does **not** prove live App support or authorize activation. Issue #64 remains
the live-activation gate, regardless of the historical statement in ADR section 17.

The provider uses an App JWT to discover `GET /orgs/{org}/installation`, checks
the installation's organization account, then mints an installation token.
There is no directory PAT, OAuth token, or configured installation-ID fallback.

The official [one-day report contract](https://docs.github.com/en/rest/copilot/copilot-usage-metrics?apiVersion=2026-03-10#get-copilot-organization-users-usage-metrics-for-a-specific-day)
is `{ report_day, download_links }`. Every listed part must download completely
before the existing `loadMetricsDay` receives bytes. This path does not replace
the parser, archive, validation, quarantine, transaction, or per-day lock.
The response fixture is synthetic, based on that documented wire shape; it is
not evidence of a successful authenticated request or an owner report capture.
Downloads accept HTTPS Azure Blob or GitHubusercontent subdomains only, without
credentials, redirects, or API authorization headers. Other hosts fail visibly
rather than receiving a token. Each request has at most three attempts with
250/500 ms backoff and a 30-second deadline including the body. Parts are capped
at 128 MiB (including decompressed gzip output), the combined day at 512 MiB, and
the manifest at 1,000 distinct links. HTTP transfer errors and gzip integrity
errors reject the day; no first-part-only publication is possible.

Backfill defaults to yesterday (UTC). An explicitly supplied date must be within
`max(2025-10-10, today - 365 days)` through yesterday, inclusive. Invalid,
expired, current-day, and future dates fail; they are never silently clamped.
Dry-run acquires bytes but does not write to SQL or Blob. Resume checks each
day's current published run for positive, equal read/loaded counts and zero
quarantine; a maximum checkpoint is not sufficient.

Missing/not-ready reports, empty parts, timeouts, incomplete transfers, and
exhausted transient retries are explicit gaps. Acquisition failures use separate
UUID runs; successful publication uses the loader's own run. No ingestion audit
actions are emitted by this path.

## Runtime integration gates

`createMetricsRuntimeHandler` composes the provider, SQL run store, and existing
day loader using the existing metrics settings. Dependencies are initialized
only at invocation, not at module import or handler construction. Invalid
settings or unresolved/invalid App keys fail closed. Each invocation revalidates
the rolling backfill window, resumes only complete days, and throws a sanitized
error when any day is missing or quarantined. Its invocation UUID flows through
API requests, structured logs, failure runs, and the loader.

The owner approved a required `METRICS_SYNC_SCHEDULE` with no default, using
standard six-field UTC NCRONTAB, for example `0 0 * * * *` (hourly),
`0 0 2 * * *` (daily), or `0 0 2 * * 1` (weekly). These are syntax examples, not a
selected deployment cadence. Missing input must fail closed; the Functions host validates NCRONTAB syntax and
ranges when resolving the registered timer.
The authorized #72B base is integrated without duplicating its commits.
The metrics entrypoint registers `metricsSync` with `%METRICS_SYNC_SCHEDULE%`
and `runOnStartup: false`. Its deployable root is
`functions/dist/metrics-artifact`, with `main: dist/function.js`; build with
`npm run build:metrics --workspace functions`. The directory artifact stays
separate at `functions/dist/artifact`. The stack explicitly disables the metrics
timer using `AzureWebJobs.metricsSync.Disabled = true` until #64 proof and
separate activation approval; a packaged timer is not live support evidence.
SQL integration evidence,
#55/#56 deployment gates, and #64 live proof remain separate requirements.

Offline provider/usecase tests must not start services or access live APIs.
Do not run `metrics-day-loader.int.test.ts` on the shared laptop: its SQL/Blob
defaults are quarantined.

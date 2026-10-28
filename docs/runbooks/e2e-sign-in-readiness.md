# Local persona E2E sign-in readiness

Local persona E2E runs start the development server and wait for its existing
`/api/health` readiness check before Playwright global setup runs. The global
setup seeds synthetic SQL authentication data and closes the seed connection,
then makes one unauthenticated GET to the fixed local `127.0.0.1:<E2E_PORT>/sign-in`
route. The response must be HTTP 200 and its full body must be consumed within
45 seconds. Redirects, connection errors, a terminated response body, and
startup timeouts fail setup; this request is not retried. Next stdout and stderr
are piped into Playwright output, and structured readiness events record route,
status, header latency, and completion time without logging the response body.
Next's development-mode Server Action argument logging is disabled through
`logging.serverFunctions: false` in the portal configuration, including ordinary
development runs. This prevents inherited framework argument diagnostics from
appearing alongside the helper's metadata-only events; request and compilation
diagnostics remain enabled.

This separate startup budget does not change the existing 30-second persona
test timeout, its load-event navigation, assertions, or retry policy. Deployed
`BASE_URL` smoke runs and the intentional `E2E_SQL_OUTAGE` suite skip both SQL
auth seeding and local sign-in readiness. The D-41 production test-auth guard
remains unchanged.

A persona browser run after this request measures behavior with the sign-in
route already requested; it is not evidence that the cold route meets the
persona timeout. The original issue evidence remains a 32.64-second HTTP 200
navigation that timed out before persona interaction. A separate 13.63-second
diagnostic observed on-demand `/sign-in` compilation, but does not fully explain
the original delay. Preserve those cold-path results separately from subsequent
warm-route persona evidence.

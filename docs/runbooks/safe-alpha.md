# Safe Alpha release surface

This is the owner-approved restriction slice of #115, not completion of its
expanded reporting scope. Privacy exceptions remain outside this alpha. No new
deployment flag or SQL suppression rule enables the restriction.

## Released and denied surfaces

Only Overview (`/`, or `/overview`) and Copilot Impact (`/copilot-impact`) are
released. They render daily aggregate rows for the latest seven available days
on the server. Overview can also show the parent observed-user count when its
aggregate is independently visible. Child feature/client/agent counts, breakdown
arrays, suppression wrapper metadata, and period interaction totals are not
released in HTML, initial hydration data, or Flight responses.

Excluded core pages, aliases, the Feature Adoption proof of concept, and direct
user details are denied server-side. The same restriction applies to direct
RSC/Flight navigation and prefetch requests; hiding navigation is not the guard.
Help, sign-in, access states, and the health endpoint remain available as before.

`GET /api/usage/overview`, `/api/usage/breakdown`, and `/api/users` authorize first.
Authorized callers receive the same `not_found` 404 before query parsing or usage
reads, independent of parameters and the per-user-detail setting. Signed-out,
no-access, and unavailable callers retain 401, 403, and 503 respectively.
Responses retain private/no-store and correlation IDs. Authorization can still
read permissions; this is not a claim of zero database access.

Scope options come only from effective direct grants: company, canonical reports,
self, or an exact held department/business-area grant. No role alone grants
company data. Invalid, repeated, empty, or stale supplied scope tokens receive
not-found rather than a broader default; only an omitted token defaults.

Suppressed daily rows are removed before the view receives data. The same static
privacy disclosure applies to visible, all-hidden, and no-facts results; absence
does not mean zero and does not reveal hidden group/day counts.

## Synthetic verification

Use an explicitly allocated disposable local SQL database and portal port when
the host is shared. Set the existing SQL connection and local-stack overrides to
that allocation, verify the loopback host/database/container identity before
connecting, and never fall back to another stack. No live identity/provider data
or production resource is needed.
The mutation spec additionally requires an explicit `LOCAL_SQL_PORT` and an exact
match between the SQL connection and that local stack target, including database
`portal_local`. The private shared-host run is separately guarded to its allocated
port; CI uses its own disposable stack mapping, without changing the general
local-stack default.

Run the affected unit tests with the explicit Vitest unit project. The browser
acceptance specs are `core-pages`, `access-states`, `poc-feature-adoption`, and
`safe-alpha-transport`; the public FAQ also has `help` coverage. Run the affected
browser matrix with `E2E_PER_USER_DETAIL_ENABLED=0` and `1`, one worker, and
`--retries=0`, preserving each run's reports, screenshots, and first failure.

The transport spec requests standalone RSC, router-state navigation, and prefetch
variants and verifies `text/x-component` responses, not only document hydration.
Its five-user scenario derives five temporary daily rows from the synthetic
curated fixture in a new reporting window, asserts internal child counts of
one through four, and checks that those children are absent externally. It removes
only those derived rows and verifies the original rows afterward. Its grant test
temporarily revokes only the seeded manager grant, checks the next authenticated
HTML/Flight/API reads, restores it, and verifies the active grant and page.

For actual SQL-outage acceptance, use the existing `E2E_SQL_OUTAGE=1` selector with
only `e2e/outage.spec.ts`, after the allocated SQL service is verified unavailable.
The authenticated page must route to Service unavailable, Flight must redirect
there without reporting data, and all three usage APIs must return 503. This
control skips database auth setup; it does not simulate success or bypass auth.

Never weaken console capture or axe checks. An intentional excluded-page 404
generates a browser resource error, so the released-page no-console-errors
assertion runs before that intentional navigation; the explicit 404 assertion
and excluded-page axe audit remain.

## Turning on the upstream views

`modules.upstream_views = true` replaces this release surface with every upstream
view, built from the curated SQL facts. Each day, IDE, version, feature, language,
model, usage type and adoption phase group with fewer than `min_group_size`
distinct users is hidden, and a scope that ends up below the minimum shows
nothing. The viewer's own data and `per_user_detail_enabled` are exempt; without
per-user detail, Users and User Details stay hidden and logins become placeholders.

To turn it on in an environment:

1. Pin a release that has both inputs (0.2.25 or later; `min_group_size` arrived in #220).
2. In that environment's tfvars, set `upstream_views = true` inside `modules` and
   `min_group_size` to the agreed minimum (default 5, at least 2).
3. Run a plan. Expect only the portal app settings to change:
   `MODULE_UPSTREAM_VIEWS` to `true` and `MIN_GROUP_SIZE` to the new value. Nothing
   else, and no SQL change.
4. Apply, then sign in and check that the new views appear and small groups are hidden.

To turn it off again, set `upstream_views = false` and apply; no data changes.

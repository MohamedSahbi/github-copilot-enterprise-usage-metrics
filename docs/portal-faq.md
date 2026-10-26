# Portal FAQ

Help with the portal, without needing access to usage data. Your deployment may not include every feature described here.

[Data](#data) · [Access](#access) · [Features](#features) · [Privacy](#privacy)

## Data

### Why are usage date ranges fixed?

Usage reports support the last 7, 28, or 90 days, or a whole calendar month. Rolling periods end on the latest usage day available in the portal, not necessarily today. A calendar month must be complete. You cannot choose arbitrary start and end dates.

Fixed periods protect individuals in aggregate-only mode: with arbitrary overlapping ranges, someone could subtract two aggregate results to isolate one person's usage on a single day. The API continues to suppress aggregate groups smaller than the configured minimum, which defaults to five.

Fixed periods do not eliminate all overlap. The last 7 days are nested within the last 28 days, which are nested within the last 90 days, so subtraction between those periods can still reveal differences. This is an accepted trade-off at the five-user minimum. Per-user detail is governed separately by the deployment setting `PER_USER_DETAIL_ENABLED`.

Why (maintainers): fixed-period owner decision in [PR #108](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/pull/108), and the [privacy design](architecture/decision-record.md#6-sql-data-model-raw--staging--curated--control).[^periods]

### Why are some numbers hidden?

The portal hides aggregate results for groups smaller than the deployment's minimum group size, normally five users. Hidden does not mean zero, no activity, or a broken chart. Choosing a larger scope may make an aggregate available, but you can only choose scopes you already have permission to see. The [fixed reporting periods](#why-are-usage-date-ranges-fixed) provide another privacy protection.[^hidden]

### How fresh is the data?

Usage is loaded in scheduled batches, not live as you use Copilot. Recent activity can be missing until GitHub publishes its report and the next successful load finishes. Directory and permission updates have their own sync schedule.

If you see "data may be stale", treat the figures as potentially out of date, not as proof that nobody used Copilot. Try again later; if the warning persists, use your deployment's support channel. The monitoring design uses a configurable freshness threshold (36 hours by default); that is not a promise that each page refreshes within 36 hours. Not every current page displays a freshness warning.[^freshness]

### Why is someone who used Copilot missing?

Check that you are looking at the right reporting period and an allowed scope. A Copilot license or seat alone does not guarantee a usage record: activity must be included in a published report, loaded successfully, and linked to the directory identity. Using a different signed-in GitHub account, a recent license change, or a directory sync still in progress can delay or prevent that match. Aggregate-only mode and small-group suppression can also hide individual results. Ask your deployment's support contact to investigate; do not share credentials.[^missing]

## Access

### Why do I see No access?

You have signed in, but the portal has not found usable permissions for your linked identity. Signing in does not itself grant access. Use the request link or contact shown on the No access page, if your deployment supplies them. If neither is shown, contact the team that provided your portal link through your usual internal support channel. This FAQ cannot grant access.[^no-access]

### Why is the service unavailable?

The portal cannot safely verify permissions right now, so it does not release usage data. This is different from having no assigned access. Retry later; if it continues, report the service problem through your normal support channel. You do not need a new access request just because the service is unavailable. Elevated access can also be denied when directory information is too old to trust.[^unavailable]

### What can each role see?

Your assigned scope matters as well as your role. A role never grants access to every person automatically.

- **Member:** self scope (your own data), still subject to aggregate-only restrictions and suppression.
- **Manager:** self or team scope, when assigned. A team uses direct and indirect reports in the current hierarchy, not the hierarchy from the date of the activity.
- **Executive:** the assigned department, business area, or company scope.
- **Admin:** company scope. Administration capabilities are part of the design, but admin management pages are not yet provided by this release.

The current shell offers core usage pages according to role. The Users page is additionally hidden unless per-user detail is enabled. Changing a scope selector cannot expand your permissions.[^roles]

### How do I request access?

Use the request link or contact configured on the No access page. Your deployment's access administrators decide which role and scope to assign; this public project does not define your organization's approval policy or support address. If you already have access but need a wider scope, use the same internal access process.[^request]

### Why do I sign in with my company account or a linked GitHub account?

The portal supports Microsoft Entra ID (your company account) and GitHub sign-in. Permissions belong to a single internal identity tied to your company account's immutable identifier. A GitHub sign-in needs a stored link to that identity to use its permissions. An unlinked GitHub account does not gain company permissions just by signing in. Account linking depends on your deployment's directory setup; signing in with both providers is not a self-service linking feature in this release.[^sign-in]

### Why not look me up by email or login?

Email addresses and GitHub logins can change or be reused. They may be shown for recognition, but they are never permission keys. The portal uses immutable account identifiers and a stored identity link instead. A matching email or a familiar login is not enough to grant access.[^identity]

## Features

### What are AI Credits and Budget Lookup?

**AI Credits** is the optional reporting module for Copilot AI Credit usage. It is separate from the core usage charts; the current release has ingestion and contracts, but does not yet provide its reporting pages.

**Budget Lookup** is a planned optional, read-only view of applicable GitHub budgets. Its design reads live GitHub budget information within your permitted scope, unlike the stored usage reports. It does not create or change budgets or cost centers, automate billing, or fall back to an old database. It is not yet available as a portal page in this release.[^modules]

### Why is a module missing?

AI Credits, Budget Lookup, and Feedback are optional. A deployment can turn a module off; an unfinished module also will not appear. Turning a module on only controls availability and visibility, never grants permission to its data. A missing module does not mean your core usage access is broken.[^flags]

### Where can I send feedback?

Use your deployment's usual support or feedback channel. The optional Feedback module is planned for submitting ideas and problems, but its in-portal pages are not yet available in this release. No universal organization contact is provided by this project. Do not include credentials, private usage details, or screenshots of other people's data in a public report.[^feedback]

## Privacy

### What does the portal store about me?

The design stores account identifiers and their links, directory attributes such as department and reporting relationships, and daily Copilot usage facts. AI Credit usage is stored when that ingestion is enabled. It also records permission changes and operational audit events; login history is reserved for admin reads.

Raw report files are archived separately from the reporting database. The retention design keeps per-user daily facts for 13 months by default (up to 36), login history for 24 months by default (up to 60), aggregates indefinitely, and raw archives without deletion. Your deployment controls the configurable periods. These are design and configuration defaults, not a guarantee about a particular deployment's data or retention. Core reporting uses usage counts, not a view of your source code or prompt text.[^stored]

### Can my manager see my individual usage?

By default the portal returns aggregates, with small groups hidden. Individual usage is available only when the deployment enables `PER_USER_DETAIL_ENABLED`, and only within the viewer's authorized scope. If enabled, a manager with the appropriate team grant can see individual usage for direct and indirect reports in the current hierarchy. Enabling detail does not give a manager access outside that scope. Ask your deployment's administrator whether detail is enabled; do not infer it from an empty or hidden result.[^manager]

## Why notes for maintainers

These references explain the governing decisions; historical observations in the decision record are not claims that all planned features are implemented.

[^periods]: [Fixed-period implementation and accepted overlap trade-off (PR #108)](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/pull/108); [privacy, §6](architecture/decision-record.md#6-sql-data-model-raw--staging--curated--control).
[^hidden]: [Privacy and minimum group size, §6](architecture/decision-record.md#6-sql-data-model-raw--staging--curated--control).
[^freshness]: [Monitoring and freshness, §6.3](architecture/decision-record.md#63-performance-monitoring-and-retention); [D-24](architecture/decision-record.md#14-decision-record).
[^missing]: [Ingestion steps, §6.2](architecture/decision-record.md#62-ingestion-operations-per-run); [identity and scope, §13.1](architecture/decision-record.md#131-security).
[^no-access]: [D-17 and the three access states, §13.1](architecture/decision-record.md#131-security).
[^unavailable]: [D-17 fail-closed behavior, §13.1](architecture/decision-record.md#131-security).
[^roles]: [D-5 roles and scopes, §13.1](architecture/decision-record.md#131-security); [D-16 current hierarchy](architecture/decision-record.md#14-decision-record).
[^request]: [D-17 configurable No access page, §13.1](architecture/decision-record.md#131-security).
[^sign-in]: [D-5 and D-36 identity linking, §13.1](architecture/decision-record.md#131-security).
[^identity]: [D-5 immutable identity, §13.1](architecture/decision-record.md#131-security).
[^modules]: [D-1, D-8 and D-55](architecture/decision-record.md#14-decision-record); [Budget Lookup, §6.5](architecture/decision-record.md#65-independent-database-and-table-ownership-d-29-d-34).
[^flags]: [Feature flags, §13.1](architecture/decision-record.md#131-security).
[^feedback]: [D-1 and D-13 optional Feedback](architecture/decision-record.md#14-decision-record).
[^stored]: [D-11 and D-12 retention, §6.4](architecture/decision-record.md#64-decided-parameters); [privacy, §6](architecture/decision-record.md#6-sql-data-model-raw--staging--curated--control).
[^manager]: [Aggregate-only default and scoped detail, §13.1](architecture/decision-record.md#131-security); [D-16](architecture/decision-record.md#14-decision-record).

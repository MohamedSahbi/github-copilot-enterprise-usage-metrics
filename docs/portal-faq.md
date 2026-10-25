# Portal FAQ

## Why are usage date ranges fixed?

Usage overview, breakdown, and user requests accept only the last 7, 28, or 90 days, or a whole calendar month. Rolling periods end on the latest usage day available in the curated daily facts. For a calendar month, send its `YYYY-MM` value; the portal computes the first and last day and rejects the month if it is not yet complete. Clients cannot choose arbitrary `from` and `to` dates.

Fixed periods protect individuals in aggregate-only mode: with arbitrary overlapping ranges, someone could subtract two aggregate results to isolate one person's usage on a single day. The API continues to suppress aggregate groups smaller than the configured minimum, which defaults to five.

Fixed periods do not eliminate all overlap. The last 7 days are nested within the last 28 days, which are nested within the last 90 days, so subtraction between those periods can still reveal differences. This is an accepted trade-off at the five-user minimum. Per-user detail is governed separately by the deployment setting `PER_USER_DETAIL_ENABLED`.

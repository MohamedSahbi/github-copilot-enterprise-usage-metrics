---
description: "Use when touching authentication, authorization, scope resolution, API routes, identity linking, admin, or feedback visibility."
applyTo: "portal/src/app/api/**,portal/src/auth/**,portal/src/authz/**"
---

# Authentication and authorization (D-5, D-16, D-17, D-36)

- Sign-in providers: Entra ID and GitHub. Both resolve to one internal principal keyed on Entra tenant ID + object ID.
- A GitHub identity gets permissions only through a stored `github_user_id` ↔ `entra_object_id` link. Links are one-to-one and removed when the Entra account is disabled. An unlinked GitHub login sees at most its own data.
- Never authorize from email, login, display name, or provider.
- Every API route resolves scope server-side (team = direct and indirect reports from the current hierarchy) and filters in SQL. Never trust a scope sent by the client.
- Fail closed: if permissions cannot be read, deny data access. Only the break-glass Entra group reaches admin and health pages.
- Distinct responses: not signed in → sign-in; no permission → configurable No access page; SQL unavailable → Service unavailable page.
- Child resources (for example feedback screenshots) check the parent's visibility.
- Every authorization rule has a test for allowed and denied cases.

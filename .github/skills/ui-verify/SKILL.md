---
name: ui-verify
description: 'Verify a UI change in a real browser: start the local stack, sign in as test personas, check affected pages, console errors, accessibility, and capture screenshots. Use after any change to pages, charts, navigation, sign-in states, or module flags. Works with the VS Code integrated browser and the Playwright browser of the Copilot coding agent.'
---

# UI verification in the browser (D-42)

## When to use

- Any change to pages, charts, adapters, navigation, sign-in/no-access/outage pages, or module visibility.

## Procedure

1. Start the local stack: `npm run dev:stack` (SQL Server container, Azurite, seeded fixtures, portal with `E2E_TEST_AUTH=1`). Wait until `/api/health` returns healthy.
2. Open the portal:
   - **VS Code:** use the integrated browser tools to open `http://localhost:3000`.
   - **Copilot coding agent on github.com:** use the built-in Playwright browser.
3. For each affected page, and for each relevant persona (admin, manager, member, no-access, unlinked GitHub user):
   - Sign in through the test sign-in page.
   - Confirm the page renders, data matches the persona's scope, and empty states are sensible.
   - Check the browser console: no errors or failed requests.
   - Capture a screenshot.
4. If the change affects module flags, repeat with the module on and off.
5. Run `npm run test:e2e` for the affected specs, including axe checks.

## Report

Add to the PR description: pages and personas checked, screenshots, console status, axe result, and anything that looked wrong but was out of scope.

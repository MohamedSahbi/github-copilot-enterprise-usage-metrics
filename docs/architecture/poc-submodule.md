# Submodule proof of concept (decision record §10.1)

Pinned upstream commit: `00608a2bc10fe61c3316d4e90e8eb51fb169bf6e` (`asizikov-demos/copilot-user-level-statistics-viewer`, `main`, 2026-10-20). Upstream files are untouched (`git -C portal/upstream status` is clean).

Chart proven: upstream `FeatureAdoptionChart`, rendered at `/poc/feature-adoption` from a hard-coded fixture through `portal/src/adapters/featureAdoption.ts`.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | The agent environment checks out the submodule | **Pass for Actions; coding-agent session not yet run** | `copilot-setup-steps.yml` runs with `submodules: recursive`, `npm ci`, and Playwright install and succeeds on the PR. The Copilot coding agent itself has not been started; the owner confirms by assigning the first `ready-for-agent` issue and checking the session log. |
| 2 | Next.js 16 with Turbopack builds and traces source outside the app root | **Pass** | Next.js 16.4.3 `next build` succeeds with `output: "standalone"`, `outputFileTracingRoot` and `turbopack.root` set to the repository root (dependencies are hoisted there by the npm workspace). `portal/.next/standalone` contains the compiled upstream chart. The page renders in Chromium with no console errors. Also passes on Node 22.23. |
| 3 | Upstream's path alias does not clash with ours | **Pass** | Upstream declares `@/*` and `#domain/*`/`#utils/*`. Its non-test source uses neither for the chart and its dependencies. Our `@/*` (portal `src`) and `@upstream/*` (upstream `src`) build and typecheck without clash. Caveat: if a later chart imports upstream code that uses `@/` or `#…`, re-run this check. |
| 4 | EMU CI can fetch from public `github.com` | **Not verifiable here** | This repository is not on EMU. Public `github.com` fetch works from GitHub-hosted Actions. The owner must run the CI workflow (or `git submodule update --init`) in the EMU environment; failure triggers the subtree fallback. |

## Findings

- Our stricter `noUncheckedIndexedAccess` fails on upstream code; the portal tsconfig turns it off (the root base keeps it for `shared/`, `functions/`, scripts).
- Upstream charts need Tailwind and Primer CSS. `globals.css` mirrors upstream's imports and adds `@source "../../upstream/src"` so Tailwind sees upstream class names.
- Axe finds one violation inside the upstream chart (canvas without accessible name, `role-img-alt`). It cannot be fixed without editing upstream; tracked in issue #1 and excluded by rule in the E2E check.

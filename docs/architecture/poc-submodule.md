# Submodule proof of concept (decision record §10.1)

Pinned upstream commit: `00608a2bc10fe61c3316d4e90e8eb51fb169bf6e` (`asizikov-demos/copilot-user-level-statistics-viewer`, `main`, 2026-10-20). Upstream files are untouched (`git -C portal/upstream status` is clean).

Chart proven: upstream `FeatureAdoptionChart`, rendered at `/poc/feature-adoption` from a hard-coded fixture through `portal/src/adapters/featureAdoption.ts`.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | The agent environment checks out the submodule | **Pass** | In a Copilot coding agent session, `git submodule status` shows `portal/upstream` checked out at the pinned commit and its chart sources are present (see Coding agent environment below). |
| 2 | Next.js 16 with Turbopack builds and traces source outside the app root | **Pass** | Next.js 16.4.3 `next build` succeeds with `output: "standalone"`, `outputFileTracingRoot` and `turbopack.root` set to the repository root (dependencies are hoisted there by the npm workspace). `portal/.next/standalone` contains the compiled upstream chart. The page renders in Chromium with no console errors. Also passes on Node 22.23. |
| 3 | Upstream's path alias does not clash with ours | **Pass** | Upstream declares `@/*` and `#domain/*`/`#utils/*`. Its non-test source uses neither for the chart and its dependencies. Our `@/*` (portal `src`) and `@upstream/*` (upstream `src`) build and typecheck without clash. Caveat: if a later chart imports upstream code that uses `@/` or `#…`, re-run this check. |
| 4 | EMU CI can fetch from public `github.com` | **Not verifiable here** | This repository is not on EMU. Public `github.com` fetch works from GitHub-hosted Actions. The owner must run the CI workflow (or `git submodule update --init`) in the EMU environment; failure triggers the subtree fallback. |

## Findings

- Our stricter `noUncheckedIndexedAccess` fails on upstream code; the portal tsconfig turns it off (the root base keeps it for `shared/`, `functions/`, scripts).
- Upstream charts need Tailwind and Primer CSS. `globals.css` mirrors upstream's imports and adds `@source "../../upstream/src"` so Tailwind sees upstream class names.
- Axe finds one violation inside the upstream chart (canvas without accessible name, `role-img-alt`). It cannot be fixed without editing upstream; tracked in issue #1 and excluded by rule in the E2E check.

## Coding agent environment

Results from a Copilot coding agent session (2026-10-23, issue #3).

| Probe | Result |
| --- | --- |
| `git submodule status` | `00608a2bc10fe61c3316d4e90e8eb51fb169bf6e portal/upstream (heads/main)`: checked out |
| `ls portal/upstream/src/components/charts \| head` | `ActivityBreakdownChart.tsx`, `AgentActivityChart.tsx`, `AiCreditsChart.tsx`, `AutoModeAdoptionTrendChart.tsx`, `CLIAdoptionTrendChart.tsx`, `CLIOverlapChart.tsx`, `CLISessionChart.tsx`, `CLITokensChart.tsx`, `CLIUsersChart.tsx`, `ChatRequestsChart.tsx` |
| `node -v` | `v22.23.3` |
| `npm ci` | exit status 0, `found 0 vulnerabilities` |
| `npx playwright --version` | `Version 1.64.1` |
| `docker version` | Works; Docker Engine - Community 28.0.4 (API 1.48) |
| `docker pull mcr.microsoft.com/mssql/server:2022-latest` | Works; `Status: Downloaded newer image for mcr.microsoft.com/mssql/server:2022-latest`, digest `sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718` |
| Create issue "agent issue-creation probe" | Not possible: the agent's toolset has only read tools for issues (read, list, search) and no create or close tool, so no issue was created and nothing needed closing. Agents must record bugs by another route (list them under `## Out-of-scope bugs found` in the PR description; the bug-backlog workflow creates the issues, see §13.5). |

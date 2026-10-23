---
name: report-bug
description: 'Record a bug as a GitHub issue instead of fixing it. Use when tests, browser checks, or code reading reveal a defect outside the current task scope, when checking the bug backlog at the start of a task, or when a security problem is found.'
---

# Report a bug (D-44, D-45)

The bug backlog is **GitHub Issues** labelled `bug`. There is no backlog file.

## Is it in scope?

- **In scope** — the defect breaks or blocks the feature being delivered, or was introduced by this change. Fix it in the current PR with a test.
- **Out of scope** — anything else. Do not fix it, do not skip or weaken tests to hide it. Record it.
- **Existing test fails and this change did not cause it** — the main branch is already broken. Create a `severity:high` issue, stop, and tell the owner. Never mark an existing test `fixme`.

## Evidence required

Create an issue only with a reproduction: a failing test, a screenshot, or exact steps. Suspicions, style remarks, and improvement ideas go in the PR description under `## Observations`, not in the backlog.

## Security problems

This repository is public. Never put a vulnerability in a public issue, PR, or commit message. Stop, tell the owner in the session or PR ("Security issue found, details withheld"), and recommend a private vulnerability report (Security → Advisories).

## Record an out-of-scope bug

1. Search open issues for duplicates (title keywords, file path). If found, add a comment with the new evidence instead.
2. Create an issue (or, if you cannot create issues in this environment, add it to the PR description under `## Out-of-scope bugs found`; a workflow turns that section into issues for PRs opened by Copilot or the owner only, at most 5 per PR, skipping duplicates):
   - **Title:** `bug: <component>: <short symptom>`
   - **Labels:** `bug`, `triage`, `found-by-agent`, and `severity:high|medium|low`
   - **Body:**
     - Where: file and line, page, or endpoint
     - What happens / what should happen
     - Steps to reproduce (persona, data, command)
     - Evidence: test output, screenshot, log excerpt (no secrets or personal data)
     - Found while: PR or task link
     - Related decision: `D-<n>` if any
3. Mention the issue number in the PR description.
4. If a test you wrote in this task exposes the bug, mark that test `fixme` with the issue number. Only tests you wrote may be marked `fixme`.

Every new issue starts as `triage`; the owner confirms or closes it.

## Severity

- **high** — wrong data shown, authorization or data-integrity risk, ingestion data loss, deployment blocked
- **medium** — feature broken with a workaround, wrong numbers in a non-critical view
- **low** — cosmetic, wording, minor UX

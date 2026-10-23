---
name: systematic-debugging
description: 'Find the root cause before fixing any failing test, CI failure, ingestion error, reconciliation mismatch, wrong chart number, or deployment problem. Use whenever something behaves unexpectedly, especially after a first fix did not work.'
---

# Systematic debugging

Adapted from obra/superpowers (MIT). No fix without a root cause.

## 1. Investigate

1. Read the full error, stack trace, and log entries for the correlation ID.
2. Reproduce it reliably: exact command, persona, day, fixture. If it is not reproducible, gather more data; do not guess.
3. Check what changed: the diff, recent merges, dependency or submodule bumps, configuration.
4. Find **where** it breaks before **why**. Check the data at each boundary of the pipeline and note the first one that is wrong:

   `GitHub/Graph/SCIM response → raw Blob → staging → curated SQL → API response → adapter → upstream chart props`

## 2. Compare

- Find a working case (another day, persona, module, or the upstream oracle) and list every difference from the failing one.

## 3. Hypothesis

- Write one hypothesis: "X is the cause because Y". Test it with the smallest change, one variable at a time. If it is wrong, form a new hypothesis; do not stack fixes.

## 4. Fix

1. Write a failing test that reproduces the bug and watch it fail.
2. Make one fix at the root cause, not at the symptom.
3. Run the test and the full suite; report the output.

## Stop rules

- **Three fixes failed:** stop. The problem is likely structural or a wrong decision. Report what you tried and what you learned to the owner instead of trying a fourth fix.
- **The root cause is outside the task scope:** record it with the `report-bug` skill.
- **Truly environmental or external** (GitHub API outage, throttling): document the evidence, add handling (retry, clear error), and make sure monitoring would catch it again.

## Red flags

"Quick fix for now", "let me just try", several changes in one run, proposing fixes before locating the failing boundary, "it's probably X". Any of these: go back to step 1.

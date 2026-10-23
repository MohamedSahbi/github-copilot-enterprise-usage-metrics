---
name: decision-check
description: 'Check a plan, issue, or PR against the architecture decision record (D-1 to D-38) and report conflicts. Use before starting a phase, when a request seems to contradict the design, or when reviewing a large PR.'
---

# Decision check

## Procedure

1. Read `docs/architecture/decision-record.md`, especially §14 (decisions), §17 (open items), and §18.1 (deviations).
2. List the decisions the plan or PR touches.
3. For each, state: complies / conflicts / not covered.
4. For conflicts, quote the decision and propose the smallest compliant alternative.
5. For "not covered", propose a new decision row with ID, wording, and rationale; do not implement it until a human approves.

## Output

A table: Decision ID | Status | Note. Then a one-line verdict: proceed / proceed with changes / stop for decision.

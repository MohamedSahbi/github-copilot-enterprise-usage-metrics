---
name: system-design
description: 'Design or evaluate services, data models, APIs and architectures with explicit trade-offs. Use when planning a new module, boundary, data flow or API contract, before proposing a decision-record change.'
---

# System design

Adapted from the `system-design` skill in anthropics/knowledge-work-plugins (found via Agent Finder). Always check `docs/architecture/decision-record.md` first: a design that conflicts with a decision stops and names the decision (use `decision-check`).

## Framework

1. **Requirements.** Functional behaviour; non-functional targets (scale, latency, availability, cost, privacy); constraints (team size, existing stack, public repo, single tenant per deployment).
2. **High-level design.** Components, data flow, one writer per data store/table, API contracts, storage choices.
3. **Deep dive.** Data model and keys (immutable IDs, mutable attributes), API shapes (bounded ranges and pages, typed errors, correlation IDs), idempotency and replay, queues/events, error handling and retries.
4. **Scale and reliability.** Load estimate, failure modes, fail-closed behaviour, backfill/replay, monitoring and alerting.
5. **Trade-offs.** For every choice state the alternative, the cost, and what would make you revisit it.

## Output

A short structured design: assumptions, diagram or described data flow, decision list with trade-offs, open questions (never invent decisions), and what to revisit as the system grows. Put proposed record changes in the PR text, not in the record.

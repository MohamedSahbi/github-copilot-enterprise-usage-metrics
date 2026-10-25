---
description: "Use when changing portal pages, components, adapters, access presentation, or data-source wiring."
applyTo: "portal/src/app/**,portal/src/components/**,portal/src/adapters/**,portal/src/access/**,portal/src/data/**,portal/src/navigation/**"
---

# Portal UI boundaries (D-11, D-14, D-15, D-17)

- This portal uses Next.js 16. Before changing framework behavior or APIs, read the relevant installed guide under `node_modules/next/dist/docs/` (the workspace may hoist `next` to the repository root); follow that version's guidance rather than assumptions from older Next.js versions.
- Keep data loading and aggregation on the server. Never parse or aggregate raw metrics NDJSON in browser code; synthetic fixtures are for guarded tests only, not production fallback.
- Keep page data behind typed server-side data-source boundaries and use existing shared API DTOs. Do not duplicate contracts or move query logic into client components; track contract gaps separately.
- Derive data visibility from the server-resolved authorized scope. Navigation and scope selectors are presentation controls, not authorization; never infer permission from a persona name or client-supplied scope. Follow `.github/instructions/security-authz.instructions.md` for authorization details.
- Compose upstream charts through owned adapters and accessible wrappers; never edit `portal/upstream/`. Follow `.github/instructions/upstream-boundary.instructions.md` for the upstream contract.
- UI E2E coverage runs axe without rule exclusions, asserts no browser console errors, and exercises relevant allowed and denied persona/scope cases. Follow `.github/instructions/testing.instructions.md`.

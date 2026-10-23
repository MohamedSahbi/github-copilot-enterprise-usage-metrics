## Summary

Closes #

<!-- One or two sentences: what changed and why. -->

## Decisions

<!-- D-<n> implemented or touched. Say explicitly if the decision record was changed. -->

## Definition of done

- [ ] Scope matches the issue; nothing outside "Out of scope" changed
- [ ] Tests added or updated; lint, typecheck, unit, contract, integration pass
- [ ] UI changes verified in a browser with test personas; screenshots below (`ui-verify` skill)
- [ ] E2E specs pass for affected pages, including axe
- [ ] Migrations use timestamped names and change only `portal` schema tables
- [ ] No secrets, organization-specific names, or personal data in code, fixtures, or logs
- [ ] Spec-reviewer verdict `spec ✅` (every acceptance criterion met with evidence, nothing extra)
- [ ] Security-reviewer pass done (required for auth, API, `db/`, `infra/`, `functions/`)
- [ ] Docs and runbooks updated where behaviour or operations changed

## Evidence

<!-- Fresh output from this session, not from memory. Paste summary lines:
lint: ... | typecheck: ... | tests: N passed, M failed (names) | build: exit 0
For each acceptance criterion: criterion → test name or screenshot.
Terraform plan summary when infra/ changed. -->

## Out-of-scope bugs found

<!-- Only with a reproduction. Format per item: title | severity | where | steps. Leave empty if none. -->

## Observations

<!-- Unproven suspicions or improvement ideas. Not turned into issues. -->

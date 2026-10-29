# Runbook: import metrics history (backfill) through the pipeline

Fills past days from GitHub's one-day usage reports, after clearing any synthetic seed data. Every step runs
from the deployment pipeline with its own Entra sign-in; nothing is typed into the database by hand. Output is
counts, days, scope keys and run IDs only.

GitHub keeps one-day reports for 365 days. The metrics timer fetches every day from `BACKFILL_FROM` to yesterday,
skips days that already have a published run, and resumes on the next run where the last one stopped.

## Gates

- Owner approval for each data-bearing step: the synthetic delete (step 3) and the backfill apply (step 4).
- A restore point before the delete (see [restore and rollback](restore-rollback.md)). Azure SQL point-in-time
  restore covers it; record the time the pipeline ran.
- The metrics timer must be completing runs first (step 1). A timer that fails every run imports nothing.

## Steps

Each `scripts/data-ops.sh` call goes in a pipeline step that runs after `scripts/deploy-infra.sh init`, signed in as
the SQL Entra admin group member that also runs `scripts/deploy-db.sh`.

1. **Check the timer and the current state (read-only).**

   ```sh
   scripts/data-ops.sh status --from 2026-09-01
   ```

   Each day and organization is `published` (with loaded and quarantined row counts), `failed` (with the last
   error code), `started` or `gap`. Recent days `published` means the GitHub App token works on the report
   endpoint. `failed` with the same error every day means fix that first.

2. **Find synthetic runs (read-only).** The same output lists `syntheticRunIds`: published runs the metrics loader
   did not write (no `raw/users_1_day/.../<run_id>.ndjson` archive). A synthetic run on a real organization's day
   counts as complete, so the backfill skips that day until the run is removed. Then preview the delete:

   ```sh
   scripts/data-ops.sh remove-synthetic
   ```

   It deletes inside a transaction, prints `runIds`, `factRows` and per-table counts, and rolls back.

3. **Remove synthetic runs (owner approval).** With the `factRows` value from the preview:

   ```sh
   scripts/data-ops.sh remove-synthetic --execute --expect-fact-rows <n>
   ```

   It commits only if the count still matches. Seeded `dim_user` rows, access grants and directory state are not
   touched (see [remove ingestion runs](remove-runs.md)).

4. **Turn on the backfill (owner approval).** Set `backfill_from = "<yyyy-mm-dd>"` in the environment's tfvars,
   plan (expect only the `BACKFILL_FROM` app setting on the metrics Function App), then apply.

5. **Report each day.** Rerun step 1 after the timer has had time to catch up. Every day should be `published`;
   `failed` days carry the error code, and days with quarantined rows are in Administration > Validation issues.
   For a byte-level check of published days against the raw archive or legacy files, see
   [metrics reconciliation](metrics-reconciliation.md).

6. **Turn the backfill off** once every day is `published`: remove `backfill_from`, plan, apply. The timer goes
   back to yesterday only, and remove the temporary data step from the pipeline. A `BACKFILL_FROM` older than 365 days makes the timer fail on purpose.

## Pipeline step (Azure DevOps example)

This is a one-time, temporary step, not part of every deploy. Add it only for the import, queue the pipeline by
hand with `dataOperation` set for each step above, and delete the step (and the parameter) once the synthetic runs
are gone and every day is `published`. A run with the default `none` skips it entirely. Rerunning
`remove-synthetic` after the cleanup finds nothing and changes nothing.

```yaml
- task: AzureCLI@2
  displayName: Data operation (${{ parameters.environment }})
  inputs:
    azureSubscription: $(azureServiceConnection)
    scriptType: bash
    scriptLocation: inlineScript
    inlineScript: |
      set -euo pipefail
      portal/scripts/deploy-infra.sh init "${{ parameters.environment }}" "config/${{ parameters.environment }}.tfvars"
      git -C portal checkout -- infra/terraform/stack/.terraform.lock.hcl
      portal/scripts/data-ops.sh ${{ parameters.dataOperation }}
  condition: ne('${{ parameters.dataOperation }}', 'none')
```

```yaml
parameters:
  - name: dataOperation
    type: string
    default: none   # e.g. "status --from 2026-09-01", "remove-synthetic", "remove-synthetic --execute --expect-fact-rows 63"
```

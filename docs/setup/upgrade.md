# Upgrade to a new release

Each release is a git tag (`v0.2.26`, `v0.2.27`, ...) with its changes listed in
[CHANGELOG.md](../../CHANGELOG.md) and on the
[releases page](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/releases).
Your deployment repository pins one tag in `config/deployment.yml`, and an upgrade is a reviewed change
to that pin. Upgrade one environment at a time, `dev` first.

While the portal is 0.x, any release can add a required input or a migration, so read every changelog
entry between your version and the target, not only the last one. You can skip versions: Terraform
and the migration runner catch up in one run.

## 1. Read what changed

Open the compare view, for example
`https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.25...v0.2.27`, and
note:

- **New or changed inputs.** Compare `infra/terraform/stack/terraform.tfvars.example` between the two
  tags. An input without a default must be added to your tfvars before the plan.
- **New secrets.** Compare `terraform output -json secret_names` before and after. A new name must exist
  in Key Vault before the full apply.
- **Migrations.** New files under `db/migrations`. They are forward-only.
- **Template changes.** Wrapper or config changes in the deployment template are copied by hand in a
  reviewed pull request; never overwrite your own `config/*` values.

## 2. Record a restore point

If the database holds data and the release has migrations, record a restore point first, as in
[restore and rollback](../runbooks/restore-rollback.md#before-every-data-bearing-change). Redeploying an
older release does not undo a migration.

## 3. Change the pin and plan

In your deployment repository, open a pull request that changes the pinned version (and adds any new
inputs). Run the plan for the environment and review it. Expect only the changes the changelog
describes. Stop if the plan replaces SQL, Storage or Key Vault, or removes a role assignment you did
not expect.

## 4. Apply and deploy

After the pull request is approved, from a checkout of the new tag:

1. Apply the plan: `scripts/deploy-infra.sh apply <env> config/<env>.tfvars`.
2. Run the migrations and grants ([migrations runbook](../runbooks/migrations.md#pipeline)).
3. Deploy the code with `scripts/deploy-portal.sh` and `scripts/deploy-functions.sh` (metrics and
   directory). Each script prints the version it deploys, for example
   `Deploying portal v0.2.27 to <app>`.

Infrastructure, migrations and code ship together. A new portal release on old infrastructure can
miss app settings it needs.

## 5. Check

- `curl https://<portal-host>/api/health` returns `{"status":"ok"}`, and
  `BASE_URL=https://<portal-host> npm run test:smoke` passes.
- Sign in as an admin. **Administration > Sync Status** shows no new warnings, and the next scheduled
  syncs succeed.
- The dashboards show the same numbers as before for a day you know.

Then repeat for the next environment.

## Rolling back

- **No migration in the release:** set the pin back to the previous tag and run the same steps.
- **With a migration:** the schema stays at the new version. Fix forward with a new release, or restore
  the database from the restore point you recorded and then redeploy the previous tag. Restoring loses
  writes made after the restore point, so stop the syncs first.

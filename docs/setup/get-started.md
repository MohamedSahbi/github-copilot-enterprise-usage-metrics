# Get started in an hour

This guide takes a new organization from nothing to a portal that people can sign in to. The hour is
hands-on time once the approvals in [Before you start](#before-you-start) are in hand; admin consent in
Entra and installing a GitHub App on the enterprise often take longer to arrange than the deployment.

The first deployment shows no usage data. Data arrives when you switch on the syncs in
[step 6](#6-switch-data-on), after their gates pass.

## Before you start

Ask for these first. The full checklist is in [prerequisites](prerequisites.md).

| You need | Who usually has it |
| --- | --- |
| An Azure subscription where you can grant roles (Owner, or Contributor plus User Access Administrator) | Cloud platform team |
| An Entra app registration for sign-in, with a client secret | Entra admin |
| A GitHub OAuth app for sign-in, with a client secret | GitHub organization owner |
| A GitHub App for the metrics sync, installed on the enterprise, with its private key | GitHub enterprise owner |
| A classic PAT for the directory sync (`read:org`, `admin:enterprise`) from an enterprise owner account | GitHub enterprise owner |
| Graph `User.Read.All` with admin consent for the directory sync identity | Entra admin |
| The "Copilot usage metrics" policy turned on for the enterprise | GitHub enterprise owner |

Sign-in callback URLs for the two apps, with the default host name:

- Entra: `https://<portal-app-name>.azurewebsites.net/api/auth/callback/microsoft-entra-id`
- GitHub: `https://<portal-app-name>.azurewebsites.net/api/auth/callback/github`

`<portal-app-name>` is the `portal_app_name` output after the first apply. Set `portal_public_url` if you
use a custom domain, and register that host instead.

On your machine: Terraform 1.11 or newer, the Azure CLI, Node 22, and git.

## 1. Create a private deployment repository

Keep your organization's values out of this public repository. Create a private repository that holds:

- `config/<env>.tfvars`: copied from
  [terraform.tfvars.example](../../infra/terraform/stack/terraform.tfvars.example)
- `config/deployment.yml`: the portal release you pin, for example `v0.2.27`
- your pipeline wrapper, which calls the scripts of the pinned release

The rules for what goes where are in the
[decision record, section 12.8](../architecture/decision-record.md#128-deployment-repositories-and-configuration-placement-d-53-d-54).

## 2. Fill in the minimum config

These inputs have no default. Everything else can stay as in the example for a first deployment.

| Input | What to put |
| --- | --- |
| `environment`, `location`, `name_prefix` | `dev`, your Azure region, a short prefix |
| `organization` | Enterprise slug, organizations, EMU login suffix, group prefix, `directory_provider = "entra"`, your tenant ID |
| `auth_microsoft_entra_id_id`, `auth_github_id` | Client IDs of the two sign-in apps (not secrets) |
| `github_app_id` | The metrics GitHub App's numeric ID |
| `metrics_sync_schedule`, `directory_sync_schedule` | Six-field UTC cron, for example `0 0 2 * * *` |
| `auth_trust_host` | `false` unless a trusted ingress sits in front of the portal |
| `sql_admin` | An Entra group (display name and object ID) that administers SQL |
| `alert_emails` | A mailbox that receives alerts |

Leave `metrics_sync_enabled`, `directory_sync_enabled`, `per_user_detail_enabled` and
`modules.upstream_views` off for now. Never put a secret in tfvars.

## 3. Create the state storage

Once per subscription:

```sh
scripts/bootstrap-state.sh <state-rg> <state-account> <location> [pipeline-principal-object-id]
```

It prints the `TFSTATE_*` values your pipeline needs.

## 4. Deploy the infrastructure and create the secrets

From a checkout of the release tag you pinned:

```sh
git checkout v0.2.27
scripts/deploy-infra.sh init  dev config/dev.tfvars
scripts/deploy-infra.sh plan  dev config/dev.tfvars
scripts/deploy-infra.sh apply dev config/dev.tfvars
```

Create every secret named in `terraform output -json secret_names` in the new Key Vault. A default
deployment needs five:

| Secret | Value |
| --- | --- |
| `auth-secret` | A random string of at least 32 characters (for example `openssl rand -base64 32`) |
| `auth-microsoft-entra-id-secret` | Client secret of the Entra sign-in app |
| `auth-github-secret` | Client secret of the GitHub OAuth app |
| `github-app-private-key` | Private key of the metrics GitHub App |
| `github-directory-pat` | The directory sync PAT |

The secret-scoped role assignments need the secrets to exist, so a brand-new environment creates the
vault first, then the secrets, then runs the full apply. Reaching the vault depends on your network:
see [Key Vault access](../../infra/terraform/README.md#temporary-operator-secret-management-access).
Afterwards, check that every app's Key Vault references show `Resolved`.

## 5. Load the database and deploy the apps

1. Run the migrations: `npm ci && npm run db:migrate` with the environment's connection string
   ([migrations runbook](../runbooks/migrations.md#pipeline)).
2. Map the runtime identities to their SQL roles ([database grants](../runbooks/database-grants.md)).
3. Deploy the code:

   ```sh
   scripts/deploy-portal.sh    <resource-group> <portal-app-name>
   scripts/deploy-functions.sh metrics   <resource-group> <ingestion-function-app-name>
   scripts/deploy-functions.sh directory <resource-group> <directory-function-app-name>
   ```

   The names come from the stack outputs. The directory app is skipped while directory sync is off.

## 6. Switch data on

Turn on one sync at a time in tfvars, then plan and apply again.

1. `directory_sync_enabled = true`. Needs the PAT in Key Vault, Graph consent and the directory SQL user.
   After the first run, people, managers and departments are in SQL.
2. Grant the first admins with the [access bootstrap runbook](../runbooks/entra-access-bootstrap.md).
   A person needs a directory row before they can be granted, which is why the directory sync comes
   first. Admins then grant everyone else in the portal.
3. `metrics_sync_enabled = true`. Set `backfill_from` too if you want history. The dashboards fill in
   after the next run.

Both syncs touch data, so read [restore and rollback](../runbooks/restore-rollback.md) and record a
restore point before you switch them on.

## 7. Check that it works

- `curl https://<portal-host>/api/health` returns `{"status":"ok"}`.
- `BASE_URL=https://<portal-host> npm run test:smoke` passes.
- You can sign in with Entra. Someone without a grant sees the no-access page.
- As an admin, **Administration > Sync Status** shows a successful directory run, then a metrics run.
- Overview shows numbers for your scope after the first metrics run. Groups under `min_group_size`
  stay hidden, so a small pilot can look empty.

When the portal works in `dev`, repeat steps 2 to 7 for `test` and `prod` with their own tfvars and
state key. To move to a newer release later, follow the [upgrade guide](upgrade.md).

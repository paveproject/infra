# infra

GitOps bootstrap for the Pave platform: a single k3s node on Hetzner,
ArgoCD watching this repo, everything else (cert-manager, External
Secrets Operator, the Pave services) deployed as ArgoCD `Application`s
from `kubernetes/`.

No Terraform, no Velero, no external-dns, no Load Balancer yet — see
`cli/README.md` and the commit history for why each of those is
deliberately absent for now. All of it is addable later without touching
the GitOps structure.

## Run it

```bash
cd cli
bun install
bun start          # interactive menu
bun start install  # jump straight to install
bun start status   # jump straight to status
```

See `cli/README.md` for what each step does.

## Layout

```
bootstrap/argocd/      one-shot Helm values to get ArgoCD itself running
hetzner/               hetzner-k3s cluster config
kubernetes/
  core/                ArgoCD, cert-manager, External Secrets Operator - the cluster's own infra
  apps/                the actual Pave services (postgres, redis, api, notify, rustfs)
cli/                   the bootstrap/status CLI
```

`core` and `apps` are each their own ArgoCD app-of-apps (`core/root.yaml`,
and `core/applications/apps-root.yaml` nesting into `apps/applications`) -
Pave's own services can be added/removed without touching the
cert-manager/argocd layer underneath them.

## Secrets

**Infisical (eu.infisical.com) is the single source of truth for every
secret value** - both for this cluster and for `pave`'s mobile CI
secrets (synced separately via Infisical's GitHub integration, see that
repo). Nothing sensitive is ever committed here.

In-cluster, [External Secrets Operator](https://external-secrets.io)
(`kubernetes/core/services/external-secrets/`) pulls from Infisical via
a `ClusterSecretStore` named `infisical`, authenticated with a Machine
Identity. Each service under `kubernetes/apps/services/*` has a plain
`ExternalSecret` manifest (e.g. `secret.yaml`) listing which Infisical
keys map to which local Secret keys - no ciphertext, just references;
ESO re-syncs every hour (`refreshInterval: 1h`).

**Only real credentials go through Infisical.** Everything else
(hostnames, ports, public URLs, bucket names, region) is a plain `env:`
entry committed directly in the Deployment/CronJob - no reason to route
non-sensitive config through a secrets manager.

The actual keys that need a value in Infisical - every one here is a
real credential, nothing derived or non-sensitive:

| Key | Used by |
|---|---|
| `POSTGRES_PASSWORD` | postgres (own Secret) + api (templated into `DATABASE_URL`, see below) |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | postgres's backup target - named `BACKUP_S3_*` in Infisical since it isn't actually AWS; the `postgres-backup-target` Secret still exposes them locally as `AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` because that's what the `aws` CLI auto-detects |
| `REDIS_PASSWORD` | redis (own Secret) + api + notify |
| `AUTH_SECRET` | api |
| `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` | rustfs (own Secret) + api (templated into `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` - api is just another S3 client of the same rustfs instance, so it reads rustfs's own keys directly instead of a second copy) |
| `RESEND_API_KEY` | notify |
| `GITHUB_WEBHOOK_SECRET` | argocd |

Nothing else goes in Infisical. In particular, `api`'s `DATABASE_URL` and
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are **not** separate Infisical
entries - `kubernetes/apps/services/api/secret.yaml` uses ESO's
`target.template` to build them in-cluster from the keys above (e.g.
`DATABASE_URL: postgres://pave:{{ .POSTGRES_PASSWORD }}@postgres:5432/pave`,
the Rust code appends its own `?options=...` search_path suffix at
runtime, don't add it here). One source of truth per credential, even
when multiple services need it in a different shape.

**One-time setup required before the first real deploy:**

1. Create a project on [eu.infisical.com](https://eu.infisical.com), note its project slug and create an environment (e.g. `prod`) - then fill in `projectSlug`/`environmentSlug` in `kubernetes/core/services/external-secrets/clustersecretstore.yaml` (currently a `CHANGE_ME` placeholder).
2. In that environment, add every key from the table above with real values. Generate random ones locally (never paste a real secret value into a chat/log): `openssl rand -hex 32` for `AUTH_SECRET`/`GITHUB_WEBHOOK_SECRET`, `openssl rand -hex 24` for `POSTGRES_PASSWORD`/`REDIS_PASSWORD`. `RESEND_API_KEY` comes from resend.com; `BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` and the backup bucket/endpoint (edited directly in `postgres/backup-cronjob.yaml`, not secret) come from whichever S3-compatible provider you pick for backups.
3. Create a Machine Identity (Universal Auth) scoped to read that project/environment, generate a Client ID + Client Secret - the CLI's `install` step prompts for these (or pass via `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`/`_SECRET` env vars) and stores them as the `infisical-auth` Secret the `ClusterSecretStore` reads.
4. For `pave`'s mobile CI secrets: in the Infisical project, Integrations → GitHub sync → point at `paveproject/pave`, mapping each secret to the exact GitHub secret name already referenced in that repo's workflows.
5. For the ArgoCD webhook: on `paveproject/infra` → Settings → Webhooks → Add webhook, payload URL `https://argocd.paveproject.org/api/webhook`, content type `application/json`, secret = the same value as `GITHUB_WEBHOOK_SECRET`, event = push only.

## Domains

- `api.paveproject.org` - the Pave API
- `argocd.paveproject.org` - ArgoCD UI
- `medias.paveproject.org` - RustFS (S3-compatible storage, public avatars bucket)

All three point at the single node's public IP (manual DNS A records -
no external-dns yet).

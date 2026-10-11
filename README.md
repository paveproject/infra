# infra

GitOps bootstrap for the Pave platform: a single k3s node on Hetzner,
ArgoCD watching this repo, everything else (cert-manager, External
Secrets Operator, external-dns, the Pave services) deployed as ArgoCD
`Application`s from `kubernetes/`.

No Terraform, no Velero, no Load Balancer yet — see `cli/README.md` and
the commit history for why each of those is deliberately absent for now.
All of it is addable later without touching the GitOps structure.

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
  core/                ArgoCD, cert-manager, External Secrets Operator, external-dns - the cluster's own infra
  apps/                the actual Pave services (postgres, redis, api, notify, rustfs, db-migrator, ghcr-pull-secret)
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

**Every value a service needs comes from Infisical** - not just
credentials. A hostname, a port, a public URL: if it's hardcoded in one
Deployment today, it's one more copy to keep in sync the day another
service needs the same value (e.g. DB access from a new service later).
One Infisical key, however many `ExternalSecret`s reference it.

The one deliberate exception is `api`'s `DATABASE_URL`: never typed
into Infisical directly. `kubernetes/apps/services/api/secret.yaml`
builds it in-cluster via ESO's `target.template`, from `POSTGRES_USER`/
`PASSWORD`/`DB` (the exact same Infisical keys postgres's own secret
reads) plus the literal `postgres:5432` - that host:port is a fact about
*this* cluster's internal networking, not portable config, so it
wouldn't mean anything outside this cluster anyway. Same reasoning for
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`: api is just another S3 client
of the same rustfs instance, so it templates them straight from rustfs's
own `RUSTFS_ACCESS_KEY`/`SECRET_KEY` instead of a second typed-in copy.
Same for notify's `ASSETS_BASE_URL` - just `S3_PUBLIC_ENDPOINT` +
`S3_BUCKET_PUBLIC` + `/static`, templated, not its own key.

Every other key below needs a real value in Infisical, by service:

| Service | Key(s) |
|---|---|
| postgres | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| postgres (backup target) | `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT` |
| redis | `REDIS_PASSWORD` (shared by redis, api, notify) |
| api | `AUTH_SECRET`, `API_URL`, `REDIS_HOST`, `REDIS_PORT`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC` |
| notify | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (+ `REDIS_HOST`/`PORT`/`PASSWORD` and `S3_PUBLIC_ENDPOINT`/`S3_BUCKET_PUBLIC`, all shared) |
| rustfs | `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` (+ `S3_BUCKET_PUBLIC`, shared with api) |
| rustfs (backup target) | same `BACKUP_S3_*` keys as postgres's backup target - one R2 bucket, two CronJobs writing under different prefixes |
| argocd | `ARGOCD_WEBHOOK_SECRET` |
| external-dns | `CLOUDFLARE_API_TOKEN` |
| ghcr-pull-secret | `GHCR_PULL_USERNAME`, `GHCR_PULL_TOKEN` (a GitHub PAT with `read:packages`) |

`BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` are named `BACKUP_S3_*`
in Infisical since this isn't actually AWS - the `postgres-backup-target`
Secret still exposes them locally as `AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`
because that's what the `aws` CLI auto-detects.

`ghcr-pull-secret` is consumed as `imagePullSecrets` by every Deployment/
Job pulling a `ghcr.io/paveproject/pave-*` image. If those packages are
public (the plan), it's simply unused - harmless either way, and it means
switching any of them back to private later needs no manifest change.

**One-time setup required before the first real deploy:**

1. Create a project on [eu.infisical.com](https://eu.infisical.com), note its project slug and create an environment (e.g. `prod`) - then fill in `projectSlug`/`environmentSlug` in `kubernetes/core/services/external-secrets/clustersecretstore.yaml` (currently a `CHANGE_ME` placeholder).
2. In that environment, add every key from the table above with real values. Generate random ones locally (never paste a real secret value into a chat/log): `openssl rand -hex 32` for `AUTH_SECRET`/`ARGOCD_WEBHOOK_SECRET`, `openssl rand -hex 24` for `POSTGRES_PASSWORD`/`REDIS_PASSWORD`, `openssl rand -hex 12`/`-hex 32` for `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`. `RESEND_API_KEY` comes from resend.com; `BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/`_BUCKET`/`_ENDPOINT` come from whichever S3-compatible provider you pick for backups.
3. Create a Machine Identity (Universal Auth) scoped to read that project/environment, generate a Client ID + Client Secret - the CLI's `install` step prompts for these (or pass via `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`/`_SECRET` env vars) and stores them as the `infisical-auth` Secret the `ClusterSecretStore` reads.
4. For `pave`'s mobile CI secrets: in the Infisical project, Integrations → GitHub sync → point at `paveproject/pave` (**repository** scope, not organization - org-level Actions secrets need a paid GitHub plan for private repos), mapping each secret to the exact GitHub secret name already referenced in that repo's workflows.
5. For the ArgoCD webhook: on `paveproject/infra` → Settings → Webhooks → Add webhook, payload URL `https://argocd.paveproject.org/api/webhook`, content type `application/json`, secret = the same value as `ARGOCD_WEBHOOK_SECRET`, event = push only.
6. For `CLOUDFLARE_API_TOKEN`: in the Cloudflare dashboard, create an API token (not the Global API Key) scoped to **Zone → DNS → Edit**, restricted to the `paveproject.org` zone only.
7. For `GHCR_PULL_USERNAME`/`GHCR_PULL_TOKEN`: only needed if `ghcr.io/paveproject/pave-*` packages are private - a GitHub PAT with `read:packages`, scoped to this org if you make it fine-grained.

## Domains

- `api.paveproject.org` - the Pave API
- `argocd.paveproject.org` - ArgoCD UI
- `medias.paveproject.org` - RustFS (S3-compatible storage, public bucket named by `S3_BUCKET_PUBLIC`)

All three are managed automatically by `external-dns` - it watches every
Ingress and keeps Cloudflare A records pointed at whatever IP Traefik
reports, no manual DNS entry needed. `--cloudflare-proxied`: traffic is
proxied through Cloudflare (hidden origin IP, their WAF/DDoS protection),
which is transparent to cert-manager's HTTP-01 challenges.

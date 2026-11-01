# infra

GitOps bootstrap for the Pave platform: ArgoCD watching this repo, and
everything else (Traefik, cloudflared, External Secrets Operator, the Pave
services) deployed as ArgoCD `Application`s from `kubernetes/`.

This repo does not create its cluster. It runs as a tenant in a virtual
cluster declared in [lxup/platform](https://github.com/lxup/platform), and
the only thing crossing that boundary is a kubeconfig — see
`cli/src/lib/paths.ts`. Nothing below assumes a particular machine
underneath.

Reachable from the internet through a Cloudflare tunnel, not an inbound
port: the cluster has no public address of its own. See
`kubernetes/core/services/cloudflared/secret.yaml` for the one piece of
setup that lives in Cloudflare's dashboard rather than here.

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
bootstrap/argocd/           one-shot Helm values to get ArgoCD running, plus its repo-read credential
bootstrap/external-secrets/ one-shot Helm values for External Secrets Operator (ESO)
bootstrap/infisical/        the ClusterSecretStore every ExternalSecret in the repo points at
kubernetes/
  core/                ArgoCD's Ingress, Traefik, cloudflared - the cluster's own infra
  apps/                the actual Pave services (postgres, redis, api, notify, rustfs, ghcr-pull-secret) - db-migrator rides along inside api's own Application, not a service of its own
cli/                   the bootstrap/status CLI
```

ESO, its `infisical-auth` Secret and the `ClusterSecretStore` all live in
`bootstrap/`, applied imperatively by `cli/` rather than as ArgoCD
`Application`s - see `cli/README.md` steps 5-7. They're the root of trust
for every other Secret in the cluster, including the one that lets ArgoCD
read this repo at all (step 9) - so none of them can depend on ArgoCD
already being able to do that.

`core` and `apps` are each their own ArgoCD app-of-apps (`core/root.yaml`,
and `core/applications/apps-root.yaml` nesting into `apps/applications`) -
Pave's own services can be added/removed without touching the
argocd/traefik layer underneath them.

## Secrets

**Infisical (eu.infisical.com) is the single source of truth for every
secret value** - both for this cluster and for `pave`'s mobile CI
secrets (synced separately via Infisical's GitHub integration, see that
repo). Nothing sensitive is ever committed here.

In-cluster, [External Secrets Operator](https://external-secrets.io)
(installed imperatively, see `bootstrap/external-secrets/` and `cli/
README.md`) pulls from Infisical via a `ClusterSecretStore` named
`infisical` (`bootstrap/infisical/secretstore.yaml`), authenticated with
a Machine Identity. Each service under `kubernetes/apps/services/*` has
a plain `ExternalSecret` manifest (e.g. `secret.yaml`) listing which Infisical
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
`S3_BUCKET_PUBLIC` + `/static`, templated, not its own key. notify also
templates its own `DATABASE_URL` the exact same way api does (it resolves
push tokens/language itself, with its own connection to the same Postgres
instance/schema - not a separate database).

Every other key below needs a real value in Infisical, by service:

| Service | Key(s) |
|---|---|
| postgres | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| postgres (backup target) | `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT` |
| redis | `REDIS_PASSWORD` (shared by redis, api, notify) |
| api | `AUTH_SECRET`, `API_URL`, `REDIS_HOST`, `REDIS_PORT`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PUBLIC`, `API_INTERNAL_VERSION_POLICY_SECRET`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`, `APP_STORE_CONNECT_APP_ID`, `APP_STORE_CONNECT_WEBHOOK_SECRET` |
| notify | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY_B64`, `APNS_KEY_B64`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (+ `REDIS_HOST`/`PORT`/`PASSWORD`, `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT`/`S3_BUCKET_PUBLIC`, and `POSTGRES_USER`/`PASSWORD`/`DB`, all shared) |
| rustfs | `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` (+ `S3_BUCKET_PUBLIC`, shared with api) |
| rustfs (backup target) | same `BACKUP_S3_*` keys as postgres's backup target - one R2 bucket, two CronJobs writing under different prefixes |
| argocd | `ARGOCD_WEBHOOK_SECRET` |
| cloudflared | `CLOUDFLARE_TUNNEL_TOKEN` |
| argocd + ghcr-pull-secret | `GITHUB_USERNAME`, `GITHUB_TOKEN` - one classic GitHub PAT, shared by both (see below) |

`BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` are named `BACKUP_S3_*`
in Infisical since this isn't actually AWS - the `postgres-backup-target`
Secret still exposes them locally as `AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`
because that's what the `aws` CLI auto-detects.

`ghcr-pull-secret` is consumed as `imagePullSecrets` by every Deployment/
Job pulling a `ghcr.io/paveproject/pave-*` image. If those packages are
public (the plan), it's simply unused - harmless either way, and it means
switching any of them back to private later needs no manifest change. It
reads the same `GITHUB_USERNAME`/`GITHUB_TOKEN` as the ArgoCD repository
credential below, not a separate GHCR-only PAT - one classic GitHub token
with both `repo` and `read:packages` scopes covers git clone and package
pull. Everything that needs it lives in the `pave` namespace, so a plain
`ExternalSecret` is enough; if a second namespace ever needs it too,
switch to a `ClusterExternalSecret` with a `namespaceSelector` instead of
duplicating the manifest (`recomendapp/infra`'s `kubernetes/core/services/
ghcr-pull-secret` does exactly that, across more namespaces).

`API_INTERNAL_VERSION_POLICY_SECRET` is the bearer secret `pave`'s CD uses
to report a shipped mobile version (see `pave`'s
`.github/workflows/mobile-router.yml` and
`apps/api/src/app/internal/version_policy`) - generate it yourself
(`openssl rand -hex 32`), it isn't tied to any external provider. It also
needs to reach GitHub Actions: map it in Infisical's GitHub sync
integration to the `INFISICAL_API_INTERNAL_VERSION_POLICY_SECRET` secret on
`paveproject/pave` (see step 4 below) - the 5 `APP_STORE_CONNECT_*` keys
below don't, they're only ever read by the API itself.

`APP_STORE_CONNECT_KEY_ID`/`_ISSUER_ID`/`_PRIVATE_KEY`/`_APP_ID` and
`APP_STORE_CONNECT_WEBHOOK_SECRET` back `apps/api/src/libs/app_store_connect.rs`
and `apps/api/src/app/webhooks/app_store_connect` - confirming a new iOS
version is actually live on the App Store. `KEY_ID`/`ISSUER_ID`/`PRIVATE_KEY`
come from an App Store Connect API key (Users and Access → Integrations →
App Store Connect API); `APP_ID` is the app's numeric Apple ID (App
Information → Apple ID, same value as `pave`'s `apps/mobile/eas.json`
`ascAppId`); `WEBHOOK_SECRET` is whatever value you set when creating the
Webhook subscription in App Store Connect (pointed at
`https://api.paveproject.org/webhooks/app-store-connect`, subscribed to the
"État de la version de l'app" / App Store Version State event) - it must
match exactly what's in Infisical, since that's what the HMAC signature
check in `webhook-app-store-connect/guard.rs` verifies against.

**One-time setup required before the first real deploy:**

1. Create a project named `pave` on [eu.infisical.com](https://eu.infisical.com) with a `prod` environment (or adjust `projectSlug`/`environmentSlug` in `bootstrap/infisical/secretstore.yaml` to match whatever you actually named them).
2. In that environment, add every key from the table above with real values. Generate random ones locally (never paste a real secret value into a chat/log): `openssl rand -hex 32` for `AUTH_SECRET`/`ARGOCD_WEBHOOK_SECRET`/`API_INTERNAL_VERSION_POLICY_SECRET`, `openssl rand -hex 24` for `POSTGRES_PASSWORD`/`REDIS_PASSWORD`, `openssl rand -hex 12`/`-hex 32` for `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`. `RESEND_API_KEY` comes from resend.com; `BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/`_BUCKET`/`_ENDPOINT` come from whichever S3-compatible provider you pick for backups.
3. Create a Machine Identity (Universal Auth) scoped to read that project/environment, generate a Client ID + Client Secret - the CLI's `install` step prompts for these (or pass via `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`/`_SECRET` env vars) and stores them as the `infisical-auth` Secret the `ClusterSecretStore` reads.
4. For `pave`'s mobile CI secrets: in the Infisical project, Integrations → GitHub sync → point at `paveproject/pave` (**repository** scope, not organization - org-level Actions secrets need a paid GitHub plan for private repos), mapping each secret to the exact GitHub secret name already referenced in that repo's workflows.
5. For the ArgoCD webhook: on `paveproject/infra` → Settings → Webhooks → Add webhook, payload URL `https://argocd.paveproject.org/api/webhook`, content type `application/json`, secret = the same value as `ARGOCD_WEBHOOK_SECRET`, event = push only.
6. For `CLOUDFLARE_TUNNEL_TOKEN`: Cloudflare dashboard → Zero Trust → Networks → Tunnels → create a tunnel, copy its token, then add the three public hostnames to it. Full instructions, including the exact origin service to point them at, are in `kubernetes/core/services/cloudflared/secret.yaml`.
7. For `GITHUB_USERNAME`/`GITHUB_TOKEN`: one **classic** GitHub PAT (scopes aren't per-repo on classic tokens, which is what lets one token cover both uses below) with `repo` + `read:packages` scopes. Used by:
   - ArgoCD's own credential to clone `paveproject/infra` (`bootstrap/argocd/github-repo.yaml`, applied by `cli/` step 9) - harmless while this repo is public, required the moment it's switched to private, since ArgoCD would otherwise be unable to read any manifest here at all, including the one that updates this credential.
   - `ghcr-pull-secret`, only needed if `ghcr.io/paveproject/pave-*` packages are private.
8. For `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY_B64`: Firebase Console → ⚙️ Project Settings → **Service accounts** tab → "Generate new private key" - the downloaded JSON has `project_id`/`client_email`/`private_key`. Base64-encode just the `private_key` value (`base64 < key.pem` or equivalent) before pasting it in as `FIREBASE_PRIVATE_KEY_B64` - dodges the multiline-secret problem, same reasoning as `APNS_KEY_B64` below.
9. For `APNS_KEY_B64`/`APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_BUNDLE_ID`: an APNs authentication key is scoped to your whole Apple Developer **team**, not one app - reuse the same key across every app on that team rather than creating a new one (Apple caps how many you can have). Apple Developer → Certificates, Identifiers & Profiles → Keys → "+", check "Apple Push Notifications service (APNs)" → Register → download the `.p8` (downloadable once) and note its Key ID. Base64-encode the `.p8` file's content for `APNS_KEY_B64`. `APNS_TEAM_ID` is your Apple team id; `APNS_BUNDLE_ID` is this app's own bundle id (`org.paveproject.app`), the one value that's actually Pave-specific.

## Domains

- `api.paveproject.org` - the Pave API
- `argocd.paveproject.org` - ArgoCD UI
- `medias.paveproject.org` - RustFS (S3-compatible storage, public bucket named by `S3_BUCKET_PUBLIC`)

Each one is a public hostname on the Cloudflare tunnel, and Cloudflare
creates its CNAME when you add it — which is why there is no external-dns
here. All three point at the same in-cluster Traefik, which routes on the
Host header the way it always did.

There is no cert-manager either. A tunnel means Cloudflare terminates TLS
at its edge whatever the origin speaks, so a certificate on Traefik would
only encrypt the cloudflared→Traefik hop — a hop that never leaves this
cluster's pod network.

## Storage

`postgres` and `rustfs` claim PVCs from `longhorn`, the StorageClass the
vcluster syncs in from the platform. Named explicitly in both
`pvc.yaml`s rather than taken from the host's default, since which class
is default is not this repo's decision to depend on.

Longhorn keeps two replicas of every volume and backs them up to R2 on the
platform's schedule, so neither lives here. Growing a volume is
`kubectl edit pvc` plus a pod restart — Longhorn allows expansion. There is
no pvc-autoresizer any more: it existed because Hetzner's CSI driver
needed coaxing, and it dragged a whole Prometheus along just to answer
"how full is this volume".

Monitoring is the platform's job too, and it already alerts on degraded
and faulted Longhorn volumes for every tenant.

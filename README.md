# infra

GitOps bootstrap for the Pave platform: a single k3s node on Hetzner,
ArgoCD watching this repo, everything else (cert-manager, the Pave
services) deployed as ArgoCD `Application`s from `kubernetes/`.

No Terraform, no Infisical, no Velero, no external-dns, no Load Balancer
yet — see `cli/README.md` and the commit history for why each of those is
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
.sops.yaml            SOPS encryption rules (one Age key, see below)
bootstrap/argocd/      one-shot Helm values to get ArgoCD itself running
hetzner/               hetzner-k3s cluster config
kubernetes/
  core/                ArgoCD, cert-manager - the cluster's own infra
  apps/                the actual Pave services (postgres, redis, api, notify, rustfs)
cli/                   the bootstrap/status CLI
```

`core` and `apps` are each their own ArgoCD app-of-apps (`core/root.yaml`,
and `core/applications/apps-root.yaml` nesting into `apps/applications`) -
Pave's own services can be added/removed without touching the
cert-manager/argocd layer underneath them.

## Secrets

Any `*.sops.yaml` under `kubernetes/` is SOPS-encrypted, decrypted inline
by ArgoCD's repo-server via the `ksops` kustomize plugin (see
`bootstrap/argocd/values.yaml`) - no secrets operator running in the
cluster, no secret ever committed in cleartext.

**The Age private key backing this is the only way to decrypt anything
here.** It lives at `~/.config/sops/age/paveproject-infra.txt` on the
machine that generated it and is never committed - back it up somewhere
safe (password manager) the moment it's generated. Losing it with no
backup means every secret in this repo becomes permanently
undecryptable.

## Domains

- `api.paveproject.org` - the Pave API
- `argocd.paveproject.org` - ArgoCD UI
- `medias.paveproject.org` - RustFS (S3-compatible storage, avatars/imports)

All three point at the single node's public IP (manual DNS A records -
no external-dns yet).

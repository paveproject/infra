# pave infra CLI

Single CLI for installing and managing the Pave Hetzner k3s cluster. UI:
[Listr2](https://listr2.kischnerd.de/) for step progress,
[`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) for
prompts/menu.

Runs on [Bun](https://bun.sh) — executes the TypeScript directly, no build
step.

## Run it

```bash
cd cli
bun install
bun start          # interactive menu
bun start install  # jump straight to install
bun start status   # jump straight to status
```

Requires `HCLOUD_TOKEN` (a Hetzner Cloud API token) in the environment.
Optionally `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`/`_SECRET` (step 6 below
prompts interactively if unset). Copy `.env.example` to `.env` (gitignored)
to set these once instead of exporting them every shell session — Bun
auto-loads `cli/.env`, no extra config needed.

Step 9 (ArgoCD repository credentials) needs `GITHUB_USERNAME`/
`GITHUB_TOKEN` in Infisical — see the top-level README's Secrets section.
Harmless while this repo stays public; required the moment it's flipped
private.

## Sections

### Install

Same command for the very first boot and for reconciling an
already-running cluster against `hetzner/cluster_config.yaml` later (e.g.
after adding a worker pool). See `src/commands/install.ts`. Steps run in
order from `src/steps/`, numbered, each a plain `ListrTask<InstallCtx>` —
**every step file has a `Doc:` comment above it explaining what it does
and why**, read those before changing one:

1. Read cluster shape from `hetzner/cluster_config.yaml`.
2. Check required tools (`hetzner-k3s`, `helm`, `kubectl`) and that
   `HCLOUD_TOKEN` is set.
3. `hetzner-k3s create --config hetzner/cluster_config.yaml` — provisions
   the node(s), installs k3s, writes `./kubeconfig`. One call replaces
   what would otherwise be a multi-step provisioner dance.
4. Wait for all nodes to go `Ready`.
5. Install External Secrets Operator (`helm upgrade --install` —
   idempotent). Stays imperative, never GitOps-managed: it's the root of
   trust for every Secret in the cluster, including the ArgoCD repository
   credentials in step 9, so ArgoCD cannot be the thing that installs it
   without a circular dependency.
6. Create the `infisical-auth` secret (Machine Identity Client ID +
   Secret) in the `external-secrets` namespace.
7. Apply the `infisical` `ClusterSecretStore` and wait for it to report
   `Ready` — every `ExternalSecret` in the repo points at this by name.
8. Install ArgoCD (`helm upgrade --install` — idempotent, safe every run).
9. Create ArgoCD's repository credentials (`bootstrap/argocd/
   github-repo.yaml`, an `ExternalSecret` resolved through step 7's
   store) and wait for it to sync. Works whether `paveproject/infra` is
   public or private — this is what lets step 10 actually succeed once
   it's flipped private.
10. Apply `kubernetes/core/root.yaml` — ArgoCD takes over from here
    (idempotent `kubectl apply`).

Safe to re-run end to end at any time — `hetzner-k3s create` itself diffs
the running cluster against the config file.

### Status

`src/commands/status.ts` checks the health of every core component and
offers to fix what it can, without fighting GitOps:

- **Cluster nodes** — checked directly via `kubectl` (not ArgoCD-managed).
- **External Secrets Operator** — checked via its Helm release +
  Deployment, same as ArgoCD below (not an ArgoCD `Application` — see
  step 5). If missing or unhealthy, the fix re-runs ESO + the
  `infisical-auth` secret + the `ClusterSecretStore`.
- **ArgoCD** — checked via its Helm release + Deployment. If missing or
  unhealthy, the fix re-runs the ArgoCD install step.
- **Root app-of-apps** — checked as an ArgoCD `Application` named `root`.
  If missing, the fix re-applies `kubernetes/core/root.yaml`.
- Everything else (`cert-manager`, `external-dns`, the nested
  `apps-root` app-of-apps, `postgres`, `redis`, `api`, `notify`,
  `rustfs`) — checked as ArgoCD `Application` health/sync status. The fix
  requests a hard refresh; actual reconciliation is still ArgoCD's job
  (`automated: { prune: true, selfHeal: true }` on every Application).

### Later

More sections (upgrades, backups, …) go in `src/commands/`, registered in
the `SECTIONS` map in `src/index.ts`.

## Code layout

```
src/
  index.ts           menu + subcommand dispatch
  commands/          one file per section (install, status, …)
  steps/             individual install steps, reused by commands
  lib/
    context.ts       InstallCtx — state threaded through install steps
    paths.ts         repo-relative paths
    exec.ts          execa wrapper that streams into Listr2 task output
    kubectl.ts       read-only + light-touch kubectl/helm/argo helpers for status
    retry.ts         retry-with-backoff for "nodes still booting" steps
    clusterconfig.ts parses hetzner/cluster_config.yaml for the cluster shape
```

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

## Sections

### Install

Same command for the very first boot and for reconciling an
already-running cluster against `hetzner/cluster_config.yaml` later (e.g.
after adding a worker pool). See `src/commands/install.ts`. Steps run in
order from `src/steps/`, numbered, each a plain `ListrTask<InstallCtx>` —
**every step file has a `Doc:` comment above it explaining what it does
and why**, read those before changing one:

1. Read cluster shape from `hetzner/cluster_config.yaml`.
2. Check required tools (`hetzner-k3s`, `helm`, `kubectl`, `sops`,
   `age-keygen`) and that `HCLOUD_TOKEN` is set.
3. Generate/reuse Age key, wire it into `.sops.yaml`.
4. `hetzner-k3s create --config hetzner/cluster_config.yaml` — provisions
   the node(s), installs k3s, writes `./kubeconfig`. One call replaces
   what would otherwise be a multi-step provisioner dance.
5. Wait for all nodes to go `Ready`.
6. Create the `sops-age` secret in the `argocd` namespace — **before**
   ArgoCD installs, since its repo-server mounts this secret as a volume.
7. Install ArgoCD (`helm upgrade --install` — idempotent, safe every run).
8. Apply `kubernetes/core/root.yaml` — ArgoCD takes over from here
   (idempotent `kubectl apply`).

Safe to re-run end to end at any time — `hetzner-k3s create` itself diffs
the running cluster against the config file.

### Status

`src/commands/status.ts` checks the health of every core component and
offers to fix what it can, without fighting GitOps:

- **Cluster nodes** — checked directly via `kubectl` (not ArgoCD-managed).
- **ArgoCD** — checked via its Helm release + Deployment. If missing or
  unhealthy, the fix re-runs the ArgoCD install step.
- **Root app-of-apps** — checked as an ArgoCD `Application` named `root`.
  If missing, the fix re-applies `kubernetes/core/root.yaml`.
- Everything else (`cert-manager`, the nested `apps-root` app-of-apps,
  `postgres`, `redis`, `api`, `notify`, `rustfs`) — checked as ArgoCD
  `Application` health/sync status. The fix requests a hard refresh;
  actual reconciliation is still ArgoCD's job
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

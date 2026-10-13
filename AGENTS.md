# infra

GitOps bootstrap for the Pave platform (Hetzner k3s, ArgoCD). `README.md`
and `cli/README.md` are the user-facing "how to run this" docs - read
those first. This file is the "why it's shaped this way" and the traps
that don't show up just from reading the manifests.

## The one structural rule: bootstrap/ vs everything else

`bootstrap/` (External Secrets Operator, the `infisical-auth` Secret,
the `ClusterSecretStore`, ArgoCD's own repo-read credential) is applied
**imperatively by `cli/`**, never as an ArgoCD `Application`. Everything
else (`kubernetes/core`, `kubernetes/apps`) is GitOps, owned by ArgoCD.

The reason: this repo may be made private at any time, and ArgoCD then
needs a credential to clone it at all. That credential is an
`ExternalSecret` resolved through the `ClusterSecretStore`, which needs
ESO running, which needs `infisical-auth` to exist. None of those three
can be the thing ArgoCD installs - ArgoCD can't read the manifest that
creates its own means of reading manifests. If you're ever asked "why
isn't ESO just another Application", this is why - don't move it.

## Operational gotchas, confirmed the hard way

- **A Sync-hook Job (`db-migrator`) never re-runs on its own.** ArgoCD
  doesn't track hook resources as persistent, and never re-triggers one
  just because its dependencies (e.g. a Secret) finally became valid.
  Force a fresh run: `kubectl -n argocd annotate application db-migrator
  argocd.argoproj.io/refresh=hard --overwrite` then patch
  `operation.sync` on it (see git history for the exact command) - don't
  assume "Healthy" means it actually succeeded recently.
- **Deleting an Application without `finalizers:
  [resources-finalizer.argocd.argoproj.io]` orphans its resources
  instead of deleting them.** They keep running, untracked by ArgoCD,
  invisible to `kubectl get application`. This is actually what you want
  when retiring an Application whose resources should survive (it's how
  ESO's move from GitOps to bootstrap-imperative worked with zero
  downtime) - but don't mistake "Application gone" for "resources gone".
- **A pod needing storage non-interactively (no init as root) needs an
  explicit `securityContext`** (`runAsUser`/`runAsGroup`/`fsGroup`
  matching the image's own non-root UID) or it `CrashLoopBackOff`s on
  `mkdir: Permission denied` against a fresh PVC.
- **`rc mirror` (RustFS's `rustfs/rc` image) needs an explicit bucket in
  the source path** - `rc mirror local/` fails ("Bucket name cannot be
  empty"); only `rc bucket list`/`rc ls` accept a bare alias. List
  buckets, then mirror each one.
- **The `hcloud-volumes` StorageClass doesn't support PVC auto-resize by
  default** - it needs `resize.topolvm.io/enabled: "true"` patched onto
  it (`kubernetes/core/services/hcloud-volumes-patch/`); without that
  annotation, `pvc-autoresizer` watches forever and never acts, with no
  error anywhere.

## Current known constraint

The cluster is a single Hetzner cx23 (2 vCPU/4GB). Confirmed via
`kubectl top node`: ~82% RAM used with monitoring + pvc-autoresizer
running. Not urgent while the app stays in dev - but don't add another
memory-hungry Application (another exporter, a second Prometheus
target, etc.) without checking `kubectl top node`/`top pods` first.

# infra

GitOps bootstrap for the Pave platform (a vcluster tenant of
lxup/platform, ArgoCD, a Cloudflare tunnel for ingress). `README.md`
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

- **A Sync-hook Job in its own Application never re-runs on its own.**
  ArgoCD doesn't track hook resources as persistent, and an Application
  whose *only* resource is a hook has nothing else to diff - so it never
  decides a fresh sync is needed, even once its manifest (e.g. the image
  tag) actually changes. Confirmed the hard way: `db-migrator` used to
  be its own Application and silently kept running a week-old image
  across several deploys while `api` updated normally right next to it.
  Force a fresh run on a standalone hook Application like that:
  `kubectl -n argocd annotate application <name>
  argocd.argoproj.io/refresh=hard --overwrite` then patch
  `operation.sync` on it (`kubectl -n argocd patch application <name>
  --type merge -p '{"operation":{"sync":{"revision":"HEAD","prune":true}}}'`)
  - don't assume "Healthy" means it actually succeeded recently; check
  `.status.operationState.startedAt`, not just `.status.sync.revision`
  (the latter updates just from comparing against git, independent of
  whether an operation actually ran).

  The real fix, not just the workaround: give the hook a *normal*
  resource to ride along with. `db-migrator`'s Job now lives inside the
  `api` Application (`kubernetes/apps/services/api/job-db-migrator.yaml`),
  not its own - every deploy that bumps `api`'s Deployment image (which
  reliably triggers a sync, since Deployments are diffed normally)
  carries the hook along for free. Ordering against `api`'s own
  Deployment (migrate before the new pod starts) is preserved via a
  resource-level `argocd.argoproj.io/sync-wave: "-3"` on the Job itself,
  not an Application-level one - that part doesn't need two Applications
  either. Recomend's `infra` repo (`kubernetes/apps/services/backend/`)
  bundles its own db-migrator the same way, which is what confirmed this
  pattern actually works before migrating pave to it.

  **It bit a second time, in a shape worth naming separately:** an
  Application that *does* have normal resources, none of which a deploy
  ever changes. `assets-sync` was a PostSync hook of the `rustfs`
  Application, whose Deployment is pinned to an upstream RustFS tag, so
  the only thing a deploy commit touched there was the hook Job's own
  image - which ArgoCD doesn't diff. No diff, no sync, no run: it last
  ran 2026-10-21 and sat out seven days of deploys while reporting
  Synced/Healthy at the current revision. So the rule is not "does the
  Application have other resources" but "does it have a resource a
  deploy actually changes". `assets-sync` now lives in the `api`
  Application too (`kubernetes/apps/services/api/job-assets-sync.yaml`),
  riding on the Deployment image bump like db-migrator. Its PostSync
  ordering against `rustfs` got stronger, not weaker, in the move: the
  `rustfs` Application is sync-wave "-5" against api's default "0", so
  rustfs and its bucket-init are Healthy before `api` syncs at all,
  where before the two hooks raced as same-wave PostSync siblings.

  If a *future* hook genuinely has nothing else to ride with, this
  gotcha still applies to it.
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
- **Inside a vcluster, service links outrank `envFrom:`.** vcluster turns
  off the host's service links and injects the *virtual* cluster's instead,
  as explicit `env:` entries on the host pod — and the kubelet gives `env:`
  precedence over `envFrom:`, where real service links come last and lose
  to both. So a Service named `redis` shadowed `REDIS_PORT` (6379, from
  Infisical) with `tcp://10.97.187.39:6379`, and notify panicked on
  "invalid digit found in string". The same manifest ran fine on k3s for
  weeks. Every pod template under `kubernetes/apps/services/` therefore
  sets `enableServiceLinks: false`. Keep doing that on new ones: the trap
  is silent until a key happens to collide with a Service name.
- **A Helm value the chart does not define is accepted and silently does
  nothing.** Traefik's chart takes `service.spec.type`, not
  `service.type`; the short spelling rendered a `LoadBalancer` Service
  while the comment right above it said ClusterIP. Nothing warns. After
  editing any `valuesInline`, render it
  (`kubectl kustomize --enable-helm <dir>`) and check the field you meant
  to change actually changed.

## Current known constraint

This tenant's budget is a `ResourceQuota` in lxup/platform
(`kubernetes/tenants/services/pave/`), currently 4 Gi of requests and
16 Gi of limits. The quota counts **declared limits**, not usage, and most
of what runs here comes from Helm charts that declare no resources at all
— the companion `LimitRange` then stamps 512 Mi of limit on each pod. So
adding an Application costs quota even if it is idle, and when the quota
is reached the refusal surfaces as a vcluster SyncError on the *virtual*
pod, with nothing at all visible on the host. Count before adding, and
raise the quota on the platform side rather than squeezing a tenant.

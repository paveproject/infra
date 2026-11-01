import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** infra/ — the git repo root (this file lives at cli/src/lib/). */
export const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * The kubeconfig for THIS TENANT's cluster — not the platform's.
 *
 * This repo does not know how its cluster is produced and holds no
 * credentials for the machine underneath. The cluster is a vcluster declared
 * in lxup/platform, and this file is the only thing crossing that boundary —
 * which is what replaced `hetzner-k3s create`.
 *
 * Produce it with `platform tenant` in that repo, which writes
 * tenants/pave.kubeconfig, and copy it here. Gitignored: it is a live
 * credential to a Kubernetes API server.
 */
export const kubeconfigPath = path.join(repoRoot, "kubeconfig");
export const argocdBootstrapValuesPath = path.join(repoRoot, "bootstrap", "argocd", "values.yaml");
export const argocdRepoSecretPath = path.join(repoRoot, "bootstrap", "argocd", "github-repo.yaml");
export const externalSecretsValuesPath = path.join(
  repoRoot,
  "bootstrap",
  "external-secrets",
  "values.yaml",
);
export const clusterSecretStorePath = path.join(
  repoRoot,
  "bootstrap",
  "infisical",
  "secretstore.yaml",
);
export const coreRootAppPath = path.join(repoRoot, "kubernetes", "core", "root.yaml");

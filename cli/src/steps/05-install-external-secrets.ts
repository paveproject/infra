import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { crdExists } from "../lib/kubectl.js";
import { externalSecretsValuesPath, kubeconfigPath, repoRoot } from "../lib/paths.js";
import { retry } from "../lib/retry.js";

const CRDS = [
  "clustersecretstores.external-secrets.io",
  "secretstores.external-secrets.io",
  "externalsecrets.external-secrets.io",
  "clusterexternalsecrets.external-secrets.io",
];

/**
 * Doc: ESO stays imperative, unlike cert-manager and external-dns which
 * ArgoCD owns. It is the root of trust for every Secret in the cluster,
 * including the repository credentials ArgoCD needs to read this repo at
 * all should it ever go private (see step 09) - so ArgoCD cannot be the
 * thing that installs it without a circular dependency. Same reasoning as
 * the infisical-auth Secret in the next step, one level further out.
 *
 * `helm upgrade --install` is idempotent, so this is also how you upgrade
 * ESO later: bump the chart version here and re-run.
 */
export const installExternalSecretsStep: ListrTask<InstallCtx> = {
  title: "Install External Secrets Operator",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    task.output = "helm repo add/update external-secrets";
    await execa(
      "helm",
      ["repo", "add", "external-secrets", "https://charts.external-secrets.io"],
      { cwd: repoRoot, env, reject: false },
    );
    await execa("helm", ["repo", "update", "external-secrets"], { cwd: repoRoot, env });

    task.output = "helm upgrade --install external-secrets";
    await execa(
      "helm",
      [
        "upgrade",
        "--install",
        "external-secrets",
        "external-secrets/external-secrets",
        "--version",
        "2.12.0",
        "--namespace",
        "external-secrets",
        "--create-namespace",
        // Adopts the resources from the old GitOps-rendered install
        // (same chart, so same manifests, but never a real Helm release -
        // no ownership metadata for `helm` to recognize) instead of
        // erroring on "already exists". Harmless to keep once adopted:
        // every later run just confirms the same ownership again.
        "--take-ownership",
        "--values",
        externalSecretsValuesPath,
        "--wait",
      ],
      { cwd: repoRoot, env },
    );

    await retry(
      async () => {
        for (const crd of CRDS) {
          if (!(await crdExists(crd))) throw new Error(`CRD ${crd} not registered yet`);
        }
        task.output = "all CRDs registered";
      },
      { attempts: 24, delayMs: 5000 },
    );

    task.title = "External Secrets Operator installed";
  },
};

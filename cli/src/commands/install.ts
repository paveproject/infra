import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Listr } from "listr2";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

import { loadContextStep } from "../steps/00-load-context.js";
import { prerequisitesStep } from "../steps/01-prerequisites.js";
import { provisionClusterStep } from "../steps/03-provision-cluster.js";
import { waitNodesReadyStep } from "../steps/04-wait-nodes-ready.js";
import { installExternalSecretsStep } from "../steps/05-install-external-secrets.js";
import { infisicalSecretStep } from "../steps/06-infisical-secret.js";
import { clusterSecretStoreStep } from "../steps/07-cluster-secret-store.js";
import { installArgocdStep } from "../steps/08-install-argocd.js";
import { argocdRepoCredentialsStep } from "../steps/09-argocd-repo-credentials.js";
import { applyRootAppStep } from "../steps/10-apply-root-app.js";

/**
 * The bootstrap layer, in dependency order. Everything after the root app
 * is GitOps: ArgoCD owns cert-manager, external-dns, the apps and the
 * rest. ESO and its ClusterSecretStore are deliberately here and not in
 * ArgoCD - see steps 05 and 09 for why a repo that may go private forces
 * that.
 */
const STEPS = [
  loadContextStep,
  prerequisitesStep,
  provisionClusterStep,
  waitNodesReadyStep,
  installExternalSecretsStep,
  infisicalSecretStep,
  clusterSecretStoreStep,
  installArgocdStep,
  argocdRepoCredentialsStep,
  applyRootAppStep,
];

/** First run ever, or reconciling an already-up cluster against hetzner/cluster_config.yaml — same command either way. */
export async function runInstall() {
  p.intro(pc.bgCyan(pc.black(" install ")));

  const clusterAlreadyUp = existsSync(kubeconfigPath);

  p.log.message(
    clusterAlreadyUp
      ? "A cluster already exists (kubeconfig found) — this run reconciles it against hetzner/cluster_config.yaml and re-applies ArgoCD/GitOps."
      : "No cluster yet — this run provisions it from scratch on Hetzner Cloud.",
  );

  const proceed = await p.confirm({
    message: clusterAlreadyUp
      ? "Reconcile the existing cluster and (re)apply ArgoCD?"
      : "Provision a new Hetzner cluster and install ArgoCD?",
    initialValue: true,
  });

  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Aborted — nothing was touched.");
    return;
  }

  const tasks = new Listr<InstallCtx>(STEPS, {
    concurrent: false,
    exitOnError: true,
    rendererOptions: { collapseSubtasks: false },
  });

  try {
    await tasks.run({ clusterAlreadyUp } as InstallCtx);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Install failed — re-run once you've fixed the issue above."));
    return;
  }

  p.note(
    [
      `export KUBECONFIG=${kubeconfigPath}`,
      "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
      "https://argocd.paveproject.org (once DNS points at the node)",
    ].join("\n"),
    "Next steps",
  );

  p.outro(pc.green("Cluster is up. ArgoCD now owns kubernetes/core and kubernetes/apps."));
}

/** Re-install just ArgoCD — used by the status command when it's missing or unhealthy. */
export async function runInstallArgocdOnly() {
  const tasks = new Listr<InstallCtx>([loadContextStep, installArgocdStep], {
    concurrent: false,
    exitOnError: true,
  });
  await tasks.run({ clusterAlreadyUp: true } as InstallCtx);
}

/** Re-install just ESO + its store — used by the status command when ESO is missing. */
export async function runInstallExternalSecretsOnly() {
  const tasks = new Listr<InstallCtx>(
    [loadContextStep, installExternalSecretsStep, infisicalSecretStep, clusterSecretStoreStep],
    { concurrent: false, exitOnError: true },
  );
  await tasks.run({ clusterAlreadyUp: true } as InstallCtx);
}

/** Re-apply the app-of-apps — used by the status command when it's missing. */
export async function runApplyRootApp() {
  const tasks = new Listr<InstallCtx>([applyRootAppStep], { concurrent: false, exitOnError: true });
  await tasks.run({} as InstallCtx);
}

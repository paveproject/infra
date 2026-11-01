import * as p from "@clack/prompts";
import pc from "picocolors";
import { Listr } from "listr2";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

import { loadContextStep } from "../steps/00-load-context.js";
import { prerequisitesStep } from "../steps/01-prerequisites.js";
import { kubeconfigStep } from "../steps/03-kubeconfig.js";
import { waitReadyStep } from "../steps/04-wait-ready.js";
import { installExternalSecretsStep } from "../steps/05-install-external-secrets.js";
import { infisicalSecretStep } from "../steps/06-infisical-secret.js";
import { clusterSecretStoreStep } from "../steps/07-cluster-secret-store.js";
import { installArgocdStep } from "../steps/08-install-argocd.js";
import { argocdRepoCredentialsStep } from "../steps/09-argocd-repo-credentials.js";
import { applyRootAppStep } from "../steps/10-apply-root-app.js";

/**
 * The bootstrap layer, in dependency order. Everything after the root app
 * is GitOps: ArgoCD owns Traefik, cloudflared, the apps and the rest. ESO and its ClusterSecretStore are deliberately
 * here and not in ArgoCD - see steps 05 and 09 for why a repo that may go
 * private forces that.
 *
 * This does not provision anything: the cluster is a vcluster declared in
 * lxup/platform and ./kubeconfig is the only thing crossing that boundary.
 */
const STEPS = [
  loadContextStep,
  prerequisitesStep,
  kubeconfigStep,
  waitReadyStep,
  installExternalSecretsStep,
  infisicalSecretStep,
  clusterSecretStoreStep,
  installArgocdStep,
  argocdRepoCredentialsStep,
  applyRootAppStep,
];

/** First run, or reconciling an ArgoCD that is already there — same command either way. */
export async function runInstall() {
  p.intro(pc.bgCyan(pc.black(" install ")));

  p.log.message(
    [
      "This installs ArgoCD into this tenant's vcluster and hands it GitOps.",
      "",
      "It does NOT create a cluster. ./kubeconfig must already point at the",
      "pave vcluster — produce it with `bun run src/index.ts tenant` in",
      "lxup/platform and copy it here.",
    ].join("\n"),
  );

  const proceed = await p.confirm({ message: "Continue?", initialValue: true });

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
    await tasks.run({} as InstallCtx);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Install failed — re-run once you've fixed the issue above."));
    return;
  }

  p.note(
    [
      `export KUBECONFIG=${kubeconfigPath}`,
      "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
      "https://argocd.paveproject.org (once the Cloudflare tunnel routes it)",
    ].join("\n"),
    "Next steps",
  );

  p.outro(pc.green("Done. ArgoCD now owns kubernetes/core and kubernetes/apps."));
}

/** Re-install just ArgoCD — used by the status command when it's missing or unhealthy. */
export async function runInstallArgocdOnly() {
  const tasks = new Listr<InstallCtx>([loadContextStep, installArgocdStep], {
    concurrent: false,
    exitOnError: true,
  });
  await tasks.run({ alreadyInstalled: true } as InstallCtx);
}

/** Re-install just ESO + its store — used by the status command when ESO is missing. */
export async function runInstallExternalSecretsOnly() {
  const tasks = new Listr<InstallCtx>(
    [loadContextStep, installExternalSecretsStep, infisicalSecretStep, clusterSecretStoreStep],
    { concurrent: false, exitOnError: true },
  );
  await tasks.run({ alreadyInstalled: true } as InstallCtx);
}

/** Re-apply the app-of-apps — used by the status command when it's missing. */
export async function runApplyRootApp() {
  const tasks = new Listr<InstallCtx>([applyRootAppStep], { concurrent: false, exitOnError: true });
  await tasks.run({} as InstallCtx);
}

import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: there is no cluster topology to read — that belongs to lxup/platform
 * now. The only context worth establishing is whether ArgoCD is already in
 * place, which decides whether this run bootstraps or reconciles.
 */
export const loadContextStep: ListrTask<InstallCtx> = {
  title: "Check whether ArgoCD is already installed",
  task: async (ctx, task) => {
    const { stdout } = await execa(
      "kubectl",
      ["-n", "argocd", "get", "deploy", "argocd-server", "--ignore-not-found", "-o", "name"],
      { env: { KUBECONFIG: kubeconfigPath }, reject: false },
    );

    ctx.alreadyInstalled = (stdout ?? "").trim().length > 0;
    task.title = ctx.alreadyInstalled
      ? "ArgoCD already installed — this run reconciles it"
      : "No ArgoCD yet — this run bootstraps it";
  },
};

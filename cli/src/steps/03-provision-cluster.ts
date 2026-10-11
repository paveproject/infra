import type { ListrTask } from "listr2";
import { existsSync } from "node:fs";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { clusterConfigPath, kubeconfigPath, repoRoot } from "../lib/paths.js";

/**
 * Doc: one call does node creation + k3s install + kubeconfig fetch — far
 * simpler than a Talos-style secrets/genconfig/apply/bootstrap dance,
 * because hetzner-k3s is a higher-level, all-in-one provisioner. Safe to
 * re-run: if the cluster already exists, hetzner-k3s diffs the running
 * cluster against hetzner/cluster_config.yaml and only applies the
 * difference (e.g. a new worker pool, a k3s version bump).
 */
export const provisionClusterStep: ListrTask<InstallCtx> = {
  title: "Provision the cluster with hetzner-k3s",
  task: async (ctx, task) => {
    task.output = existsSync(kubeconfigPath)
      ? "kubeconfig already present — reconciling cluster against config"
      : "No kubeconfig yet — creating cluster from scratch (this takes a few minutes)";

    await execa("hetzner-k3s", ["create", "--config", clusterConfigPath], {
      cwd: repoRoot,
    });

    ctx.clusterAlreadyUp = true;
    task.title = "Cluster provisioned — kubeconfig written to ./kubeconfig";
  },
};

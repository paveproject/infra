import type { ListrTask } from "listr2";
import type { InstallCtx } from "../lib/context.js";
import { loadClusterConfig } from "../lib/clusterconfig.js";

/**
 * Doc: hetzner/cluster_config.yaml is the single source of truth for the
 * cluster's shape (node count, instance types, k3s version). Adding a
 * worker pool later just means editing that file and re-running
 * `bun start install` — hetzner-k3s itself diffs against what's already
 * provisioned.
 */
export const loadContextStep: ListrTask<InstallCtx> = {
  title: "Read cluster config from hetzner/cluster_config.yaml",
  task: async (ctx, task) => {
    const config = await loadClusterConfig();
    Object.assign(ctx, config);

    task.title = `Cluster "${config.clusterName}": ${config.masterCount} master(s), ${config.workerCount} worker(s)`;
  },
};

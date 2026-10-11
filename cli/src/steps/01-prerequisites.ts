import type { ListrTask } from "listr2";
import { commandExists } from "../lib/exec.js";
import type { InstallCtx } from "../lib/context.js";

const REQUIRED = [
  { bin: "hetzner-k3s", brew: "vitobotta/tap/hetzner-k3s" },
  { bin: "helm", brew: "helm" },
  { bin: "kubectl", brew: "kubectl" },
];

/** Doc: these run on your laptop/workstation, not on the cluster nodes themselves. */
export const prerequisitesStep: ListrTask<InstallCtx> = {
  title: "Check required tools",
  task: async (_ctx, task) => {
    const missing: string[] = [];

    for (const { bin, brew } of REQUIRED) {
      const ok = await commandExists(bin);
      task.output = `${ok ? "✓" : "✗"} ${bin}`;
      if (!ok) missing.push(brew);
    }

    if (!process.env.HCLOUD_TOKEN) {
      throw new Error("HCLOUD_TOKEN environment variable must be set (a Hetzner Cloud API token).");
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required tools. Install with:\n  brew install ${missing.join(" ")}`,
      );
    }
  },
};

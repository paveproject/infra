import { existsSync } from "node:fs";
import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: nothing is fetched here — the kubeconfig is handed in (see
 * lib/paths.ts). This checks that the file is present, that the API answers,
 * and — the part that earns its place — that it points at the TENANT rather
 * than at the host cluster. Running this installer against the platform's
 * kubeconfig would install a second ArgoCD into the real cluster beside the
 * one that manages it.
 *
 * The tell is longhorn-system: Longhorn runs on the host, and a vcluster
 * sees its StorageClasses but never its namespace.
 */
export const kubeconfigStep: ListrTask<InstallCtx> = {
  title: "Verify the tenant kubeconfig",
  task: async (_ctx, task) => {
    if (!existsSync(kubeconfigPath)) {
      throw new Error(
        [
          "No ./kubeconfig. This repo no longer creates its own cluster.",
          "",
          "In lxup/platform:",
          "  bun run src/index.ts tenant      # writes tenants/pave.kubeconfig",
          "",
          "then copy that file here as ./kubeconfig.",
        ].join("\n"),
      );
    }

    const env = { KUBECONFIG: kubeconfigPath };

    const version = await execa("kubectl", ["version", "-o", "json"], { env, reject: false });
    if (version.exitCode !== 0) {
      throw new Error(`kubeconfig present but the API is unreachable:\n${version.stderr}`);
    }

    const host = await execa(
      "kubectl",
      ["get", "namespace", "longhorn-system", "--ignore-not-found", "-o", "name"],
      { env, reject: false },
    );

    if ((host.stdout ?? "").trim().length > 0) {
      throw new Error(
        [
          "This kubeconfig points at the HOST cluster, not at pave's vcluster.",
          "(longhorn-system exists — a vcluster sees Longhorn's StorageClasses, never its namespace.)",
          "",
          "Refusing: this would install a second ArgoCD into the real cluster.",
          "Get the right file with `platform tenant` in lxup/platform.",
        ].join("\n"),
      );
    }

    const { stdout: server } = await execa(
      "kubectl",
      ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"],
      { env, reject: false },
    );

    task.title = `Tenant cluster reachable at ${server || "(unknown)"}`;
  },
};

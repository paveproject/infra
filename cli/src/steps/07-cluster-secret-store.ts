import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { clusterSecretStorePath, kubeconfigPath } from "../lib/paths.js";
import { retry } from "../lib/retry.js";

/**
 * Doc: the ClusterSecretStore is what every ExternalSecret in the repo
 * points at. It is applied here rather than by ArgoCD because the ArgoCD
 * repository credentials (step 09) are themselves an ExternalSecret - with
 * a private repo, ArgoCD could not read the manifest that would create its
 * own means of reading it.
 */
export const clusterSecretStoreStep: ListrTask<InstallCtx> = {
  title: "Apply the infisical ClusterSecretStore",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    await execa("kubectl", ["apply", "-f", clusterSecretStorePath], { env });

    await retry(
      async () => {
        const { stdout } = await execa(
          "kubectl",
          [
            "get",
            "clustersecretstore",
            "infisical",
            "-o",
            "jsonpath={.status.conditions[?(@.type=='Ready')].status}",
          ],
          { env },
        );
        task.output = `Ready=${stdout || "<pending>"}`;
        if (stdout !== "True") throw new Error("ClusterSecretStore not Ready yet");
      },
      { attempts: 24, delayMs: 5000 },
    );

    task.title = "ClusterSecretStore infisical is Ready";
  },
};

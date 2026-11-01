import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";
import { retry } from "../lib/retry.js";

/**
 * Doc: a tenant has no nodes of its own, so node readiness is the platform's
 * problem. What does matter is that the vcluster's API server is serving,
 * which it is not for the first few seconds after its control-plane pod
 * starts. Everything downstream (`helm install`, `kubectl apply`) fails
 * confusingly if it runs too early.
 */
export const waitReadyStep: ListrTask<InstallCtx> = {
  title: "Wait for the tenant API to serve",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    await retry(
      async () => {
        const { exitCode, stderr } = await execa("kubectl", ["get", "--raw", "/readyz"], {
          env,
          reject: false,
        });
        if (exitCode !== 0) throw new Error(`/readyz not ready yet: ${stderr}`);
        task.output = "API server reports ready";
      },
      { attempts: 30, delayMs: 4000 },
    );

    task.title = "Tenant API serving";
  },
};

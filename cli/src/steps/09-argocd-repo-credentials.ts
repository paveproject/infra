import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { argocdRepoSecretPath, kubeconfigPath } from "../lib/paths.js";
import { externalSecretReady } from "../lib/kubectl.js";
import { retry } from "../lib/retry.js";

/**
 * Doc: pave's repo is public today, so ArgoCD needs no credentials to read
 * it - but it can be flipped to private at any time, and ArgoCD would then
 * be unable to clone it. The repository credential has to exist before the
 * root app is applied (step 10), and it has to come from outside ArgoCD -
 * hence ESO and the ClusterSecretStore being installed in steps 05-07
 * rather than by ArgoCD itself. Runs unconditionally (works whether the
 * repo is public or private) so flipping it private later needs no new
 * bootstrap step, just a GITHUB_USERNAME/GITHUB_TOKEN pair in Infisical.
 *
 * Waits on the ExternalSecret reporting Ready, not on the Secret existing:
 * a leftover Secret from an earlier run would otherwise read as success
 * while ESO was in fact failing to authenticate.
 */
export const argocdRepoCredentialsStep: ListrTask<InstallCtx> = {
  title: "Create ArgoCD repository credentials",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    task.output = "applying repository ExternalSecret";
    await execa("kubectl", ["apply", "-f", argocdRepoSecretPath], { env });

    await retry(
      async () => {
        if (!(await externalSecretReady("argocd", "github-repo"))) {
          throw new Error("ExternalSecret github-repo not Ready yet");
        }
        task.output = "github-repo synced";
      },
      { attempts: 24, delayMs: 5000 },
    );

    task.title = "ArgoCD can read the repo (works whether it is public or private)";
  },
};

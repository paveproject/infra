import type { ListrTask } from "listr2";
import { execa } from "execa";
import * as p from "@clack/prompts";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: External Secrets Operator's `ClusterSecretStore` (infisical) needs
 * an Infisical Machine Identity's Client ID + Client Secret to
 * authenticate - this is the root of trust for every ExternalSecret in
 * the repo, so it's created here imperatively, never GitOps-managed (ESO
 * can't bootstrap its own auth secret from a ClusterSecretStore that
 * needs that same secret to exist first).
 *
 * Runs BEFORE ArgoCD installs external-secrets so the ClusterSecretStore
 * is immediately valid once ESO's CRDs land - nothing mounts this as a
 * volume (unlike the old sops-age Secret), so there's no FailedMount risk,
 * but every ExternalSecret stays stuck in an auth error until this exists.
 *
 * Safe to re-run: skips prompting if the Secret already exists. Accepts
 * INFISICAL_MACHINE_IDENTITY_CLIENT_ID/_SECRET env vars (same pattern as
 * HCLOUD_TOKEN) for non-interactive runs, otherwise prompts.
 */
export const infisicalSecretStep: ListrTask<InstallCtx> = {
  title: "Create infisical-auth secret for External Secrets Operator",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    const { stdout: namespace } = await execa("kubectl", [
      "create",
      "namespace",
      "external-secrets",
      "--dry-run=client",
      "-o",
      "yaml",
    ]);
    await execa("kubectl", ["apply", "-f", "-"], { env, input: namespace });

    const exists = await execa(
      "kubectl",
      ["get", "secret", "infisical-auth", "-n", "external-secrets"],
      { env, reject: false },
    );
    if (exists.exitCode === 0) {
      task.title = "infisical-auth secret already exists in external-secrets namespace";
      return;
    }

    let clientId = process.env.INFISICAL_MACHINE_IDENTITY_CLIENT_ID;
    let clientSecret = process.env.INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      task.output = "No INFISICAL_MACHINE_IDENTITY_CLIENT_ID/_SECRET env vars - prompting";
      const id = await p.text({
        message: "Infisical Machine Identity Client ID (Universal Auth, eu.infisical.com):",
      });
      if (p.isCancel(id)) throw new Error("Aborted - infisical-auth secret not created.");
      clientId = id;

      const secret = await p.password({ message: "Infisical Machine Identity Client Secret:" });
      if (p.isCancel(secret)) throw new Error("Aborted - infisical-auth secret not created.");
      clientSecret = secret;
    }

    // Built and piped via stdin (not --from-literal as CLI args) so the
    // secret value never shows up in `ps` output.
    const secretYaml = [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      "  name: infisical-auth",
      "  namespace: external-secrets",
      "stringData:",
      `  clientId: ${JSON.stringify(clientId)}`,
      `  clientSecret: ${JSON.stringify(clientSecret)}`,
    ].join("\n");
    await execa("kubectl", ["apply", "-f", "-"], { env, input: secretYaml });

    task.title = "infisical-auth secret ready in external-secrets namespace";
  },
};

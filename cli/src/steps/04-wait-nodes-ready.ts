import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { retry } from "../lib/retry.js";
import { kubeconfigPath } from "../lib/paths.js";

interface NodeList {
  items: Array<{ status: { conditions: Array<{ type: string; status: string }> } }>;
}

export const waitNodesReadyStep: ListrTask<InstallCtx> = {
  title: "Wait for all nodes to go Ready",
  task: async (ctx, task) => {
    const wanted = ctx.masterCount + ctx.workerCount;

    await retry(
      async () => {
        const { stdout } = await execa("kubectl", ["get", "nodes", "-o", "json"], {
          env: { KUBECONFIG: kubeconfigPath },
        });
        const list = JSON.parse(stdout) as NodeList;

        const ready = list.items.filter((n) =>
          n.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
        ).length;

        task.output = `${ready}/${wanted} nodes Ready`;

        if (ready < wanted) {
          throw new Error(`Only ${ready}/${wanted} nodes Ready`);
        }
      },
      { attempts: 30, delayMs: 10_000 },
    );

    task.title = "All nodes Ready";
  },
};

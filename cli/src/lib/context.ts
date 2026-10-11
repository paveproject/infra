import type { ClusterConfig } from "./clusterconfig.js";

/** Shared state threaded through every install step. */
export interface InstallCtx extends ClusterConfig {
  /** True if kubeconfig already exists on disk — cluster was already provisioned. */
  clusterAlreadyUp: boolean;
  ageKeyPath: string;
  agePublicKey?: string;
}

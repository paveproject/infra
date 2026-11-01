/** Shared state threaded through every install step. */
export interface InstallCtx {
  /** True when ArgoCD is already installed — this run is reconciling, not bootstrapping. */
  alreadyInstalled: boolean;
}

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { clusterConfigPath } from "./paths.js";

interface RawClusterConfig {
  cluster_name: string;
  k3s_version: string;
  masters_pool: { instance_type: string; instance_count: number; locations: string[] };
  worker_node_pools?: Array<{ instance_count: number }>;
}

export interface ClusterConfig {
  clusterName: string;
  k3sVersion: string;
  masterCount: number;
  workerCount: number;
}

export async function loadClusterConfig(): Promise<ClusterConfig> {
  const raw = await readFile(clusterConfigPath, "utf8");
  const parsed = parse(raw) as RawClusterConfig;

  const workerCount = (parsed.worker_node_pools ?? []).reduce(
    (sum, pool) => sum + pool.instance_count,
    0,
  );

  return {
    clusterName: parsed.cluster_name,
    k3sVersion: parsed.k3s_version,
    masterCount: parsed.masters_pool.instance_count,
    workerCount,
  };
}

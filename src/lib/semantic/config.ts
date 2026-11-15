import type { CompareOptions } from "./types";

/** Server-managed fields that make live objects differ from manifests. */
export const DEFAULT_IGNORE: string[][] = [
  ["status"],
  ["metadata", "managedFields"],
  ["metadata", "resourceVersion"],
  ["metadata", "uid"],
  ["metadata", "creationTimestamp"],
  ["metadata", "generation"],
  ["metadata", "selfLink"],
  ["metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration"],
  ["metadata", "annotations", "deployment.kubernetes.io/revision"],
  ["spec", "template", "metadata", "creationTimestamp"],
];

/** Merge keys for common k8s lists (mirrors strategic-merge-patch keys). */
export const DEFAULT_MERGE_KEYS: Record<string, string[]> = {
  containers: ["name"],
  initContainers: ["name"],
  ephemeralContainers: ["name"],
  env: ["name"],
  volumes: ["name"],
  volumeMounts: ["mountPath"],
  volumeDevices: ["devicePath"],
  ports: ["containerPort", "port", "name"],
  imagePullSecrets: ["name"],
  hostAliases: ["ip"],
  topologySpreadConstraints: ["topologyKey"],
  subjects: ["name"],
  conditions: ["type"],
};

export const defaultOptions = (): CompareOptions => ({
  ignore: DEFAULT_IGNORE.map((p) => [...p]),
  mergeKeys: { ...DEFAULT_MERGE_KEYS },
  fallbackMergeKeys: ["name", "id"],
  emptyEqualsMissing: true,
  crossNamespace: true,
  pairRenamed: true,
  decodeSecrets: true,
});

/** Keys rendered first in normalized output; everything else is alphabetical. */
export const KEY_PRIORITY = [
  "apiVersion", "kind", "metadata",
  "name", "generateName", "namespace", "labels", "annotations", "image",
  "spec", "data", "stringData", "binaryData",
];

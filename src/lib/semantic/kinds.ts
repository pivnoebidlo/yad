/**
 * What a YAML document is, and the comparison rules that follow from it.
 *
 * Kubernetes manifests: lists such as containers/env are sets keyed by name,
 * server-side noise is ignored. Pipelines (GitHub Actions, GitLab CI, Azure
 * Pipelines, Ansible): order of every list matters (steps, script lines,
 * tasks), nothing is matched by name. Other YAML: maps are unordered, lists
 * are ordered; well-known Kubernetes list fields are still keyed.
 */
import type { CompareOptions } from "./types";

export type DocKind =
  | "kubernetes"
  | "github-actions"
  | "gitlab-ci"
  | "azure-pipelines"
  | "ansible"
  | "compose"
  | "yaml";

export const PIPELINE_KINDS: ReadonlySet<DocKind> = new Set(["github-actions", "gitlab-ci", "azure-pipelines", "ansible"]);

export const KIND_LABELS: Record<DocKind, string> = {
  kubernetes: "Kubernetes",
  "github-actions": "GitHub Actions",
  "gitlab-ci": "GitLab CI",
  "azure-pipelines": "Azure Pipelines",
  ansible: "Ansible",
  compose: "Docker Compose",
  yaml: "YAML",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Record<string, unknown>, ...keys: string[]) => keys.some((k) => k in o);

const ANSIBLE_MODULE = /^(ansible\.builtin\.|community\.|apt|yum|dnf|copy|template|file|shell|command|service|systemd|lineinfile|include_tasks|import_tasks|include_role|import_role|debug|set_fact|uri|git|pip|user|group|unarchive|get_url)/;

/** Classify one parsed document (its plain JS value). */
export function detectKind(v: unknown): DocKind {
  if (Array.isArray(v)) {
    const maps = v.filter(isObj);
    if (maps.some((m) => "hosts" in m && has(m, "tasks", "roles", "pre_tasks", "post_tasks")) || maps.some((m) => "import_playbook" in m))
      return "ansible";
    if (maps.length && maps.some((m) => Object.keys(m).some((k) => ANSIBLE_MODULE.test(k)) || has(m, "when", "register", "become", "loop", "with_items")))
      return "ansible";
    return "yaml";
  }
  if (!isObj(v)) return "yaml";
  if (typeof v.apiVersion === "string" && typeof v.kind === "string") return "kubernetes";
  if (isObj(v.jobs) && (has(v, "on", "true") || Object.values(v.jobs).some((j) => isObj(j) && has(j, "runs-on", "steps", "uses"))))
    return "github-actions";
  if (has(v, "trigger", "pool", "pr") && has(v, "steps", "jobs", "stages", "extends")) return "azure-pipelines";
  if (Array.isArray(v.stages) && Object.values(v).some((j) => isObj(j) && has(j, "script", "stage", "trigger", "extends"))) return "gitlab-ci";
  if (Object.values(v).some((j) => isObj(j) && Array.isArray(j.script) && has(j, "stage", "image", "before_script", "rules", "only", "needs")))
    return "gitlab-ci";
  if (has(v, "steps") && Array.isArray(v.steps) && v.steps.some((s) => isObj(s) && has(s, "script", "bash", "task", "pwsh", "checkout")))
    return "azure-pipelines";
  if (isObj(v.services) && Object.values(v.services).some((s) => isObj(s) && has(s, "image", "build"))) return "compose";
  return "yaml";
}

/** Comparison options for a document of this kind, derived from the user's options. */
export function optionsForKind(kind: DocKind, base: CompareOptions): CompareOptions {
  if (kind === "kubernetes") return base;
  if (PIPELINE_KINDS.has(kind)) return { ...base, ignore: [], mergeKeys: {}, fallbackMergeKeys: [] };
  return { ...base, ignore: [], fallbackMergeKeys: [] };
}

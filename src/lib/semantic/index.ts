import { defaultOptions } from "./config";
import { diffNodes } from "./diff";
import { matchResources, parseResources } from "./resources";
import type { CompareOptions, CompareResult, ResourceDiff } from "./types";

export * from "./types";
export { defaultOptions, DEFAULT_IGNORE, DEFAULT_MERGE_KEYS } from "./config";
export { formatPath, locatePath } from "./util";
export { renderNormalized, normalizeResource, type NormalizedView } from "./normalize";

const sortKey = (r: ResourceDiff) => {
  const id = (r.a ?? r.b)!.id;
  return id ? `0|${id.kind}|${id.namespace}|${id.name}|${id.group}` : `1|${r.key}`;
};

/** Semantic comparison of two YAML/JSON texts (k8s-aware). */
export function compareTexts(a: string, b: string, options: Partial<CompareOptions> = {}): CompareResult {
  const opts = { ...defaultOptions(), ...options };
  const pa = parseResources(a);
  const pb = parseResources(b);

  const resources: ResourceDiff[] = matchResources(pa.resources, pb.resources).map(([ra, rb]) => {
    const r = (ra ?? rb)!;
    if (!ra) return { key: r.key, label: r.label, status: "added", b: rb, changes: [] };
    if (!rb) return { key: r.key, label: r.label, status: "removed", a: ra, changes: [] };
    const ignore = ra.id || rb.id ? opts.ignore : [];
    const changes = diffNodes(ra.node, rb.node, ra.ctx, rb.ctx, opts, ignore);
    return { key: r.key, label: r.label, status: changes.length ? "changed" : "equal", a: ra, b: rb, changes };
  });

  resources.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
  return { resources, errors: { a: pa.errors, b: pb.errors } };
}

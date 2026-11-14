import { defaultOptions } from "./config";
import { diffNodes } from "./diff";
import { matchResources, parseResources } from "./resources";
import { planApply, type ApplyItem, type ApplyResult } from "./patch";
import type { CompareOptions, CompareResult, PathSeg, ResourceDiff } from "./types";

export * from "./types";
export { defaultOptions, DEFAULT_IGNORE, DEFAULT_MERGE_KEYS } from "./config";
export { formatPath, locatePath, shortPath } from "./util";
export { renderNormalized, normalizeResource, type NormalizedView } from "./normalize";
export { planApply, applyEdits, type ApplyItem, type ApplyResult, type Direction, type Edit } from "./patch";

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

/** What an apply touched in the target: a resource (by its key in the target) or a path in it. */
export interface Touched {
  key: string;
  path?: PathSeg[];
}

const segEq = (x: PathSeg, y: PathSeg) =>
  typeof x === "object" && typeof y === "object" ? x.key === y.key && x.value === y.value : x === y;
const isPrefix = (p: PathSeg[], q: PathSeg[]) => p.length <= q.length && p.every((s, i) => segEq(s, q[i]));

/**
 * Undo an earlier apply selectively: bring the `touched` paths of `current`
 * back to how they were in `before` (the target text right before that apply),
 * leaving every other later edit alone.
 */
export function planRevert(before: string, current: string, touched: Touched[], options: Partial<CompareOptions> = {}): ApplyResult {
  const res = compareTexts(before, current, options);
  const items: ApplyItem[] = [];
  for (const r of res.resources) {
    if (r.status === "equal") continue;
    const ts = touched.filter((t) => t.key === r.key || t.key === r.a?.key || t.key === r.b?.key);
    if (!ts.length) continue;
    if (!r.a || !r.b || ts.some((t) => !t.path)) {
      items.push({ resource: r });
      continue;
    }
    for (const c of r.changes)
      if (ts.some((t) => isPrefix(t.path!, c.path) || isPrefix(c.path, t.path!))) items.push({ resource: r, change: c });
  }
  return planApply(items, "a-to-b", current);
}

/**
 * The user edited the normalized (semantic) text of one side from `oldNorm`
 * to `newNorm`: compute edits that carry exactly those changes over to the
 * real `source` text of that side, keeping its formatting and comments.
 * Returns `parseError` (and no edits) while `newNorm` is not valid YAML.
 */
export function planSemanticEdit(
  oldNorm: string, newNorm: string, source: string, options: Partial<CompareOptions> = {},
): ApplyResult & { parseError?: { line: number; message: string } } {
  const diff = compareTexts(oldNorm, newNorm, options);
  if (diff.errors.b.length) return { side: "b", edits: [], errors: [], parseError: diff.errors.b[0] };
  const touched: Touched[] = [];
  for (const r of diff.resources) {
    if (r.status === "equal") continue;
    if (!r.a || !r.b) touched.push({ key: (r.a ?? r.b)!.key });
    else for (const c of r.changes) touched.push({ key: r.b.key, path: c.path });
  }
  if (!touched.length) return { side: "b", edits: [], errors: [] };
  return planRevert(newNorm, source, touched, options);
}

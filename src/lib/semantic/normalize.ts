import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, stringify, type Node, type Pair } from "yaml";
import { KEY_PRIORITY } from "./config";
import type { CompareOptions, PathSeg, Resource, ResourceDiff, SourceCtx, SourceRange } from "./types";
import { deref, fieldName, getScalar, isEmptyAfterIgnore, isIgnored, keyString, locatePath, pickMergeKey, toJS } from "./util";

const keyRank = (k: string) => {
  const i = KEY_PRIORITY.indexOf(k);
  return i < 0 ? KEY_PRIORITY.length : i;
};
const byKey = (x: string, y: string) => keyRank(x) - keyRank(y) || (x < y ? -1 : x > y ? 1 : 0);

/**
 * Canonical form of a node: ignored paths dropped, map keys in a stable order,
 * keyed lists sorted by their merge key. Maps become JS `Map`s so key order
 * survives (plain objects reorder integer-like keys).
 */
function canonical(n0: unknown, ctx: SourceCtx, path: PathSeg[], opts: CompareOptions, ignore: string[][]): unknown {
  const n = deref(n0, ctx);
  if (isMap(n)) {
    const pairs = (n.items as Pair[])
      .map((p) => [keyString(p), p] as const)
      .filter(([k, p]) => {
        const sub = [...path, k];
        return !isIgnored(sub, ignore) && !(opts.emptyEqualsMissing && isEmptyAfterIgnore(p.value, ctx, sub, ignore));
      })
      .sort(([x], [y]) => byKey(x, y));
    return new Map(pairs.map(([k, p]) => [k, canonical(p.value, ctx, [...path, k], opts, ignore)]));
  }
  if (isSeq(n)) {
    const mk = pickMergeKey(fieldName(path), [{ items: n.items, ctx }], opts);
    let items = n.items.map((it, i) => ({ it, seg: i as PathSeg }));
    if (mk) {
      items = items
        .map(({ it }) => ({ it, seg: { key: mk, value: getScalar(deref(it, ctx) as never, mk, ctx)! } as PathSeg }))
        .sort((x, y) => {
          const a = (x.seg as { value: string }).value, b = (y.seg as { value: string }).value;
          return a.localeCompare(b, undefined, { numeric: true });
        });
    }
    return items.map(({ it, seg }) => canonical(it, ctx, [...path, seg], opts, ignore));
  }
  if (isScalar(n)) return n.value;
  return toJS(n as Node | null, ctx);
}

export function normalizeResource(r: Resource, opts: CompareOptions): string {
  const ignore = r.id ? opts.ignore : [];
  return stringify(canonical(r.node, r.ctx, [], opts, ignore), { lineWidth: 0, indentSeq: true });
}

export interface NormalizedView {
  a: string;
  b: string;
  /** Range of a resource (or a path inside it) in the normalized text of one side. */
  locate(side: "a" | "b", resourceKey: string, path?: PathSeg[]): SourceRange | undefined;
}

/**
 * Two aligned normalized texts (same resource order on both sides), suitable
 * for a plain line diff that shows only semantic differences.
 */
export function renderNormalized(resources: ResourceDiff[], opts: CompareOptions): NormalizedView {
  const parts = { a: [] as string[], b: [] as string[] };
  const keys = { a: [] as string[], b: [] as string[] };
  for (const r of resources) {
    const header = `# ${r.label}\n`;
    for (const side of ["a", "b"] as const) {
      const res = r[side];
      if (!res) continue;
      parts[side].push(header + normalizeResource(res, opts));
      keys[side].push(r.key);
    }
  }
  const a = parts.a.join("---\n");
  const b = parts.b.join("---\n");

  // Parsed lazily: only needed for navigation.
  const index: Partial<Record<"a" | "b", Map<string, { node: Node; ctx: SourceCtx }>>> = {};
  const build = (side: "a" | "b") => {
    const lc = new LineCounter();
    const docs = parseAllDocuments(side === "a" ? a : b, { lineCounter: lc });
    const m = new Map<string, { node: Node; ctx: SourceCtx }>();
    (Array.isArray(docs) ? docs : []).forEach((doc, i) => {
      if (doc.contents && keys[side][i] !== undefined) m.set(keys[side][i], { node: doc.contents as Node, ctx: { doc, lc } });
    });
    return m;
  };

  return {
    a,
    b,
    locate(side, resourceKey, path = []) {
      const entry = (index[side] ??= build(side)).get(resourceKey);
      return entry && locatePath(entry.node, path, entry.ctx);
    },
  };
}

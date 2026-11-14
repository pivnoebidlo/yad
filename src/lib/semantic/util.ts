import { isAlias, isMap, isScalar, isSeq, type Node, type Pair, type YAMLMap } from "yaml";
import type { CompareOptions, PathSeg, SourceCtx, SourceRange } from "./types";

/** Follow aliases (`*ref`) to the anchored node. */
export function deref(node: unknown, ctx: SourceCtx): Node | null {
  if (node == null) return null;
  if (isAlias(node)) return (node.resolve(ctx.doc) as Node | undefined) ?? null;
  return node as Node;
}

export function keyString(pair: Pair): string {
  const k = pair.key as unknown;
  if (isScalar(k)) return String(k.value);
  return String(k);
}

export function getPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => keyString(p as Pair) === key) as Pair | undefined;
}

/** Scalar value at `key` as a string, or undefined. */
export function getScalar(map: YAMLMap, key: string, ctx: SourceCtx): string | undefined {
  const pair = getPair(map, key);
  const v = pair && deref(pair.value, ctx);
  return isScalar(v) && v.value != null ? String(v.value) : undefined;
}

export function getMap(map: YAMLMap, key: string, ctx: SourceCtx): YAMLMap | undefined {
  const pair = getPair(map, key);
  const v = pair && deref(pair.value, ctx);
  return isMap(v) ? v : undefined;
}

export function nodeRange(node: Node | null | undefined, ctx: SourceCtx): SourceRange | undefined {
  const r = node?.range;
  if (!r) return undefined;
  return { from: r[0], to: r[1], line: ctx.lc.linePos(r[0]).line };
}

/** Range covering `key: value`. */
export function pairRange(pair: Pair, ctx: SourceCtx): SourceRange | undefined {
  const k = nodeRange(pair.key as Node, ctx);
  const v = nodeRange(pair.value as Node, ctx);
  if (!k) return v;
  return { from: k.from, to: v?.to ?? k.to, line: k.line };
}

export function toJS(node: Node | null, ctx: SourceCtx): unknown {
  if (node == null) return null;
  return node.toJS(ctx.doc, { maxAliasCount: -1 });
}

/** JSON with sorted object keys, for order-insensitive equality. */
export function canonicalString(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val,
  );
}

export function isIgnored(path: PathSeg[], patterns: string[][]): boolean {
  return patterns.some(
    (p) => p.length === path.length && p.every((seg, i) => seg === "*" || seg === path[i]),
  );
}

/** True for a map/list that has nothing left once ignored paths are removed. */
export function isEmptyAfterIgnore(n0: unknown, ctx: SourceCtx, path: PathSeg[], ignore: string[][]): boolean {
  const n = deref(n0, ctx);
  if (isSeq(n)) return n.items.length === 0;
  if (!isMap(n)) return false;
  return (n.items as Pair[]).every((p) => {
    const sub = [...path, keyString(p)];
    return isIgnored(sub, ignore) || isEmptyAfterIgnore(p.value, ctx, sub, ignore);
  });
}

/** Field name a list lives under: last string segment of its path. */
export function fieldName(path: PathSeg[]): string | undefined {
  const last = path[path.length - 1];
  return typeof last === "string" ? last : undefined;
}

/**
 * Pick a key that identifies every item in the given lists: each item must be a
 * map with a scalar value for it, unique within its own list.
 */
export function pickMergeKey(
  field: string | undefined,
  lists: Array<{ items: unknown[]; ctx: SourceCtx }>,
  opts: CompareOptions,
): string | null {
  const candidates = (field && opts.mergeKeys[field]) || opts.fallbackMergeKeys;
  if (lists.every((l) => l.items.length === 0)) return null;
  for (const k of candidates) {
    const ok = lists.every(({ items, ctx }) => {
      const seen = new Set<string>();
      return items.every((it) => {
        const n = deref(it, ctx);
        const v = isMap(n) ? getScalar(n, k, ctx) : undefined;
        if (v === undefined || seen.has(v)) return false;
        seen.add(v);
        return true;
      });
    });
    if (ok) return k;
  }
  return null;
}

export function formatPath(path: PathSeg[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (typeof seg === "object") out += `[${seg.value}]`;
    else out += /^[A-Za-z_$][\w$-]*$/.test(seg) ? (out ? "." : "") + seg : `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/**
 * Find the node at `path` inside a parsed tree and return its source range.
 * For a map key the range covers `key: value`. Returns the deepest node
 * reached if the full path does not exist.
 */
export function locatePath(root: Node, path: PathSeg[], ctx: SourceCtx): SourceRange | undefined {
  let node: Node | null = root;
  let range = nodeRange(root, ctx);
  for (const seg of path) {
    if (typeof seg === "string" && isMap(node)) {
      const pair = getPair(node, seg);
      if (!pair) break;
      range = pairRange(pair, ctx);
      node = deref(pair.value, ctx);
    } else if (typeof seg === "number" && isSeq(node)) {
      const it = deref(node.items[seg], ctx);
      if (!it) break;
      range = nodeRange(it, ctx);
      node = it;
    } else if (typeof seg === "object" && isSeq(node)) {
      const it: Node | null | undefined = node.items.map((n) => deref(n, ctx)).find((n) => isMap(n) && getScalar(n, seg.key, ctx) === seg.value);
      if (!it) break;
      range = nodeRange(it, ctx);
      node = it;
    } else break;
  }
  return range;
}

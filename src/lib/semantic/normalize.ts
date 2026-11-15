import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, stringify, type Node, type Pair } from "yaml";
import { KEY_PRIORITY } from "./config";
import { optionsForKind } from "./kinds";
import type { CompareOptions, PathSeg, Resource, ResourceDiff, SourceCtx, SourceRange } from "./types";
import { decodeBase64Text, encodeSecretsInText, isSecret } from "./secrets";
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
  return normalizeWithSecrets(r, opts).text;
}

/** Normalized text; for a Secret (if enabled) `data` values are shown decoded, except `rawKeys` (not text). */
function normalizeWithSecrets(r: Resource, opts: CompareOptions): { text: string; rawKeys?: Set<string>; decoded?: number } {
  const o = optionsForKind(r.docKind, opts);
  const value = canonical(r.node, r.ctx, [], o, o.ignore);
  let rawKeys: Set<string> | undefined, decoded = 0;
  if (opts.decodeSecrets && isSecret(r) && value instanceof Map && value.get("data") instanceof Map) {
    rawKeys = new Set();
    const data = value.get("data") as Map<string, unknown>;
    for (const [k, v] of data) {
      const d = decodeBase64Text(v);
      if (d === undefined) rawKeys.add(k);
      else {
        data.set(k, d);
        decoded++;
      }
    }
  }
  return { text: stringify(value, { lineWidth: 0, indentSeq: true }), rawKeys, decoded };
}

export interface NormalizedView {
  a: string;
  b: string;
  /** Range of a resource (or a path inside it) in the normalized text of one side. */
  locate(side: "a" | "b", resourceKey: string, path?: PathSeg[]): SourceRange | undefined;
  /**
   * Normalized text of one side (as shown, possibly edited) with Secret
   * values encoded back to base64, i.e. comparable with the source file.
   */
  encode(side: "a" | "b", text: string): string;
  /** Resource and path of the deepest node at `offset` in one side's normalized text. */
  pathAt(side: "a" | "b", offset: number): { key: string; path: PathSeg[] } | undefined;
}

function pathInside(root: Node, offset: number, ctx: SourceCtx, opts: CompareOptions): PathSeg[] {
  const path: PathSeg[] = [];
  let node: Node | null = root;
  const contains = (from: number, to: number) => offset >= from && offset <= to;
  for (;;) {
    if (isMap(node)) {
      const pair = (node.items as Pair[]).find((p) => {
        const k = (p.key as Node).range!, v = (p.value as Node | null)?.range;
        return contains(k[0], v ? v[1] : k[1]);
      });
      if (!pair) break;
      path.push(keyString(pair));
      node = deref(pair.value, ctx);
    } else if (isSeq(node)) {
      const seq: typeof node = node;
      const i = seq.items.findIndex((it) => {
        const r = (it as Node).range;
        return r && contains(r[0], r[1]);
      });
      if (i < 0) break;
      const item = deref(seq.items[i], ctx);
      const mk = pickMergeKey(fieldName(path), [{ items: seq.items, ctx }], opts);
      const v = mk && isMap(item) ? getScalar(item, mk, ctx) : undefined;
      path.push(mk && v !== undefined ? { key: mk, value: v } : i);
      node = item;
    } else break;
  }
  return path;
}

/**
 * Two aligned normalized texts (same resource order on both sides), suitable
 * for a plain line diff that shows only semantic differences.
 */
export function renderNormalized(resources: ResourceDiff[], opts: CompareOptions): NormalizedView {
  const parts = { a: [] as string[], b: [] as string[] };
  const keys = { a: [] as string[], b: [] as string[] };
  const raw = { a: new Map<string, Set<string>>(), b: new Map<string, Set<string>>() };
  for (const r of resources) {
    for (const side of ["a", "b"] as const) {
      const res = r[side];
      if (!res) continue;
      const n = normalizeWithSecrets(res, opts);
      if (n.rawKeys) raw[side].set(res.key, n.rawKeys);
      const note = n.decoded ? "  (data: decoded from base64, saved encoded)" : "";
      parts[side].push(`# ${r.label}${note}\n${n.text}`);
      keys[side].push(r.key);
    }
  }
  const kinds = new Map(resources.map((r) => [r.key, (r.a ?? r.b)!.docKind]));
  const a = parts.a.join("---\n");
  const b = parts.b.join("---\n");

  // Parsed lazily: only needed for navigation.
  const index: Partial<Record<"a" | "b", Map<string, { node: Node; ctx: SourceCtx }>>> = {};
  const build = (side: "a" | "b") => {
    const lc = new LineCounter();
    const docs = parseAllDocuments(side === "a" ? a : b, { lineCounter: lc });
    const m = new Map<string, { node: Node; ctx: SourceCtx }>();
    (Array.isArray(docs) ? docs : []).forEach((doc, i) => {
      if (doc.contents && keys[side][i] !== undefined) m.set(keys[side][i], { node: doc.contents as Node, ctx: { doc, lc, text: side === "a" ? a : b } });
    });
    return m;
  };

  return {
    a,
    b,
    encode(side, text) {
      return opts.decodeSecrets ? encodeSecretsInText(text, (k) => raw[side].get(k)) : text;
    },
    locate(side, resourceKey, path = []) {
      const entry = (index[side] ??= build(side)).get(resourceKey);
      return entry && locatePath(entry.node, path, entry.ctx);
    },
    pathAt(side, offset) {
      // Last document starting at or before the offset (a document includes
      // its `# Kind name` header comment).
      let best: { key: string; node: Node; ctx: SourceCtx } | undefined;
      for (const [key, e] of (index[side] ??= build(side))) {
        const start = e.ctx.doc.range?.[0] ?? e.node.range?.[0] ?? 0;
        if (!best || start <= offset) best = { key, ...e };
        else break;
      }
      if (!best) return undefined;
      return { key: best.key, path: pathInside(best.node, offset, best.ctx, optionsForKind(kinds.get(best.key) ?? "yaml", opts)) };
    },
  };
}

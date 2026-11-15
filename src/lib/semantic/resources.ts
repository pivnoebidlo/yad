import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, visit, type Node, type Pair, type YAMLMap } from "yaml";
import type { ParseError, Resource, ResourceId, SourceCtx } from "./types";
import { deref, getMap, getScalar, getPair, nodeRange, toJS } from "./util";
import { detectKind } from "./kinds";

function resourceId(map: YAMLMap, ctx: SourceCtx): ResourceId | null {
  const apiVersion = getScalar(map, "apiVersion", ctx) ?? "";
  const kind = getScalar(map, "kind", ctx);
  const meta = getMap(map, "metadata", ctx);
  const name = meta && getScalar(meta, "name", ctx);
  if (!kind || !name) return null;
  const slash = apiVersion.indexOf("/");
  return {
    apiVersion,
    group: slash >= 0 ? apiVersion.slice(0, slash) : "",
    kind,
    namespace: (meta && getScalar(meta, "namespace", ctx)) ?? "",
    name,
  };
}

export const idKey = (id: ResourceId) => `${id.group}/${id.kind}/${id.namespace}/${id.name}`;

export const idLabel = (id: ResourceId) =>
  `${id.kind} ${id.namespace ? id.namespace + "/" : ""}${id.name}`;

/**
 * Split a YAML/JSON text into resources. Multi-document streams and
 * `kind: List` (as produced by `kubectl get -o yaml`) are flattened.
 */
export function parseResources(text: string): { resources: Resource[]; errors: ParseError[]; warnings: ParseError[] } {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: false });
  const resources: Resource[] = [];
  const errors: ParseError[] = [];
  const warnings: ParseError[] = [];
  const list = Array.isArray(docs) ? docs : [];
  const seen = new Map<string, number>();

  const add = (node: Node, ctx: SourceCtx, fallbackKey: string) => {
    const id = isMap(node) ? resourceId(node, ctx) : null;
    let key = id ? idKey(id) : fallbackKey;
    // Duplicates in one file get a suffix so they still match pairwise.
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `~${n}`;
    resources.push({
      key,
      id,
      docKind: id ? "kubernetes" : detectKind(toJS(node, ctx)),
      label: id ? idLabel(id) : `Document ${fallbackKey.slice(1)}`,
      node,
      range: nodeRange(node, ctx) ?? { from: 0, to: 0, line: 1 },
      ctx,
    });
  };

  list.forEach((doc, docIndex) => {
    const ctx: SourceCtx = { doc, lc, text };
    for (const e of doc.errors)
      errors.push({ message: e.message, line: lc.linePos(e.pos[0]).line });
    dropDuplicateKeys(doc, lc, warnings);
    const root = deref(doc.contents, ctx);
    if (root == null || (isScalar(root) && root.value == null)) return;
    if (isMap(root)) {
      const kind = getScalar(root, "kind", ctx);
      const items = deref(getPair(root, "items")?.value, ctx);
      if (kind && /List$/.test(kind) && isSeq(items)) {
        items.items.forEach((it, i) => {
          const n = deref(it, ctx);
          if (n) add(n, ctx, `#${docIndex + 1}.${i + 1}`);
        });
        return;
      }
    }
    add(root, ctx, `#${docIndex + 1}`);
  });

  return { resources, errors, warnings };
}

/**
 * A key repeated in one map is invalid YAML, yet real files have it (and many
 * tools silently take the last value). Keep the last pair, so the comparison
 * shows what those tools see, and warn about each earlier one.
 */
function dropDuplicateKeys(doc: Parameters<typeof visit>[0], lc: LineCounter, warnings: ParseError[]) {
  visit(doc, {
    Map(_, map) {
      const last = new Map<string, Pair>();
      for (const p of map.items as Pair[]) last.set(isScalar(p.key) ? String(p.key.value) : String(p.key), p);
      if (last.size === map.items.length) return;
      map.items = (map.items as Pair[]).filter((p) => {
        const k = isScalar(p.key) ? String(p.key.value) : String(p.key);
        const keep = last.get(k)!;
        if (keep === p) return true;
        const at = (n: unknown) => lc.linePos((n as Node).range?.[0] ?? 0).line;
        warnings.push({ line: at(keep.key), message: `duplicate key "${k}": the one at line ${at(p.key)} is ignored` });
        return false;
      });
    },
  });
}

/**
 * Pair resources from both sides. Exact key first; then a resource whose
 * namespace is omitted on one side matches the same group/kind/name on the
 * other (a manifest without namespace vs a live object in some namespace).
 */
export function matchResources(as: Resource[], bs: Resource[], crossNamespace = true, pairRenamed = false): Array<[Resource?, Resource?]> {
  const pairs: Array<[Resource?, Resource?]> = [];
  const freeB = new Map(bs.map((r) => [r.key, r]));
  const unmatchedA: Resource[] = [];

  for (const a of as) {
    const b = freeB.get(a.key);
    if (b) {
      freeB.delete(a.key);
      pairs.push([a, b]);
    } else unmatchedA.push(a);
  }

  for (const a of unmatchedA) {
    let found: Resource | undefined;
    if (a.id) {
      for (const b of freeB.values()) {
        if (
          b.id && b.id.group === a.id.group && b.id.kind === a.id.kind &&
          b.id.name === a.id.name && (!a.id.namespace || !b.id.namespace)
        ) { found = b; break; }
      }
    }
    if (found) freeB.delete(found.key);
    pairs.push([a, found]);
  }

  // Environments often differ only by namespace (overlays for shop-stage and
  // shop-prod): pair group/kind/name across namespaces when that is unambiguous,
  // i.e. there is exactly one such resource left on each side.
  const gkn = (r: Resource) => r.id && `${r.id.group}/${r.id.kind}/${r.id.name}`;
  const count = (rs: Iterable<Resource>) => {
    const m = new Map<string, number>();
    for (const r of rs) { const k = gkn(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  const leftA = crossNamespace ? pairs.filter((p) => p[0] && !p[1]) : [];
  const countA = count(leftA.map((p) => p[0]!));
  const countB = count(freeB.values());
  for (const p of leftA) {
    const k = gkn(p[0]!);
    if (!k || countA.get(k) !== 1 || countB.get(k) !== 1) continue;
    const b = [...freeB.values()].find((r) => gkn(r) === k)!;
    freeB.delete(b.key);
    p[1] = b;
  }

  // Names that carry the environment (elk-stage vs elk-prod): pair the last
  // resource of a group/kind left on each side, if there is exactly one and
  // the names look related (same first or last word, see `relatedNames`).
  if (pairRenamed) {
    const gk = (r: Resource) => r.id && `${r.id.group}/${r.id.kind}`;
    const leftA2 = pairs.filter((p) => p[0] && !p[1]);
    const countA2 = new Map<string, number>(), countB2 = new Map<string, number>();
    for (const p of leftA2) { const k = gk(p[0]!); if (k) countA2.set(k, (countA2.get(k) ?? 0) + 1); }
    for (const b of freeB.values()) { const k = gk(b); if (k) countB2.set(k, (countB2.get(k) ?? 0) + 1); }
    for (const p of leftA2) {
      const k = gk(p[0]!);
      if (!k || countA2.get(k) !== 1 || countB2.get(k) !== 1) continue;
      const b = [...freeB.values()].find((r) => gk(r) === k)!;
      const a = p[0]!;
      if (!relatedNames(a.id!.name, b.id!.name) || (!crossNamespace && a.id!.namespace !== b.id!.namespace)) continue;
      freeB.delete(b.key);
      p[1] = b;
    }
  }

  for (const b of freeB.values()) pairs.push([undefined, b]);
  return pairs;
}

/** `elk-stage` / `elk-prod`, `kedo-grk` / `kedo-eurochem`: the same first or last word. */
export function relatedNames(x: string, y: string): boolean {
  if (x === y) return true;
  const wx = x.split(/[-._]/).filter(Boolean), wy = y.split(/[-._]/).filter(Boolean);
  if (wx.length < 2 && wy.length < 2) return false;
  return wx[0] === wy[0] || wx[wx.length - 1] === wy[wy.length - 1];
}

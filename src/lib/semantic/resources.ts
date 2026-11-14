import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, type Node, type YAMLMap } from "yaml";
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
export function parseResources(text: string): { resources: Resource[]; errors: ParseError[] } {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, prettyErrors: false });
  const resources: Resource[] = [];
  const errors: ParseError[] = [];
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

  return { resources, errors };
}

/**
 * Pair resources from both sides. Exact key first; then a resource whose
 * namespace is omitted on one side matches the same group/kind/name on the
 * other (a manifest without namespace vs a live object in some namespace).
 */
export function matchResources(as: Resource[], bs: Resource[]): Array<[Resource?, Resource?]> {
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
  for (const b of freeB.values()) pairs.push([undefined, b]);
  return pairs;
}

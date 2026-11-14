/**
 * Applying changes to a JSON target. Editing JSON text with YAML snippets
 * would break it, so the change is applied to the parsed value and the file
 * is serialized again with its own indentation (JSON has no comments to lose).
 */
import type { ApplyItem, ApplyResult, Direction } from "./patch";
import type { PathSeg, Resource } from "./types";
import { anchorIndex, canonicalString, minimalEdit, pathOn, toJS } from "./util";

/** True when the text is a JSON document (not just YAML that happens to parse). */
export function isJsonText(text: string): boolean {
  const s = text.trimStart();
  if (!s.startsWith("{") && !s.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Indentation used by a JSON text: spaces count, or "\t". */
function detectIndent(text: string): number | string {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

const DELETED = Symbol("deleted");
type Json = any;

export function planApplyJson(items: ApplyItem[], dir: Direction, targetText: string): ApplyResult {
  const side = dir === "a-to-b" ? "b" : "a";
  const srcSide = dir === "a-to-b" ? "a" : "b";
  const errors: string[] = [];
  const box = { root: JSON.parse(targetText) as Json };
  const inserts = new Map<Json[], Array<{ at: number; value: Json }>>();

  // Where a resource lives inside the JSON value: the root, or an item of a `kind: List`.
  const resourcePrefix = (r: Resource): PathSeg[] | null => {
    const doc = r.ctx.doc.contents;
    if (doc === r.node) return [];
    const items = box.root?.items;
    if (!Array.isArray(items)) return null;
    const want = canonicalString(toJS(r.node, r.ctx));
    const i = items.findIndex((x) => canonicalString(x) === want);
    return i < 0 ? null : ["items", i];
  };

  /** Container and key for a path (keyed segments are looked up by value). */
  function locate(path: PathSeg[], from: { root: Json } = box): { parent: Json; key: string | number } | null {
    let cur: Json = from;
    let key: string | number = "root";
    for (const seg of path) {
      const next: Json = cur[key];
      if (next === undefined || next === null || typeof next !== "object") return null;
      if (typeof seg === "object") {
        if (!Array.isArray(next)) return null;
        const i: number = next.findIndex((x) => x && typeof x === "object" && String(x[seg.key]) === seg.value);
        if (i < 0) return null;
        cur = next;
        key = i;
      } else {
        cur = next;
        key = seg;
      }
    }
    return { parent: cur, key };
  }

  const clone = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const remove = (loc: { parent: Json; key: string | number }) => {
    if (Array.isArray(loc.parent)) loc.parent[loc.key as number] = DELETED;
    else delete loc.parent[loc.key];
  };
  /** Insert into a target container; list items go next to their source neighbours. */
  const insertAt = (container: Json, seg: PathSeg, value: Json, srcList?: Json[]) => {
    if (Array.isArray(container)) {
      let at = container.length;
      if (typeof seg === "number" && srcList) {
        const keys = (xs: Json[]) => xs.map((x) => (x === DELETED ? "\0" : canonicalString(x)));
        const { after, before } = anchorIndex(keys(srcList), seg, keys(container));
        at = after !== undefined ? after + 1 : before!;
      }
      (inserts.get(container) ?? inserts.set(container, []).get(container)!).push({ at, value });
    } else container[seg as string] = value;
  };

  for (const { resource: r, change: c } of items) {
    const [sr, dr] = dir === "a-to-b" ? [r.a, r.b] : [r.b, r.a];
    const fail = (why: string) => errors.push(`${r.label}: ${why}`);
    if (!c && !dr && sr) {
      if (Array.isArray(box.root?.items)) box.root.items.push(clone(toJS(sr.node, sr.ctx)));
      else if (targetText.trim() === "") box.root = clone(toJS(sr.node, sr.ctx));
      else fail("a JSON file holds one document; cannot add another");
      continue;
    }
    if (!c && dr && !sr) {
      const pre = resourcePrefix(dr);
      const loc = pre && pre.length ? locate(pre) : null;
      if (loc) remove(loc);
      else fail("cannot remove the only document of a JSON file");
      continue;
    }
    if (!sr || !dr) continue;
    const pre = resourcePrefix(dr);
    if (!pre) { fail("resource not found in the JSON target"); continue; }
    const srcRoot = { root: clone(toJS(sr.node, sr.ctx)) };
    const srcList = (p: PathSeg[]) => {
      const loc = locate(p.slice(0, -1), srcRoot);
      const v = loc && loc.parent[loc.key];
      return Array.isArray(v) ? v : undefined;
    };
    const changes = c ? [c] : r.changes;
    for (const ch of changes) {
      const sp = pathOn(ch, srcSide), dp = pathOn(ch, side);
      const srcValue = ch.kind === "moved" || (srcSide === "a" ? ch.kind !== "added" : ch.kind !== "removed")
        ? (srcSide === "a" ? ch.a : ch.b) : undefined;
      const dstHas = side === "a" ? ch.kind !== "added" : ch.kind !== "removed";
      if (ch.kind === "moved") {
        const loc = locate([...pre, ...dp]);
        const parent = locate([...pre, ...dp.slice(0, -1)]);
        if (!loc || !parent) { fail("path not found"); continue; }
        remove(loc);
        const si = sp[sp.length - 1] as number, di = dp[dp.length - 1] as number;
        insertAt(parent.parent[parent.key], si, clone(srcValue), srcList(sp));
      } else if (srcValue !== undefined && dstHas) {
        const loc = locate([...pre, ...dp]);
        if (!loc) { fail("path not found"); continue; }
        loc.parent[loc.key] = clone(srcValue);
      } else if (dstHas) {
        const loc = locate([...pre, ...dp]);
        if (!loc) { fail("path not found"); continue; }
        remove(loc);
      } else {
        const parent = locate([...pre, ...dp.slice(0, -1)]);
        const container = parent && parent.parent[parent.key];
        if (!container || typeof container !== "object") { fail("parent path not found"); continue; }
        insertAt(container, sp[sp.length - 1], clone(srcValue), srcList(sp));
      }
    }
  }

  // Rebuild arrays: drop deleted items, place inserted ones.
  const finish = (v: Json): Json => {
    if (Array.isArray(v)) {
      const ins = (inserts.get(v) ?? []).sort((x, y) => x.at - y.at);
      const out: Json[] = [];
      let k = 0;
      v.forEach((item, i) => {
        while (k < ins.length && ins[k].at <= i) out.push(ins[k++].value);
        if (item !== DELETED) out.push(item);
      });
      while (k < ins.length) out.push(ins[k++].value);
      return out.map(finish);
    }
    if (v && typeof v === "object") for (const key of Object.keys(v)) v[key] = finish(v[key]);
    return v;
  };
  const value = finish(box.root);
  const next = JSON.stringify(value, null, detectIndent(targetText)) + (targetText.endsWith("\n") ? "\n" : "");
  return { side, edits: next === targetText ? [] : [minimalEdit(targetText, next)], errors };
}

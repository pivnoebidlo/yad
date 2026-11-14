/**
 * Apply semantic changes from one side to the other by editing the target
 * source text in place: only the affected key / list item / resource is
 * touched, the rest of the file keeps its formatting and comments.
 */
import { isCollection, isMap, isScalar, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import type { Change, PathSeg, Resource, ResourceDiff, SourceCtx } from "./types";
import { deref, getPair, getScalar, keyString, toJS } from "./util";

export type Direction = "a-to-b" | "b-to-a";

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

export interface ApplyItem {
  resource: ResourceDiff;
  /** A single change; omit to apply the whole resource. */
  change?: Change;
}

export interface ApplyResult {
  /** Side whose text the edits apply to. */
  side: "a" | "b";
  edits: Edit[];
  errors: string[];
}

// ---- text helpers -----------------------------------------------------------

const lineStart = (t: string, pos: number) => t.lastIndexOf("\n", pos - 1) + 1;
const column = (t: string, pos: number) => pos - lineStart(t, pos);
const lineEndIncl = (t: string, pos: number) => {
  const i = t.indexOf("\n", pos);
  return i < 0 ? t.length : i + 1;
};

/** Move `to` back over trailing whitespace (not before `min`). */
function trimEnd(t: string, to: number, min = 0): number {
  while (to > min && /\s/.test(t[to - 1])) to--;
  return to;
}

/** Shift indentation of every line after the first by `delta` columns. */
function reindent(s: string, delta: number): string {
  if (delta === 0) return s;
  return s
    .split("\n")
    .map((line, i) => {
      if (i === 0 || line.trim() === "") return line;
      if (delta > 0) return " ".repeat(delta) + line;
      const lead = line.length - line.trimStart().length;
      return line.slice(Math.min(lead, -delta));
    })
    .join("\n");
}

const isBlock = (n: Node | null) => isCollection(n) && !n.flow;

// ---- node location ------------------------------------------------------------

interface Loc {
  node: Node | null;
  pair?: Pair;
  parent?: YAMLMap | YAMLSeq;
  index?: number;
}

function resolve(root: Node, path: PathSeg[], ctx: SourceCtx): Loc | null {
  let loc: Loc = { node: root };
  for (const seg of path) {
    const n = loc.node;
    if (typeof seg === "string" && isMap(n)) {
      const items = n.items as Pair[];
      const i = items.findIndex((p) => keyString(p) === seg);
      if (i < 0) return null;
      loc = { node: deref(items[i].value, ctx), pair: items[i], parent: n, index: i };
    } else if (typeof seg !== "string" && isSeq(n)) {
      const i = typeof seg === "number"
        ? seg
        : n.items.findIndex((it) => {
            const m = deref(it, ctx);
            return isMap(m) && getScalar(m, seg.key, ctx) === seg.value;
          });
      if (i < 0 || i >= n.items.length) return null;
      loc = { node: deref(n.items[i], ctx), parent: n, index: i };
    } else return null;
  }
  return loc;
}

/** Start of a collection item: key start for maps, the `-` for block sequences. */
function itemStart(parent: YAMLMap | YAMLSeq, i: number, ctx: SourceCtx): number {
  if (isMap(parent)) return ((parent.items[i] as Pair).key as Node).range![0];
  const start = (parent.items[i] as Node).range![0];
  if (parent.flow) return start;
  let p = start - 1;
  while (p >= 0 && ctx.text[p] === " ") p--;
  return ctx.text[p] === "-" ? p : start;
}

/** End of a collection item (trailing whitespace excluded). */
function itemEnd(parent: YAMLMap | YAMLSeq, i: number, ctx: SourceCtx): number {
  if (isMap(parent)) {
    const pair = parent.items[i] as Pair;
    const end = Math.max((pair.key as Node).range![1], (pair.value as Node | null)?.range?.[1] ?? 0);
    return trimEnd(ctx.text, end, (pair.key as Node).range![0]);
  }
  const n = parent.items[i] as Node;
  return trimEnd(ctx.text, n.range![1], n.range![0]);
}

const nodeSpan = (n: Node, ctx: SourceCtx) => ({ from: n.range![0], to: trimEnd(ctx.text, n.range![1], n.range![0]) });

/** Column the item "belongs" to: key column for map values, own column otherwise. */
function ownerColumn(loc: Loc, ctx: SourceCtx): number {
  if (loc.pair) return column(ctx.text, (loc.pair.key as Node).range![0]);
  if (loc.parent && loc.index !== undefined) return column(ctx.text, itemStart(loc.parent, loc.index, ctx));
  return loc.node?.range ? column(ctx.text, loc.node.range[0]) : 0;
}

/** Offset just after the `:` of a pair. */
function afterColon(pair: Pair, ctx: SourceCtx): number {
  const i = ctx.text.indexOf(":", (pair.key as Node).range![1]);
  return i < 0 ? (pair.key as Node).range![1] : i + 1;
}

// ---- operations ---------------------------------------------------------------

/** Replace the value at `dst` with the value at `src`. */
function replace(src: Loc, s: SourceCtx, dst: Loc, d: SourceCtx): Edit {
  const delta = ownerColumn(dst, d) - ownerColumn(src, s);
  const sNode = src.node;
  const sText = sNode?.range ? s.text.slice(nodeSpan(sNode, s).from, nodeSpan(sNode, s).to) : "null";
  const text = reindent(sText, delta);

  if (dst.pair) {
    const from = afterColon(dst.pair, d);
    const dNode = dst.node;
    const to = dNode?.range ? nodeSpan(dNode, d).to : from;
    if (isBlock(sNode)) {
      const col = column(s.text, sNode!.range![0]) + delta;
      return { from, to, insert: "\n" + " ".repeat(col) + text };
    }
    return { from, to, insert: " " + text };
  }
  const span = dst.node?.range ? nodeSpan(dst.node, d) : { from: 0, to: 0 };
  return { from: span.from, to: span.to, insert: text };
}

/** Rewrite a flow collection as JSON (valid YAML flow) with a modified JS value. */
function rewriteFlow(parent: YAMLMap | YAMLSeq, d: SourceCtx, mutate: (v: any) => void): Edit {
  const v = toJS(parent, d) as any;
  mutate(v);
  const span = nodeSpan(parent, d);
  return { ...span, insert: JSON.stringify(v).replace(/,/g, ", ").replace(/":/g, "\": ") };
}

/** Delete the item at `dst` from its parent collection. */
function remove(dst: Loc, d: SourceCtx, seg: PathSeg): Edit {
  const parent = dst.parent!;
  const i = dst.index!;
  if (parent.flow) {
    return rewriteFlow(parent, d, (v) => (Array.isArray(v) ? v.splice(i, 1) : delete v[seg as string]));
  }
  const n = parent.items.length;
  if (n === 1) return { from: itemStart(parent, i, d), to: itemEnd(parent, i, d), insert: isMap(parent) ? "{}" : "[]" };
  // Items on their own lines are deleted as whole lines (no leftover indentation).
  const ownLine = (pos: number) => d.text.slice(lineStart(d.text, pos), pos).trim() === "";
  const from = itemStart(parent, i, d);
  if (i < n - 1) {
    const next = itemStart(parent, i + 1, d);
    if (ownLine(from) && ownLine(next)) return { from: lineStart(d.text, from), to: lineStart(d.text, next), insert: "" };
    return { from, to: next, insert: "" };
  }
  if (ownLine(from)) return { from: lineStart(d.text, from), to: lineEndIncl(d.text, itemEnd(parent, i, d)), insert: "" };
  return { from: itemEnd(parent, i - 1, d), to: itemEnd(parent, i, d), insert: "" };
}

/** Insert the item at `src` into the matching parent collection on the target side. */
function insert(src: Loc, s: SourceCtx, dLoc: Loc, d: SourceCtx, seg: PathSeg): Edit | string {
  const sParent = src.parent!;
  const si = src.index!;
  if (!isCollection(dLoc.node)) return "parent is not a map or list on the target side";
  const dParent = dLoc.node as YAMLMap | YAMLSeq;

  // Empty `{}` / `[]` under a key, source is block style: write a block.
  if (dParent.items.length === 0 && dLoc.pair && !sParent.flow) {
    const keyCol = column(d.text, (dLoc.pair.key as Node).range![0]);
    const sFrom = itemStart(sParent, si, s);
    const col = keyCol + 2;
    const text = reindent(s.text.slice(sFrom, itemEnd(sParent, si, s)), col - column(s.text, sFrom));
    return { from: afterColon(dLoc.pair, d), to: nodeSpan(dParent, d).to, insert: "\n" + " ".repeat(col) + text };
  }

  if (dParent.flow || dParent.items.length === 0) {
    const value = toJS(src.node, s);
    return rewriteFlow(dParent, d, (v) => {
      if (Array.isArray(v)) v.splice(typeof seg === "number" ? Math.min(seg, v.length) : v.length, 0, value);
      else v[seg as string] = value;
    });
  }

  // Where to put it: after the nearest preceding sibling that exists on the
  // target side, else before the nearest following one, else at the end.
  const idOf = (parent: YAMLMap | YAMLSeq, i: number, ctx: SourceCtx): string | undefined => {
    if (isMap(parent)) return keyString(parent.items[i] as Pair);
    if (typeof seg === "object") {
      const m = deref(parent.items[i], ctx);
      return isMap(m) ? getScalar(m, seg.key, ctx) : undefined;
    }
    return undefined;
  };
  const dIndex = new Map<string, number>();
  dParent.items.forEach((_, i) => {
    const id = idOf(dParent, i, d);
    if (id !== undefined) dIndex.set(id, i);
  });

  let after: number | undefined, before: number | undefined;
  if (typeof seg === "number") {
    if (seg < dParent.items.length) before = seg;
    else after = dParent.items.length - 1;
  } else {
    for (let k = si - 1; k >= 0 && after === undefined; k--) after = dIndex.get(idOf(sParent, k, s) ?? "\0");
    for (let k = si + 1; k < sParent.items.length && after === undefined && before === undefined; k++)
      before = dIndex.get(idOf(sParent, k, s) ?? "\0");
    if (after === undefined && before === undefined) after = dParent.items.length - 1;
  }

  const dCol = column(d.text, itemStart(dParent, 0, d));
  const sFrom = itemStart(sParent, si, s);
  const text = reindent(s.text.slice(sFrom, itemEnd(sParent, si, s)), dCol - column(s.text, sFrom));
  const indent = " ".repeat(dCol);
  if (after !== undefined) {
    const at = itemEnd(dParent, after, d);
    return { from: at, to: at, insert: "\n" + indent + text };
  }
  const at = itemStart(dParent, before!, d);
  return { from: at, to: at, insert: text + "\n" + indent };
}

// ---- resources ------------------------------------------------------------------

function resourceText(r: Resource): string {
  const { from, to } = nodeSpan(r.node, r.ctx);
  return reindent(r.ctx.text.slice(from, to), -column(r.ctx.text, from));
}

function removeResource(r: Resource): Edit | string {
  const { doc, text } = r.ctx;
  const root = deref(doc.contents, r.ctx);
  if (root !== r.node) {
    // An item of a `kind: List`.
    const items = isMap(root) ? deref(getPair(root, "items")?.value, r.ctx) : null;
    const i = isSeq(items) ? items.items.findIndex((n) => deref(n, r.ctx) === r.node) : -1;
    if (i < 0) return "cannot locate the resource in its file";
    return remove({ node: r.node, parent: items as YAMLSeq, index: i }, r.ctx, i);
  }
  const start = lineStart(text, r.node.range![0]);
  const end = trimEnd(text, r.node.range![1], start);
  const isSep = (l: string) => /^---\s*$/.test(l);
  const skip = (l: string) => l.trim() === "" || l.trimStart().startsWith("#");

  // Prefer removing the separator above, together with comments in between.
  let p = start;
  while (p > 0) {
    const ls = lineStart(text, p - 1);
    const line = text.slice(ls, p).replace(/\n$/, "");
    if (isSep(line)) return { from: ls > 0 ? ls - 1 : 0, to: end, insert: "" };
    if (!skip(line)) break;
    p = ls;
  }
  // Otherwise the one below.
  let q = lineEndIncl(text, end);
  while (q < text.length) {
    const le = lineEndIncl(text, q);
    const line = text.slice(q, le).replace(/\n$/, "");
    if (isSep(line)) return { from: start, to: le, insert: "" };
    if (!skip(line)) break;
    q = le;
  }
  return { from: start, to: lineEndIncl(text, end), insert: "" };
}

// ---- public API -----------------------------------------------------------------

function changeEdit(r: ResourceDiff, c: Change, dir: Direction): Edit | string | null {
  const [sr, dr] = dir === "a-to-b" ? [r.a, r.b] : [r.b, r.a];
  if (!sr || !dr) return "resource is missing on one side";
  const srcHas = dir === "a-to-b" ? c.kind !== "added" : c.kind !== "removed";
  const dstHas = dir === "a-to-b" ? c.kind !== "removed" : c.kind !== "added";
  const seg = c.path[c.path.length - 1];
  const src = srcHas ? resolve(sr.node, c.path, sr.ctx) : null;
  const dst = dstHas ? resolve(dr.node, c.path, dr.ctx) : null;
  if ((srcHas && !src) || (dstHas && !dst)) return "path not found";
  if (src && dst) return replace(src, sr.ctx, dst, dr.ctx);
  if (dst) return dst.parent ? remove(dst, dr.ctx, seg) : "cannot remove the root";
  if (src) {
    const parent = resolve(dr.node, c.path.slice(0, -1), dr.ctx);
    if (!parent) return "parent path not found on the target side";
    return insert(src, sr.ctx, parent, dr.ctx, seg);
  }
  return null;
}

/**
 * Compute edits that make the target side match the source side for the given
 * changes/resources. `dir` "a-to-b" copies left → right (edits apply to `b`).
 */
export function planApply(items: ApplyItem[], dir: Direction, targetText: string): ApplyResult {
  const side = dir === "a-to-b" ? "b" : "a";
  const edits: Edit[] = [];
  const errors: string[] = [];
  const appended: string[] = [];
  const push = (e: Edit | string | null, what: string) => {
    if (typeof e === "string") errors.push(`${what}: ${e}`);
    else if (e) edits.push(e);
  };

  for (const { resource: r, change } of items) {
    const [sr, dr] = dir === "a-to-b" ? [r.a, r.b] : [r.b, r.a];
    if (change) push(changeEdit(r, change, dir), r.label);
    else if (sr && dr) for (const c of r.changes) push(changeEdit(r, c, dir), r.label);
    else if (sr) appended.push(resourceText(sr));
    else if (dr) push(removeResource(dr), r.label);
  }

  // Sort and merge: adjacent deletions may overlap (e.g. two last list items).
  edits.sort((x, y) => x.from - y.from || x.to - y.to);
  const merged: Edit[] = [];
  for (const e of edits) {
    const last = merged[merged.length - 1];
    if (last && e.from === last.from && e.to === last.to && e.to > e.from && e.insert.startsWith("\n")) {
      last.insert += e.insert; // several items into the same empty collection
      continue;
    }
    if (last && e.from < last.to) {
      if (!last.insert && !e.insert) last.to = Math.max(last.to, e.to);
      else errors.push("overlapping edits skipped");
      continue;
    }
    merged.push({ ...e });
  }
  // Resources new to the target go to the end of the file, in one edit.
  if (appended.length) {
    const end = trimEnd(targetText, targetText.length);
    const body = appended.join("\n---\n") + "\n";
    const tail = { from: end, to: targetText.length, insert: end === 0 ? body : "\n---\n" + body };
    if (merged.length && merged[merged.length - 1].to > tail.from) errors.push("cannot append resources: conflicting edit at end of file");
    else merged.push(tail);
  }
  return { side, edits: merged, errors };
}

/** Apply edits (positions refer to the original text) and return the new text. */
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  // Back to front; inserts at the same position keep their array order.
  const order = edits.map((e, i) => ({ e, i })).sort((x, y) => y.e.from - x.e.from || y.e.to - x.e.to || y.i - x.i);
  for (const { e } of order) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

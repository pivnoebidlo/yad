/**
 * "Align order": make one file list the same sections in the same order as
 * the other file, without changing what it means. Whole text chunks (an item
 * with its comments, blank lines and formatting) are moved:
 *  - documents of a multi-document file, by resource identity;
 *  - keys of block maps;
 *  - items of keyed lists (containers, env… in Kubernetes).
 * Lists whose order matters (pipeline steps, args, …) are never touched.
 * The result is verified like formatting: same content, same comments.
 */
import { Lexer, isMap, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import { compareTexts } from "./index";
import { optionsForKind } from "./kinds";
import { defaultOptions } from "./config";
import type { CompareOptions, PathSeg, SourceCtx } from "./types";
import { deref, fieldName, getScalar, keyString, pickMergeKey } from "./util";

export type AlignResult = { text: string; moved: number; error?: undefined } | { text?: undefined; moved?: undefined; error: string };

const lineStart = (t: string, pos: number) => t.lastIndexOf("\n", pos - 1) + 1;
const lineEndIncl = (t: string, pos: number) => {
  const i = t.indexOf("\n", pos);
  return i < 0 ? t.length : i + 1;
};
const trimEnd = (t: string, to: number, min: number) => {
  while (to > min && /\s/.test(t[to - 1])) to--;
  return to;
};

function itemStart(parent: YAMLMap | YAMLSeq, i: number, text: string): number {
  if (isMap(parent)) return ((parent.items[i] as Pair).key as Node).range![0];
  const start = (parent.items[i] as Node).range![0];
  let p = start - 1;
  while (p >= 0 && text[p] === " ") p--;
  return text[p] === "-" ? p : start;
}

function itemEnd(parent: YAMLMap | YAMLSeq, i: number, text: string): number {
  if (isMap(parent)) {
    const pair = parent.items[i] as Pair;
    const k = (pair.key as Node).range!;
    const v = (pair.value as Node | null)?.range;
    return trimEnd(text, Math.max(k[1], v?.[1] ?? 0), k[0]);
  }
  const r = (parent.items[i] as Node).range!;
  return trimEnd(text, r[1], r[0]);
}

/**
 * Text of a block collection with its items in `order` (indexes of the current
 * items). Each item travels with the comments and blank lines above it.
 */
function reorderBlock(text: string, parent: YAMLMap | YAMLSeq, order: number[]): { from: number; to: number; insert: string } | null {
  const n = parent.items.length;
  if (n < 2 || parent.flow) return null;
  const start = Array.from({ length: n }, (_, i) => itemStart(parent, i, text));
  const end = Array.from({ length: n }, (_, i) => lineEndIncl(text, itemEnd(parent, i, text)));
  for (let i = 1; i < n; i++) {
    // Every item after the first must begin its own line, and items must not overlap.
    if (text.slice(lineStart(text, start[i]), start[i]).trim() !== "" || end[i - 1] > start[i]) return null;
  }
  const indent = text.slice(lineStart(text, start[1]), start[1]);
  const lead = (i: number) => (i === 0 ? "" : text.slice(end[i - 1], start[i]));
  const body = (i: number) => {
    const b = text.slice(start[i], end[i]);
    return b.endsWith("\n") ? b : b + "\n";
  };
  let out = "";
  order.forEach((item, p) => {
    if (p === 0) {
      // Already positioned after the first item's indentation (or "- ").
      const l = lead(item).replace(/^(?:[ \t]*\n)+/, "");
      out += (l.trim() ? l.replace(/^[ \t]+/, "") : "") + body(item);
    } else out += (item === 0 ? indent : lead(item)) + body(item);
  });
  const regionEnd = end[n - 1];
  if (!text.slice(start[0], regionEnd).endsWith("\n")) out = out.replace(/\n$/, "");
  return { from: start[0], to: regionEnd, insert: out };
}

/** New order for target items: those found in the source follow the source; others stay after their predecessor. */
function desiredOrder(targetIds: Array<string | undefined>, sourceIds: string[]): number[] | null {
  const rankOf = new Map(sourceIds.map((id, i) => [id, i]));
  let last = -1;
  const ranked = targetIds.map((id, i) => {
    const r = id !== undefined ? rankOf.get(id) : undefined;
    if (r !== undefined) last = r;
    return { i, r: r ?? last + 0.5, tie: i };
  });
  const order = [...ranked].sort((x, y) => x.r - y.r || x.tie - y.tie).map((x) => x.i);
  return order.every((v, i) => v === i) ? null : order;
}

type Edit = { from: number; to: number; insert: string };

/** First collection (outermost first) whose order differs from the source. */
function findReorder(an: unknown, bn: unknown, sa: SourceCtx, sb: SourceCtx, path: PathSeg[], opts: CompareOptions): Edit | null {
  const a = deref(an, sa), b = deref(bn, sb);
  if (isMap(a) && isMap(b)) {
    const aKeys = (a.items as Pair[]).map(keyString);
    const bKeys = (b.items as Pair[]).map(keyString);
    const order = desiredOrder(bKeys, aKeys);
    if (order) {
      const e = reorderBlock(sb.text, b, order);
      if (e) return e;
    }
    for (const bp of b.items as Pair[]) {
      const k = keyString(bp);
      const ap = (a.items as Pair[]).find((p) => keyString(p) === k);
      if (!ap) continue;
      const e = findReorder(ap.value, bp.value, sa, sb, [...path, k], opts);
      if (e) return e;
    }
    return null;
  }
  if (isSeq(a) && isSeq(b)) {
    const mk = pickMergeKey(fieldName(path), [{ items: a.items, ctx: sa }, { items: b.items, ctx: sb }], opts);
    if (mk) {
      const id = (n: unknown, ctx: SourceCtx) => getScalar(deref(n, ctx) as YAMLMap, mk, ctx);
      const order = desiredOrder(b.items.map((n) => id(n, sb)), a.items.map((n) => id(n, sa)!));
      if (order) {
        const e = reorderBlock(sb.text, b, order);
        if (e) return e;
      }
      for (const bi of b.items) {
        const ai = a.items.find((x) => id(x, sa) === id(bi, sb));
        if (ai === undefined) continue;
        const e = findReorder(ai, bi, sa, sb, [...path, { key: mk, value: id(bi, sb)! }], opts);
        if (e) return e;
      }
      return null;
    }
    // Order matters here: never reorder, only look inside items at the same position.
    if (a.items.length !== b.items.length) return null;
    for (let i = 0; i < b.items.length; i++) {
      const e = findReorder(a.items[i], b.items[i], sa, sb, [...path, i], opts);
      if (e) return e;
    }
  }
  return null;
}

const apply = (t: string, e: Edit) => t.slice(0, e.from) + e.insert + t.slice(e.to);

/** Reorder the documents of `target` like the matching resources in `source`. */
function alignDocuments(target: string, source: string, opts: Partial<CompareOptions>): string {
  const lines = target.split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^---(\s|$)/.test(line)) {
      chunks.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  chunks.push(cur.join("\n"));
  const docs = chunks.map((c, i) => ({ text: c, i })).filter((d) => d.text.trim() !== "");
  if (docs.length < 2) return target;

  const res = compareTexts(source, target, opts);
  const srcOrder = res.resources.filter((r) => r.a).map((r) => r.a!).sort((x, y) => x.range.from - y.range.from).map((r) => r.key);
  // Which source resource each target document corresponds to.
  const idOfChunk = docs.map((d) => {
    const first = compareTexts(d.text, "", opts).resources[0]?.a;
    return first && res.resources.find((r) => r.b?.key === first.key)?.a?.key;
  });
  const order = desiredOrder(idOfChunk, srcOrder);
  if (!order) return target;
  const body = order.map((k) => docs[k].text.replace(/^\n+/, "").replace(/\n+$/, "")).join("\n---\n");
  const startsWithSep = /^---(\s|$)/.test(target);
  return (startsWithSep ? "---\n" : "") + body + (target.endsWith("\n") ? "\n" : "");
}

function comments(text: string): string[] {
  const out: string[] = [];
  for (const tok of new Lexer().lex(text)) if (tok.startsWith("#")) out.push(tok.trim());
  return out.sort();
}

/** Reorder `target` to follow `source` (documents, map keys, keyed list items). */
export function alignOrder(target: string, source: string, options: Partial<CompareOptions> = {}): AlignResult {
  const opts = { ...options, ignore: [], emptyEqualsMissing: false };
  let text = alignDocuments(target, source, options);
  let moved = text === target ? 0 : 1;
  for (let guard = 0; guard < 2000; guard++) {
    const res = compareTexts(source, text, options);
    if (res.errors.a.length || res.errors.b.length) return { error: (res.errors.b[0] ?? res.errors.a[0]).message.split("\n")[0] };
    let edit: Edit | null = null;
    for (const r of res.resources) {
      if (!r.a || !r.b) continue;
      const ko = optionsForKind(r.a.docKind === r.b.docKind ? r.a.docKind : "yaml", { ...defaultOptions(), ...options });
      edit = findReorder(r.a.node, r.b.node, r.a.ctx, r.b.ctx, [], ko);
      if (edit) break;
    }
    if (!edit) break;
    text = apply(text, edit);
    moved++;
  }

  // Safety: nothing but order may change.
  const check = compareTexts(target, text, opts);
  if (check.errors.b.length || check.resources.some((r) => r.status !== "equal"))
    return { error: "reordering would change the content; nothing was changed" };
  if (comments(target).join("\n") !== comments(text).join("\n")) return { error: "reordering would lose a comment; nothing was changed" };
  return { text, moved };
}

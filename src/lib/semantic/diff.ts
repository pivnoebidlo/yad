import { isMap, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import type { Change, CompareOptions, PathSeg, SourceCtx } from "./types";
import {
  canonicalString, deref, fieldName, getScalar, isEmptyAfterIgnore, isIgnored, keyString,
  nodeRange, pairRange, pickMergeKey, toJS,
} from "./util";

/** Structural, order-insensitive diff of two YAML node trees. */
export function diffNodes(
  a: Node, b: Node, sa: SourceCtx, sb: SourceCtx, opts: CompareOptions, ignore: string[][],
): Change[] {
  const changes: Change[] = [];
  const js = (n: Node | null, ctx: SourceCtx) => toJS(n, ctx);
  /** A key present on one side only that should not count as a change. */
  const skipOneSided = (value: unknown, ctx: SourceCtx, p: PathSeg[]) =>
    isIgnored(p, ignore) || (opts.emptyEqualsMissing && isEmptyAfterIgnore(value, ctx, p, ignore));

  function compare(an0: unknown, bn0: unknown, path: PathSeg[]) {
    if (isIgnored(path, ignore)) return;
    const an = deref(an0, sa);
    const bn = deref(bn0, sb);
    if (isMap(an) && isMap(bn)) return maps(an, bn, path);
    if (isSeq(an) && isSeq(bn)) return seqs(an, bn, path);
    const av = js(an, sa);
    const bv = js(bn, sb);
    if (canonicalString(av) !== canonicalString(bv))
      changes.push({ path, kind: "changed", a: av, b: bv, aRange: nodeRange(an, sa), bRange: nodeRange(bn, sb) });
  }

  function maps(am: YAMLMap, bm: YAMLMap, path: PathSeg[]) {
    const bPairs = new Map((bm.items as Pair[]).map((p) => [keyString(p), p]));
    for (const ap of am.items as Pair[]) {
      const k = keyString(ap);
      const bp = bPairs.get(k);
      const p = [...path, k];
      if (bp) {
        bPairs.delete(k);
        compare(ap.value, bp.value, p);
      } else if (!skipOneSided(ap.value, sa, p)) {
        changes.push({ path: p, kind: "removed", a: js(deref(ap.value, sa), sa), aRange: pairRange(ap, sa) });
      }
    }
    for (const [k, bp] of bPairs) {
      const p = [...path, k];
      if (!skipOneSided(bp.value, sb, p))
        changes.push({ path: p, kind: "added", b: js(deref(bp.value, sb), sb), bRange: pairRange(bp, sb) });
    }
  }

  const removed = (n: unknown, path: PathSeg[]) => {
    const node = deref(n, sa);
    changes.push({ path, kind: "removed", a: js(node, sa), aRange: nodeRange(node, sa) });
  };
  const added = (n: unknown, path: PathSeg[]) => {
    const node = deref(n, sb);
    changes.push({ path, kind: "added", b: js(node, sb), bRange: nodeRange(node, sb) });
  };

  function seqs(as: YAMLSeq, bs: YAMLSeq, path: PathSeg[]) {
    const mk = pickMergeKey(fieldName(path), [{ items: as.items, ctx: sa }, { items: bs.items, ctx: sb }], opts);
    if (mk) return keyedSeqs(as, bs, mk, path);

    // Unkeyed list: order matters. Align equal items with LCS, then compare
    // the gaps between them position by position.
    const ak = as.items.map((n) => canonicalString(js(deref(n, sa), sa)));
    const bk = bs.items.map((n) => canonicalString(js(deref(n, sb), sb)));
    const m = ak.length, n = bk.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = ak[i] === bk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

    let i = 0, j = 0;
    const gapA: number[] = [], gapB: number[] = [];
    const flush = () => {
      const common = Math.min(gapA.length, gapB.length);
      for (let k = 0; k < common; k++) compare(as.items[gapA[k]], bs.items[gapB[k]], [...path, gapB[k]]);
      for (let k = common; k < gapA.length; k++) removed(as.items[gapA[k]], [...path, gapA[k]]);
      for (let k = common; k < gapB.length; k++) added(bs.items[gapB[k]], [...path, gapB[k]]);
      gapA.length = gapB.length = 0;
    };
    while (i < m || j < n) {
      if (i < m && j < n && ak[i] === bk[j]) { flush(); i++; j++; }
      else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) gapA.push(i++);
      else gapB.push(j++);
    }
    flush();
  }

  function keyedSeqs(as: YAMLSeq, bs: YAMLSeq, mk: string, path: PathSeg[]) {
    const keyOf = (n: unknown, ctx: SourceCtx) => getScalar(deref(n, ctx) as YAMLMap, mk, ctx)!;
    const bItems = new Map(bs.items.map((n) => [keyOf(n, sb), n]));
    for (const an of as.items) {
      const k = keyOf(an, sa);
      const seg = { key: mk, value: k };
      const bn = bItems.get(k);
      if (bn !== undefined) {
        bItems.delete(k);
        compare(an, bn, [...path, seg]);
      } else removed(an, [...path, seg]);
    }
    for (const [k, bn] of bItems) added(bn, [...path, { key: mk, value: k }]);
  }

  compare(a, b, []);
  return changes;
}

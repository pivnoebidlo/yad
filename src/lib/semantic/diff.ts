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

  // Paths are tracked for both sides: inside unkeyed lists the same item can
  // sit at different indexes on the left and on the right.
  const same = (x: PathSeg[], y: PathSeg[]) => x.length === y.length && x.every((s, i) => s === y[i]);
  function push(c: Change, ap: PathSeg[], bp: PathSeg[]) {
    if (!same(ap, c.path)) c.aPath = ap;
    if (!same(bp, c.path)) c.bPath = bp;
    changes.push(c);
  }

  function compare(an0: unknown, bn0: unknown, ap: PathSeg[], bp: PathSeg[]) {
    if (isIgnored(bp, ignore)) return;
    const an = deref(an0, sa);
    const bn = deref(bn0, sb);
    if (isMap(an) && isMap(bn)) return maps(an, bn, ap, bp);
    if (isSeq(an) && isSeq(bn)) return seqs(an, bn, ap, bp);
    const av = js(an, sa);
    const bv = js(bn, sb);
    if (canonicalString(av) !== canonicalString(bv))
      push({ path: bp, kind: "changed", a: av, b: bv, aRange: nodeRange(an, sa), bRange: nodeRange(bn, sb) }, ap, bp);
  }

  function maps(am: YAMLMap, bm: YAMLMap, ap: PathSeg[], bp: PathSeg[]) {
    const bPairs = new Map((bm.items as Pair[]).map((p) => [keyString(p), p]));
    for (const apair of am.items as Pair[]) {
      const k = keyString(apair);
      const bpair = bPairs.get(k);
      if (bpair) {
        bPairs.delete(k);
        compare(apair.value, bpair.value, [...ap, k], [...bp, k]);
      } else if (!skipOneSided(apair.value, sa, [...ap, k])) {
        push({ path: [...ap, k], kind: "removed", a: js(deref(apair.value, sa), sa), aRange: pairRange(apair, sa) }, [...ap, k], [...bp, k]);
      }
    }
    for (const [k, bpair] of bPairs) {
      if (!skipOneSided(bpair.value, sb, [...bp, k]))
        push({ path: [...bp, k], kind: "added", b: js(deref(bpair.value, sb), sb), bRange: pairRange(bpair, sb) }, [...ap, k], [...bp, k]);
    }
  }

  const removed = (n: unknown, ap: PathSeg[], bp: PathSeg[]) => {
    const node = deref(n, sa);
    push({ path: ap, kind: "removed", a: js(node, sa), aRange: nodeRange(node, sa) }, ap, bp);
  };
  const added = (n: unknown, ap: PathSeg[], bp: PathSeg[]) => {
    const node = deref(n, sb);
    push({ path: bp, kind: "added", b: js(node, sb), bRange: nodeRange(node, sb) }, ap, bp);
  };

  function seqs(as: YAMLSeq, bs: YAMLSeq, ap: PathSeg[], bp: PathSeg[]) {
    const mk = pickMergeKey(fieldName(bp), [{ items: as.items, ctx: sa }, { items: bs.items, ctx: sb }], opts);
    if (mk) return keyedSeqs(as, bs, mk, ap, bp);

    // Unkeyed list: order matters. Align equal items with LCS, then compare
    // the gaps between them position by position.
    const ak = as.items.map((n) => canonicalString(js(deref(n, sa), sa)));
    const bk = bs.items.map((n) => canonicalString(js(deref(n, sb), sb)));
    const m = ak.length, n = bk.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = ak[i] === bk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

    // Items outside the LCS that are identical on both sides are moves, not
    // a removal plus an addition.
    const inLcs = { a: new Set<number>(), b: new Set<number>() };
    for (let x = 0, y = 0; x < m && y < n; ) {
      if (ak[x] === bk[y]) { inLcs.a.add(x++); inLcs.b.add(y++); }
      else if (dp[x + 1][y] >= dp[x][y + 1]) x++;
      else y++;
    }
    const freeA = new Map<string, number[]>();
    for (let x = 0; x < m; x++) if (!inLcs.a.has(x)) (freeA.get(ak[x]) ?? freeA.set(ak[x], []).get(ak[x])!).push(x);
    const movedA = new Set<number>(), movedB = new Set<number>();
    for (let y = 0; y < n; y++) {
      if (inLcs.b.has(y)) continue;
      const x = freeA.get(bk[y])?.shift();
      if (x === undefined) continue;
      movedA.add(x);
      movedB.add(y);
      const an = deref(as.items[x], sa), bn = deref(bs.items[y], sb);
      push(
        { path: [...bp, y], kind: "moved", a: js(an, sa), b: js(bn, sb), aRange: nodeRange(an, sa), bRange: nodeRange(bn, sb), fromIndex: x },
        [...ap, x], [...bp, y],
      );
    }

    let i = 0, j = 0;
    const gapA: number[] = [], gapB: number[] = [];
    const flush = () => {
      const common = Math.min(gapA.length, gapB.length);
      for (let k = 0; k < common; k++) compare(as.items[gapA[k]], bs.items[gapB[k]], [...ap, gapA[k]], [...bp, gapB[k]]);
      for (let k = common; k < gapA.length; k++) removed(as.items[gapA[k]], [...ap, gapA[k]], [...bp, gapA[k]]);
      for (let k = common; k < gapB.length; k++) added(bs.items[gapB[k]], [...ap, gapB[k]], [...bp, gapB[k]]);
      gapA.length = gapB.length = 0;
    };
    while (i < m || j < n) {
      if (i < m && j < n && ak[i] === bk[j]) { flush(); i++; j++; }
      else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) { if (!movedA.has(i)) gapA.push(i); i++; }
      else { if (!movedB.has(j)) gapB.push(j); j++; }
    }
    flush();
  }

  function keyedSeqs(as: YAMLSeq, bs: YAMLSeq, mk: string, ap: PathSeg[], bp: PathSeg[]) {
    const keyOf = (n: unknown, ctx: SourceCtx) => getScalar(deref(n, ctx) as YAMLMap, mk, ctx)!;
    const bItems = new Map(bs.items.map((n) => [keyOf(n, sb), n]));
    for (const an of as.items) {
      const k = keyOf(an, sa);
      const seg = { key: mk, value: k };
      const bn = bItems.get(k);
      if (bn !== undefined) {
        bItems.delete(k);
        compare(an, bn, [...ap, seg], [...bp, seg]);
      } else removed(an, [...ap, seg], [...bp, seg]);
    }
    for (const [k, bn] of bItems) added(bn, [...ap, { key: mk, value: k }], [...bp, { key: mk, value: k }]);
  }

  compare(a, b, [], []);
  return changes;
}

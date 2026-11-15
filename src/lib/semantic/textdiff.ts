/** Line diff of two multi-line strings (embedded configs, scripts, patches). */

export interface LineChange {
  op: "-" | "+";
  /** 1-based line in the old text (for "-") or the new text (for "+"). */
  line: number;
  text: string;
}

export const isMultiline = (v: unknown): v is string => typeof v === "string" && v.includes("\n");

/** Changed lines only (LCS); inputs of thousands of lines are fine for a report. */
export function lineDiff(a: string, b: string): LineChange[] {
  const x = a.replace(/\n$/, "").split("\n"), y = b.replace(/\n$/, "").split("\n");
  // Trim the common head and tail first: embedded configs usually change in a few places.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail);
  const n = xs.length, m = ys.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: LineChange[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] > L[i + 1][j])) out.push({ op: "+", line: head + ++j, text: ys[j - 1] });
    else out.push({ op: "-", line: head + ++i, text: xs[i - 1] });
  }
  return out;
}

/** "line 4: timeout: 30s → timeout: 60s (+2 more)" — for one-line summaries. */
export function summarizeTextChange(a: string, b: string, short: (s: string) => string = (s) => s): string {
  const d = lineDiff(a, b);
  if (!d.length) return "";
  const first = d[0];
  const pair = d.find((c) => c.op !== first.op);
  let text: string;
  let used = 1;
  if (first.op === "-" && pair && pair === d[1]) {
    text = `line ${first.line}: ${short(first.text.trim())} → ${short(pair.text.trim())}`;
    used = 2;
  } else text = `line ${first.line}: ${first.op === "-" ? "removed" : "added"} ${short(first.text.trim())}`;
  return d.length > used ? `${text} (+${d.length - used} more)` : text;
}
